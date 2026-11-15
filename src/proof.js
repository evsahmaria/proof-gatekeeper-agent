import fs from "node:fs";
import { config } from "./config.js";

/**
 * Groth16 proof generation + Kurier submission.
 *
 * HONEST STATUS — READ BEFORE RELYING ON THIS FOR SCORING:
 *
 * 1. The public event page documents the DECISION logic completely, and
 *    src/decide.js implements all 7 checks. A correct decision scores
 *    +12 with or without a proof.
 * 2. The reliability bonus (+0..+5, pro-rated) and the extra -2 for a
 *    provable task answered without a valid Groth16 proof REQUIRE a
 *    valid proof verified against the platform's registered key.
 * 3. The public /build page says to download the gatekeeper .wasm/.zkey,
 *    generate proofs locally with snarkjs, and include the proof in the
 *    response — but it does NOT list the circuit's input signal names in
 *    the page text, and the exact response field names for the proof are
 *    only confirmed via the dashboard starter prompt / practice mode.
 *
 * This module therefore:
 * - NEVER blocks or fails the decision when proof generation is
 *   unconfigured or fails. It returns { skipped: true, reason } and the
 *   server still answers with the decision inside the 60s deadline.
 * - Generates a real snarkjs Groth16 proof ONLY when the operator supplies
 *   the circuit-input mapping (circuits/inputs.json) from the dashboard
 *   starter prompt / circuit docs, plus the downloaded .wasm/.zkey files.
 * - Submits via Kurier ONLY when KURIER_ENABLED=true with an API key and
 *   API URL from Kurier docs/dashboard. No Kurier URL is guessed here.
 *
 * To enable proofs:
 *   1. Run `npm run download-circuits` (official artifact URLs).
 *   2. From the Agent Games dashboard /build starter prompt, fill in
 *      circuits/inputs.json using circuits/inputs.example.json as a
 *      template. Do NOT invent signal names: wrong names produce invalid
 *      proofs that score -2 per provable task.
 *   3. Run a practice task and confirm the platform marks the proof
 *      verified before scored rounds.
 */

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function loadCircuitInputsMapping() {
  try {
    if (!fs.existsSync(config.circuitInputsFile)) {
      return { ok: false, reason: `inputs mapping not found: ${config.circuitInputsFile}` };
    }
    const parsed = JSON.parse(fs.readFileSync(config.circuitInputsFile, "utf8"));
    if (!parsed || typeof parsed !== "object" || parsed.__template === true) {
      return { ok: false, reason: "inputs mapping is a template; fill it from the dashboard starter prompt" };
    }
    return { ok: true, mapping: parsed };
  } catch (err) {
    return { ok: false, reason: `failed to read inputs mapping: ${err.message}` };
  }
}

/**
 * Build snarkjs circuit inputs from task fields using the operator-supplied
 * mapping. The mapping format is documented in circuits/inputs.example.json:
 *   { "signalName": "{fieldName}" | <literal> }
 * Field names refer to extractFields() output keys (e.g. "minimum").
 * This function deliberately refuses to guess signal names.
 */
export function buildCircuitInputs(mapping, fields, decisionNumeric) {
  const inputs = {};
  for (const [signal, template] of Object.entries(mapping)) {
    if (typeof template === "string" && template.startsWith("{") && template.endsWith("}")) {
      const key = template.slice(1, -1);
      if (key === "decision") {
        inputs[signal] = decisionNumeric;
      } else if (fields[key] !== undefined) {
        inputs[signal] = String(fields[key]);
      } else {
        throw new Error(`circuit input mapping references unknown field "${key}" for signal "${signal}"`);
      }
    } else {
      inputs[signal] = template;
    }
  }
  return inputs;
}

