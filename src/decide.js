/**
 * Pure, deterministic decision logic for Proof Gatekeeper.
 *
 * Source of truth: https://agentgames.zkverify.io/events/proof-gatekeeper
 * - Sample task payload and expected response shape
 * - Trap encyclopedia: 7 detectable trap varieties
 * - Agent build checklist (7 steps)
 *
 * This module has NO I/O, NO randomness, NO model calls: the same input
 * must always give the same output. All persistence (seen-set) is injected
 * by the caller so this logic is easy to test.
 *
 * Decision order (deterministic, documented):
 *   1. PROOF_REUSED        proof_tx already accepted before
 *   2. VK_SUBSTITUTION     proof_vk != registered_vk (or either missing)
 *   3. THRESHOLD_MISMATCH  public_balance < minimum (or unparseable)
 *   4. RECIPIENT_MISMATCH  recipient != condition_recipient
 *   5. EXPIRED_CONDITION   current_block > expiry_block
 *   6. AMOUNT_OVERFLOW     amount > max_transfer
 *   7. VALID_CONDITION     all checks pass -> APPROVE
 *
 * Scoring note (from the event page): a wrong APPROVE costs -6, a wrong
 * REJECT costs -3. This logic therefore FAILS CLOSED: missing or
 * unparseable fields needed for a check cause a REJECT, never an APPROVE.
 * A timeout costs -2, so the server always answers quickly; see server.js.
 */

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

function normHex(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim().toLowerCase().replace(/^0x/, "");
}

function normAddress(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim().toLowerCase();
}

function normProofTx(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim().toLowerCase();
}

/** Parse an integer that may arrive as a string, number, or BigInt. */
function parseBigInt(value) {
  if (value === null || value === undefined || value === "") return null;
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return null;
      return BigInt(Math.trunc(value));
    }
    const s = String(value).trim();
    if (s === "") return null;
    // Allow hex ("0x...") and decimal strings, with underscores/spaces removed.
    const cleaned = s.replace(/_/g, "").replace(/\s+/g, "");
    return BigInt(cleaned);
  } catch {
    return null;
  }
}

