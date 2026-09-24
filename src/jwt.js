import { createHmac } from "node:crypto";

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