export async function generateProof({ fields, decision }) {
  if (!config.proofEnabled) {
    return { skipped: true, reason: "PROOF_ENABLED=false" };
  }
  if (!fs.existsSync(config.circuitWasmPath) || !fs.existsSync(config.circuitZkeyPath)) {
    return {
      skipped: true,
      reason: `circuit files missing; run: npm run download-circuits (expected ${config.circuitWasmPath} and ${config.circuitZkeyPath})`,
    };
  }
  const mappingResult = loadCircuitInputsMapping();
  if (!mappingResult.ok) {
    return { skipped: true, reason: mappingResult.reason };
  }

  let snarkjs;
  try {
    snarkjs = await import("snarkjs");
  } catch (err) {
    return { skipped: true, reason: `snarkjs not installed: ${err.message}` };
  }

  try {
    const decisionNumeric = decision === "APPROVE" ? 1 : 0;
    const inputs = buildCircuitInputs(mappingResult.mapping, fields, decisionNumeric);
    const { proof, publicSignals } = await withTimeout(
      snarkjs.groth16.fullProve(inputs, config.circuitWasmPath, config.circuitZkeyPath),
      config.proofTimeoutMs,
      "snarkjs fullProve",
    );
    return { skipped: false, proof, publicSignals };
  } catch (err) {
    return { skipped: true, reason: `proof generation failed: ${err.message}` };
  }
}

/**
 * Submit a proof via Kurier and poll until Finalized (or the deadline).
 * Kurier request/response shapes must match Kurier docs/dashboard; this
 * implementation posts { proof, publicSignals, vkHash } and polls the
 * returned job URL. If Kurier rejects the shape, this returns skipped and
 * the decision is still returned with the local proof attached.
 */
export async function submitViaKurier({ proof, publicSignals, deadlineMs }) {
  if (!config.kurierEnabled) {
    return { skipped: true, reason: "KURIER_ENABLED is not true" };
  }
  if (!config.kurierApiKey || !config.kurierApiUrl) {
    return { skipped: true, reason: "KURIER_API_KEY / KURIER_API_URL not configured" };
  }
  const startedAt = Date.now();
  const remaining = () => deadlineMs - (Date.now() - startedAt);
  try {
    const submitRes = await withTimeout(
      fetch(config.kurierApiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.kurierApiKey}`,
        },
        body: JSON.stringify({
          proof,
          publicSignals,
          vkHash: config.gatekeeperVkHash,
        }),
      }),
      Math.max(1000, Math.min(15000, remaining())),
      "Kurier submit",
    );
    if (!submitRes.ok) {
      return { skipped: true, reason: `Kurier submit HTTP ${submitRes.status}` };
    }
    const submitted = await submitRes.json().catch(() => ({}));
    const jobUrl = submitted.jobUrl || submitted.url || submitted.pollUrl || null;
    const txHash = submitted.txHash || submitted.tx_hash || submitted.proofReference || null;
    if (txHash && !jobUrl) {
      return { skipped: false, proofReference: txHash, status: submitted.status || "Submitted" };
    }
    if (!jobUrl) {
      return { skipped: true, reason: "Kurier response had no job URL / tx hash to poll" };
    }
    // Poll until Finalized or the remaining budget runs out.
    while (remaining() > 2000) {
      await new Promise((r) => setTimeout(r, 2000));
      const pollRes = await fetch(jobUrl, {
        headers: { authorization: `Bearer ${config.kurierApiKey}` },
      });
      if (!pollRes.ok) continue;
      const job = await pollRes.json().catch(() => ({}));
      const status = job.status || job.state || "";
      if (/finalized/i.test(status)) {
        return {
          skipped: false,
          proofReference: job.txHash || job.tx_hash || job.proofReference || txHash || null,
          status,
        };
      }
      if (/failed|rejected|error/i.test(status)) {
        return { skipped: true, reason: `Kurier job ${status}` };
      }
    }
    return { skipped: true, reason: "Kurier polling budget exhausted; local proof retained" };
  } catch (err) {
    return { skipped: true, reason: `Kurier submission failed: ${err.message}` };
  }
}
