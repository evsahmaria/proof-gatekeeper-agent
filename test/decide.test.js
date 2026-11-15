import { test } from "node:test";
import assert from "node:assert/strict";
import { decideTask, extractFields, parseTaskBody } from "../src/decide.js";

const BASE = {
  registered_vk: "0x7d3a111111111111111111111111111111111111111111111111111111f291",
  proof_vk: "0x7d3a111111111111111111111111111111111111111111111111111111f291",
  minimum: "1000",
  public_balance: "1460",
  expiry_block: 19842201,
  current_block: 19832000,
  recipient: "0xDe42000000000000000000000000000000009f01",
  condition_recipient: "0xDe42000000000000000000000000000000009f01",
  amount: "500",
  max_transfer: "1000",
  proof_tx: "0xa4c10000000000000000000000000000000000000000000000000000008ff1",
};

const emptySeen = { has: () => false };
const seenWith = (tx) => ({ has: (v) => v === String(tx).toLowerCase() });

test("VALID_CONDITION approves when all checks pass", () => {
  const r = decideTask({ ...BASE }, emptySeen);
  assert.equal(r.decision, "APPROVE");
  assert.equal(r.reason_code, "VALID_CONDITION");
  assert.equal(r.proof_tx, BASE.proof_tx);
});

test("VK_SUBSTITUTION rejects when proof VK differs", () => {
  const r = decideTask({ ...BASE, proof_vk: "0xa4c1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb8ff" }, emptySeen);
  assert.equal(r.decision, "REJECT");
  assert.equal(r.reason_code, "VK_SUBSTITUTION");
});

test("VK comparison is case-insensitive and 0x-insensitive", () => {
  const r = decideTask(
    { ...BASE, proof_vk: BASE.registered_vk.toUpperCase().replace("0X", "") },
    emptySeen,
  );
  assert.equal(r.decision, "APPROVE");
});

test("THRESHOLD_MISMATCH rejects when balance is below minimum", () => {
  const r = decideTask({ ...BASE, public_balance: "999" }, emptySeen);
  assert.equal(r.reason_code, "THRESHOLD_MISMATCH");
  assert.equal(r.decision, "REJECT");
});

test("THRESHOLD_MISMATCH boundary: balance equal to minimum approves", () => {
  const r = decideTask({ ...BASE, public_balance: "1000" }, emptySeen);
  assert.equal(r.decision, "APPROVE");
});

test("PROOF_REUSED rejects a previously approved proof_tx", () => {
  const r = decideTask({ ...BASE }, seenWith(BASE.proof_tx));
  assert.equal(r.reason_code, "PROOF_REUSED");
});

test("EXPIRED_CONDITION rejects when current block passed expiry", () => {
  const r = decideTask({ ...BASE, current_block: 19842202 }, emptySeen);
  assert.equal(r.reason_code, "EXPIRED_CONDITION");
});

test("RECIPIENT_MISMATCH rejects when recipient differs", () => {
  const r = decideTask({ ...BASE, recipient: "0x1111111111111111111111111111111111111111" }, emptySeen);
  assert.equal(r.reason_code, "RECIPIENT_MISMATCH");
});

test("AMOUNT_OVERFLOW rejects when amount exceeds cap", () => {
  const r = decideTask({ ...BASE, amount: "1001" }, emptySeen);
  assert.equal(r.reason_code, "AMOUNT_OVERFLOW");
});

test("AMOUNT_OVERFLOW boundary: amount equal to cap approves", () => {
  const r = decideTask({ ...BASE, amount: "1000" }, emptySeen);
  assert.equal(r.decision, "APPROVE");
});

test("BigInt amounts compare correctly beyond Number safe integer", () => {
  const big = "9007199254740993"; // 2^53 + 1
  const r = decideTask(
    { ...BASE, minimum: "1", public_balance: big, amount: big, max_transfer: big },
    emptySeen,
  );
  assert.equal(r.decision, "APPROVE");
  const r2 = decideTask(
    { ...BASE, minimum: "1", public_balance: big, amount: "9007199254740994", max_transfer: big },
    emptySeen,
  );
  assert.equal(r2.reason_code, "AMOUNT_OVERFLOW");
});

test("Missing VK fails closed to REJECT", () => {
  const input = { ...BASE };
  delete input.proof_vk;
  const r = decideTask(input, emptySeen);
  assert.equal(r.decision, "REJECT");
  assert.equal(r.reason_code, "VK_SUBSTITUTION");
});

test("parseTaskBody unwraps input envelope and task wrapper", () => {
  const p1 = parseTaskBody({ task_id: "gk_1", mode: "competition", input: BASE });
  assert.equal(p1.taskId, "gk_1");
  assert.equal(p1.input.minimum, "1000");
  const p2 = parseTaskBody({ task: { task_id: "gk_2", input: BASE } });
  assert.equal(p2.taskId, "gk_2");
  assert.equal(extractFields(p2.input).proofTx, BASE.proof_tx);
});

test("Sample payload from the event page (VK mismatch) rejects", () => {
  // Mirrors the documented example shape: registered_vk != proof_vk.
  const sample = {
    registered_vk: "0x7d3a000000000000000000000000000000000000000000000000000000f291",
    proof_vk: "0xa4c1000000000000000000000000000000000000000000000000000000b8ff",
    minimum: "1000",
    public_balance: "1460",
    expiry_block: 19842201,
    current_block: 19832000,
    recipient: "0xDe42000000000000000000000000000000009f01",
    condition_recipient: "0xDe42000000000000000000000000000000009f01",
    amount: "500",
    max_transfer: "1000",
    proof_tx: "0xa4c10000000000000000000000000000000000000000000000000000008ff1",
  };
  const r = decideTask(sample, emptySeen);
  assert.equal(r.decision, "REJECT");
  assert.equal(r.reason_code, "VK_SUBSTITUTION");
});
