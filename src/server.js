import http from "node:http";
import { config } from "./config.js";
import { decideTask, extractFields, parseTaskBody } from "./decide.js";
import { signResponseBody, verifySignature } from "./hmac.js";
import { generateProof, submitViaKurier } from "./proof.js";
import { ResponseCache, SeenStore } from "./seenStore.js";

const seen = new SeenStore(config.seenFile);
const cache = new ResponseCache(config.responseCacheFile);

const TASK_PATHS = new Set(["/", "/agent", "/task", "/decide", "/api/task", "/api/agent"]);
const HEALTH_PATHS = new Set(["/health", "/healthz", "/ready", "/live"]);

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function isPreflight(parsed) {
  const mode = String(parsed.mode || "").toLowerCase();
  const raw = parsed.raw || {};
  const type = String(raw.type || raw.event || "").toLowerCase();
  return (
    mode.includes("preflight") ||
    mode.includes("health") ||
    type.includes("preflight") ||
    type.includes("healthcheck") ||
    raw.ping === true ||
    raw.healthcheck === true
  );
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > config.maxBodyBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj, { sign = false } = {}) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const headers = {
    "content-type": "application/json",
    "content-length": body.length,
  };
  if (sign && config.hmacSecret) {
    headers["x-agent-games-signature"] = signResponseBody(config.hmacSecret, body);
  }
  res.writeHead(status, headers);
  res.end(body);
}

async function handleTask(req, res, rawBody) {
  const startedAt = Date.now();

  // 1. Verify HMAC BEFORE parsing. Fail closed on bad signatures.
  const signature = req.headers["x-agent-games-signature"];
  if (config.hmacSecret) {
    if (!verifySignature(config.hmacSecret, rawBody, signature)) {
      log("[auth] rejected: invalid/missing x-agent-games-signature");
      return sendJson(res, 401, { error: "invalid signature" });
    }
  } else if (!config.allowUnverified) {
    log("[auth] misconfigured: AGENT_GAMES_HMAC_SECRET is not set and ALLOW_UNVERIFIED is not true");
    return sendJson(res, 500, { error: "agent misconfigured: HMAC secret missing" });
  } else {
    log("[auth] WARNING: allowing unverified request (ALLOW_UNVERIFIED=true, local testing only)");
  }

  // 2. Parse JSON. Malformed bodies cannot be decided; return 400.
  let body;
  try {
    body = rawBody.length ? JSON.parse(rawBody.toString("utf8")) : {};
  } catch {
    return sendJson(res, 400, { error: "invalid JSON" }, { sign: true });
  }

  const parsed = parseTaskBody(body);

  // 3. Preflight / health probe: answer fast with 200, no scoring logic.
  if (isPreflight(parsed)) {
    log("[preflight] ok");
    return sendJson(res, 200, { status: "ok" }, { sign: true });
  }

  const taskId = parsed.taskId;

  // 4. Idempotency: retries return the exact same response.
  if (taskId) {
    const cached = cache.get(taskId);
    if (cached) {
      log(`[task ${taskId}] idempotent replay`);
      return sendJson(res, 200, cached, { sign: true });
    }
  }

  // 5. Decide. This is pure and fast (<1ms). It never throws for bad input:
  // missing fields fail closed to REJECT inside decideTask.
  let result;
  try {
    result = decideTask(parsed.input, seen);
  } catch (err) {
    log(`[task ${taskId}] decide error (fail closed): ${err.message}`);
    result = {
      decision: "REJECT",
      reason_code: "VK_SUBSTITUTION",
      proof_tx: "",
      checks: {},
    };
  }

  // Record APPROVEs in the seen-set BEFORE responding, so a retry with a
  // different task_id but the same proof_tx is caught as PROOF_REUSED.
  if (result.decision === "APPROVE" && result.proof_tx) {
    seen.add(result.proof_tx);
  }

  // 6. Proof (best-effort, inside the total budget). A missing proof costs
  // the reliability bonus but must NEVER cause a timeout on the decision.
  const response = {
    decision: result.decision,
    reason_code: result.reason_code,
    proof_tx: result.proof_tx,
  };

  const elapsedMs = Date.now() - startedAt;
  const remainingMs = Math.max(0, config.totalBudgetMs - elapsedMs);
  let proofStatus = "skipped";
  if (remainingMs > 1000) {
    try {
      const fields = extractFields(parsed.input);
      const proofResult = await generateProof({ fields, decision: result.decision });
      if (!proofResult.skipped) {
        proofStatus = "generated";
        // Field names below are the documented snarkjs/Kurier conventions.
        // VERIFY against dashboard practice mode: if the platform expects
        // different field names, change them here and re-test in practice.
        response.proof = proofResult.proof;
        response.publicSignals = proofResult.publicSignals;
        response.vkHash = config.gatekeeperVkHash;

        const kurierElapsed = Date.now() - startedAt;
        const kurierBudget = Math.max(0, config.totalBudgetMs - kurierElapsed);
        if (kurierBudget > 2000) {
          const kurier = await submitViaKurier({
            proof: proofResult.proof,
            publicSignals: proofResult.publicSignals,
            deadlineMs: kurierBudget,
          });
          if (!kurier.skipped && kurier.proofReference) {
            proofStatus = "finalized";
            response.proofReference = kurier.proofReference;
          } else if (!kurier.skipped) {
            proofStatus = "submitted";
          } else {
            log(`[task ${taskId}] kurier skipped: ${kurier.reason}`);
          }
        }
      } else {
        proofStatus = "skipped";
        log(`[task ${taskId}] proof skipped: ${proofResult.reason}`);
      }
    } catch (err) {
      log(`[task ${taskId}] proof error (decision still returned): ${err.message}`);
    }
  }

  if (taskId) cache.set(taskId, response);

  log(
    `[task ${taskId || "(no id)"}] ${result.decision} ${result.reason_code} proof=${proofStatus} ${Date.now() - startedAt}ms`,
  );
  return sendJson(res, 200, response, { sign: true });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const path = url.pathname.replace(/\/$/, "") || "/";

    if (req.method === "GET" || req.method === "HEAD") {
      if (HEALTH_PATHS.has(path) || path === "/") {
        if (req.method === "HEAD") {
          res.writeHead(200);
          return res.end();
        }
        return sendJson(res, 200, {
          status: "ok",
          service: "proof-gatekeeper-agent",
          time: new Date().toISOString(),
          seenApprovedProofs: seen.size,
        });
      }
      return sendJson(res, 404, { error: "not found" });
    }

    if (req.method === "POST" && TASK_PATHS.has(path)) {
      const rawBody = await readRawBody(req);
      return await handleTask(req, res, rawBody);
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (err) {
    log(`[server] error: ${err.message}`);
    if (!res.headersSent) {
      // Never hang: fail closed with a REJECT-shaped body for POSTs.
      if (req.method === "POST") {
        return sendJson(res, 200, {
          decision: "REJECT",
          reason_code: "VK_SUBSTITUTION",
          proof_tx: "",
        });
      }
      return sendJson(res, 500, { error: "internal error" });
    }
  }
});

server.listen(config.port, config.host, () => {
  log(`Proof Gatekeeper agent listening on http://${config.host}:${config.port}`);
  log(`Health: GET /health | Tasks: POST /agent (also /, /task, /decide)`);
  log(`HMAC secret configured: ${config.hmacSecret ? "yes" : "NO"}`);
  if (!config.hmacSecret && config.allowUnverified) {
    log("WARNING: ALLOW_UNVERIFIED=true. Do not use in production.");
  }
  log(`Seen approved proofs loaded: ${seen.size}`);
});
