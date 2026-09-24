import { createHmac, timingSafeEqual } from "node:crypto";

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

/**
 * Signs a JWT (HS256) with a secret. Returns the compact
 * "header.payload.signature" form; no external dependencies.
 */
export function signJwt(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const encode = (obj) => base64url(JSON.stringify(obj));
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

/**
 * Verifies an HS256 JWT and returns its payload, or null when the token is
 * malformed, uses a different algorithm, or fails the signature check.
 * Expiry is intentionally left to the caller so a test clock can be used.
 */
export function verifyJwt(token, secret) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (!header || header.alg !== "HS256") return null;

  const expected = createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64url");
  const actual = Buffer.from(signatureB64);
  const expectedBuf = Buffer.from(expected);
  if (actual.length !== expectedBuf.length || !timingSafeEqual(actual, expectedBuf)) {
    return null;
  }

  return payload;
}
