import crypto from "node:crypto";

/**
 * HMAC helpers for Agent Games.
 *
 * Rules (from /rules and /build):
 * - The platform issues a 32-byte secret once at agent registration.
 * - Incoming requests carry `x-agent-games-signature` over the RAW body.
 * - Responses must be signed with `x-agent-games-signature` over the RAW
 *   response body.
 * - Verify the signature BEFORE parsing or processing the task.
 *
 * Key encoding is not stated unambiguously in the public docs, so this
 * module accepts the three plausible encodings for the secret:
 * 1. 64 hex characters -> decoded to 32 bytes
 * 2. Base64 that decodes to 32 bytes -> decoded to 32 bytes
 * 3. Anything else -> used as UTF-8 bytes as-is
 *
 * Signature headers are accepted as hex (with optional `0x` or `sha256=`
 * prefix) or Base64. Comparison is timing-safe.
 */

export function secretToKey(secret) {
  const s = String(secret || "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) {
    return Buffer.from(s, "hex");
  }
  if (/^[A-Za-z0-9+/=]{40,48}$/.test(s)) {
    try {
      const decoded = Buffer.from(s, "base64");
      if (decoded.length === 32) return decoded;
    } catch {
      // Fall through to UTF-8.
    }
  }
  return Buffer.from(s, "utf8");
}

export function computeHmacHex(secret, rawBodyBuffer) {
  const key = secretToKey(secret);
  return crypto
    .createHmac("sha256", key)
    .update(rawBodyBuffer)
    .digest("hex");
}

function parseSignatureHeader(headerValue) {
  const raw = String(headerValue || "").trim();
  if (!raw) return [];
  const stripped = raw
    .replace(/^sha256=/i, "")
    .replace(/^hmac-sha256=/i, "")
    .replace(/^0x/i, "")
    .trim();
  const candidates = [];
  if (/^[0-9a-fA-F]+$/.test(stripped) && stripped.length % 2 === 0) {
    try {
      candidates.push(Buffer.from(stripped, "hex"));
    } catch {
      // ignore
    }
  }
  // Base64 candidate (only if it looks like base64 and differs from hex).
  if (/^[A-Za-z0-9+/=]+$/.test(stripped)) {
    try {
      const b64 = Buffer.from(stripped, "base64");
      if (b64.length === 32) candidates.push(b64);
    } catch {
      // ignore
    }
  }
  return candidates;
}

export function verifySignature(secret, rawBodyBuffer, headerValue) {
  if (!secret) return false;
  const expected = crypto
    .createHmac("sha256", secretToKey(secret))
    .update(rawBodyBuffer)
    .digest();
  const candidates = parseSignatureHeader(headerValue);
  for (const candidate of candidates) {
    if (candidate.length !== expected.length) continue;
    if (crypto.timingSafeEqual(candidate, expected)) return true;
  }
  return false;
}

export function signResponseBody(secret, rawBodyBuffer) {
  return computeHmacHex(secret, rawBodyBuffer);
}