/** First non-empty value from a list of candidate field names. */
function pick(obj, names) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const name of names) {
    const v = obj[name];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Payload parsing: accept the documented shape plus harmless variations.
// The documented shape is:
//   { task_id, mode, issued_at, deadline_at, input: { ... } }
// Some harnesses wrap it as { task: {...} }, { payload: {...} },
// { data: {...} }, or send input fields at the top level. All are accepted.
// ---------------------------------------------------------------------------

export function parseTaskBody(body) {
  if (!body || typeof body !== "object") {
    return { taskId: "", mode: "", input: {}, deadlineAt: "", raw: body };
  }

  // Unwrap one level if needed.
  let envelope = body;
  for (const wrapper of ["task", "payload", "data", "envelope"]) {
    if (
      envelope[wrapper] &&
      typeof envelope[wrapper] === "object" &&
      !envelope.input &&
      !envelope.task_id &&
      !envelope.taskId
    ) {
      envelope = envelope[wrapper];
      break;
    }
  }

  const input =
    envelope.input && typeof envelope.input === "object"
      ? envelope.input
      : envelope;

  const taskId =
    pick(envelope, ["task_id", "taskId", "id", "taskID"]) ??
    pick(input, ["task_id", "taskId", "id"]) ??
    "";
  const mode =
    pick(envelope, ["mode", "type"]) ?? pick(input, ["mode", "type"]) ?? "";
  const deadlineAt =
    pick(envelope, ["deadline_at", "deadlineAt", "deadline"]) ??
    pick(input, ["deadline_at", "deadlineAt", "deadline"]) ??
    "";

  return {
    taskId: String(taskId || ""),
    mode: String(mode || ""),
    input,
    deadlineAt: String(deadlineAt || ""),
    raw: body,
  };
}

export function extractFields(input) {
  const o = input && typeof input === "object" ? input : {};
  return {
    registeredVk: pick(o, [
      "registered_vk",
      "registeredVk",
      "registered_vk_hash",
      "registeredVkHash",
      "condition_vk",
      "conditionVk",
      "vk_hash",
      "vkHash",
    ]),
    proofVk: pick(o, [
      "proof_vk",
      "proofVk",
      "proof_vk_hash",
      "proofVkHash",
      "vk",
      "verification_key",
      "verificationKey",
    ]),
    minimum: pick(o, [
      "minimum",
      "min",
      "min_threshold",
      "minThreshold",
      "threshold",
      "required_minimum",
    ]),
    publicBalance: pick(o, [
      "public_balance",
      "publicBalance",
      "balance",
      "public_input_balance",
    ]),
    expiryBlock: pick(o, [
      "expiry_block",
      "expiryBlock",
      "expiry",
      "expires_at_block",
      "expiry_height",
    ]),
    currentBlock: pick(o, [
      "current_block",
      "currentBlock",
      "block_height",
      "blockHeight",
      "block_number",
      "blockNumber",
      "current_height",
    ]),
    recipient: pick(o, [
      "recipient",
      "recipient_address",
      "recipientAddress",
      "to",
      "payee",
      "proof_recipient",
      "proofRecipient",
    ]),
    conditionRecipient: pick(o, [
      "condition_recipient",
      "conditionRecipient",
      "expected_recipient",
      "expectedRecipient",
      "condition_address",
      "conditionAddress",
      "payment_recipient",
    ]),
    amount: pick(o, [
      "amount",
      "value",
      "transfer_amount",
      "transferAmount",
      "payment_amount",
    ]),
    maxTransfer: pick(o, [
      "max_transfer",
      "maxTransfer",
      "cap",
      "single_transfer_cap",
      "singleTransferCap",
      "max_amount",
    ]),
    proofTx: pick(o, [
      "proof_tx",
      "proofTx",
      "proof_reference",
      "proofReference",
      "proof_ref",
      "proofRef",
      "tx_hash",
      "txHash",
      "proof_tx_hash",
    ]),
  };
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/**
 * @param {object} input - task input fields (see extractFields)
 * @param {object} seen - { has(proofTx): boolean } approved-proof seen-set
 * @returns {{decision: "APPROVE"|"REJECT", reason_code: string, proof_tx: string, checks: object}}
 */
export function decideTask(input, seen) {
  const f = extractFields(input);
  const proofTxRaw = f.proofTx !== undefined ? String(f.proofTx) : "";
  const proofTxNorm = normProofTx(f.proofTx);

  const checks = {
    vkMatches: null,
    thresholdOk: null,
    recipientMatches: null,
    notExpired: null,
    amountOk: null,
    notReused: null,
  };

  const reject = (reason_code) => ({
    decision: "REJECT",
    reason_code,
    proof_tx: proofTxRaw,
    checks,
  });

  // 1. Proof reuse: only proofs previously ACCEPTED count as "seen".
  // The caller adds a proof_tx to the seen-set only on APPROVE.
  if (proofTxNorm && seen && typeof seen.has === "function" && seen.has(proofTxNorm)) {
    checks.notReused = false;
    return reject("PROOF_REUSED");
  }
  checks.notReused = true;

  // 2. Verification-key substitution. Fail closed when either side is missing.
  const registered = normHex(f.registeredVk);
  const proofVk = normHex(f.proofVk);
  if (!registered || !proofVk) {
    checks.vkMatches = false;
    return reject("VK_SUBSTITUTION");
  }
  checks.vkMatches = registered === proofVk;
  if (!checks.vkMatches) return reject("VK_SUBSTITUTION");

  // 3. Threshold mismatch. Fail closed when values are unparseable.
  const minimum = parseBigInt(f.minimum);
  const balance = parseBigInt(f.publicBalance);
  if (minimum === null || balance === null) {
    checks.thresholdOk = false;
    return reject("THRESHOLD_MISMATCH");
  }
  checks.thresholdOk = balance >= minimum;
  if (!checks.thresholdOk) return reject("THRESHOLD_MISMATCH");

  // 4. Recipient mismatch. Fail closed when either side is missing.
  const recipient = normAddress(f.recipient);
  const conditionRecipient = normAddress(f.conditionRecipient);
  if (!recipient || !conditionRecipient) {
    checks.recipientMatches = false;
    return reject("RECIPIENT_MISMATCH");
  }
  checks.recipientMatches = recipient === conditionRecipient;
  if (!checks.recipientMatches) return reject("RECIPIENT_MISMATCH");

  // 5. Expired condition. Expired when current_block > expiry_block.
  // Fail closed when block heights are unparseable.
  const expiry = parseBigInt(f.expiryBlock);
  const current = parseBigInt(f.currentBlock);
  if (expiry === null || current === null) {
    checks.notExpired = false;
    return reject("EXPIRED_CONDITION");
  }
  checks.notExpired = current <= expiry;
  if (!checks.notExpired) return reject("EXPIRED_CONDITION");

  // 6. Amount overflow. Fail closed when values are unparseable.
  const amount = parseBigInt(f.amount);
  const cap = parseBigInt(f.maxTransfer);
  if (amount === null || cap === null) {
    checks.amountOk = false;
    return reject("AMOUNT_OVERFLOW");
  }
  checks.amountOk = amount <= cap;
  if (!checks.amountOk) return reject("AMOUNT_OVERFLOW");

  // 7. All checks pass.
  return {
    decision: "APPROVE",
    reason_code: "VALID_CONDITION",
    proof_tx: proofTxRaw,
    checks,
  };
}
