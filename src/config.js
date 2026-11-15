// Central configuration. All secrets come from environment variables.
// Never commit .env or secrets to git. See .env.example and README.md.
export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || "0.0.0.0",

  // HMAC secret issued once when the agent is registered on Agent Games.
  // 32-byte secret. Keep it in the hosting provider's secret/env settings only.
  hmacSecret: process.env.AGENT_GAMES_HMAC_SECRET || "",
  // Local testing only. NEVER set to "true" in production.
  // When true and no secret is configured, unsigned requests are allowed
  // with a loud warning, so practice payloads can be tested locally.
  allowUnverified: process.env.ALLOW_UNVERIFIED === "true",

  // Persistence (local JSON files). For production with restarts during
  // rounds, prefer a persistent disk / database for these two files.
  seenFile: process.env.SEEN_FILE || "./data/seen.json",
  responseCacheFile: process.env.RESPONSE_CACHE_FILE || "./data/responses.json",

  // Official gatekeeper circuit info, from:
  // https://agentgames.zkverify.io/api/circuit-info (network: mainnet)
  gatekeeperVkHash:
    process.env.GATEKEEPER_VK_HASH ||
    "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0",
  circuitWasmPath: process.env.CIRCUIT_WASM_PATH || "./circuits/gatekeeper.wasm",
  circuitZkeyPath:
    process.env.CIRCUIT_ZKEY_PATH || "./circuits/gatekeeper_final.zkey",
  circuitWasmUrl:
    process.env.CIRCUIT_WASM_URL ||
    "https://agentgames.zkverify.io/circuits/gatekeeper.wasm",
  circuitZkeyUrl:
    process.env.CIRCUIT_ZKEY_URL ||
    "https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey",

  // Proof generation. Enabled by default, but it gracefully skips when
  // circuit files or the circuit-input mapping are missing. See src/proof.js
  // and README.md section "Bukti Groth16" before relying on it for scoring.
  proofEnabled: process.env.PROOF_ENABLED !== "false",
  // JSON file that maps task fields to circuit input signal names.
  // The public /build page does not list the 13 input signal names, so this
  // mapping must come from the dashboard starter prompt / circuit docs.
  // Example file: circuits/inputs.example.json (template only, not valid).
  circuitInputsFile: process.env.CIRCUIT_INPUTS_FILE || "./circuits/inputs.json",
  proofTimeoutMs: Number(process.env.PROOF_TIMEOUT_MS || 20000),

  // Kurier (recommended verification path on the /build page).
  // Disabled unless KURIER_ENABLED=true AND an API key + API URL are set.
  // Do NOT guess the Kurier API URL: copy it from Kurier docs/dashboard.
  kurierEnabled: process.env.KURIER_ENABLED === "true",
  kurierApiKey: process.env.KURIER_API_KEY || "",
  kurierApiUrl: process.env.KURIER_API_URL || "",

  // Hard platform deadline is 60 seconds. Keep our total budget below it
  // so proof/Kurier work can never cause a timeout on the decision itself.
  totalBudgetMs: Number(process.env.TOTAL_BUDGET_MS || 50000),
  maxBodyBytes: Number(process.env.MAX_BODY_BYTES || 1024 * 1024),
};
