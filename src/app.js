import { createServer } from "node:http";
import { randomInt, timingSafeEqual } from "node:crypto";
import { signJwt } from "./jwt.js";

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const LOCK_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_WRONG_ATTEMPTS = 5;
const JWT_TTL_SECONDS = 60 * 60; // 1 hour
const DEFAULT_JWT_SECRET = "zalo-dev-secret-change-me";

// Local phone numbers (with an optional leading "+") between 9 and 15 digits.
const PHONE_RE = /^\+?\d{9,15}$/;
const CODE_RE = /^\d{6}$/;

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Reads and parses a JSON request body; returns null when it is not valid JSON. */
async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isValidPhone(phone) {
  return typeof phone === "string" && PHONE_RE.test(phone);
}

function isValidCode(code) {
  return typeof code === "string" && CODE_RE.test(code);
}

function codesMatch(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Builds the HTTP server. `options.now` injects a clock (ms) for tests and
 * `options.jwtSecret` overrides the signing secret.
 */
export function createApp(options = {}) {
  const now = options.now ?? (() => Date.now());
  const jwtSecret =
    options.jwtSecret ?? process.env.JWT_SECRET ?? DEFAULT_JWT_SECRET;

  // In-memory stores: acceptable for this story, per the acceptance criteria.
  const otps = new Map(); // phone -> { code, expiresAt }
  const accounts = new Map(); // phone -> { phone, createdAt }
  const lockout = new Map(); // phone -> { attempts, lockedUntil }

  return createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, "http://localhost");
      const method = req.method;

      if (method === "GET" && pathname === "/health") {
        return json(res, 200, { status: "ok" });
      }

      if (method === "POST" && pathname === "/auth/otp") {
        const body = await readJson(req);
        if (body === null) return json(res, 400, { error: "invalid JSON body" });
        const phone = body.phone;
        if (!isValidPhone(phone)) {
          return json(res, 400, { error: "invalid phone number" });
        }
        const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
        otps.set(phone, { code, expiresAt: now() + OTP_TTL_MS });
        // No SMS provider yet: return the code so the verify flow is testable.
        return json(res, 200, { code });
      }

      if (method === "POST" && pathname === "/auth/verify") {
        const body = await readJson(req);
        if (body === null) return json(res, 400, { error: "invalid JSON body" });
        const { phone, code } = body;
        if (!isValidPhone(phone)) {
          return json(res, 400, { error: "invalid phone number" });
        }
        if (!isValidCode(code)) {
          return json(res, 400, { error: "invalid code" });
        }

        const lock = lockout.get(phone);
        if (lock && lock.lockedUntil > now()) {
          return json(res, 429, {
            error: "too many wrong codes; phone is locked for 15 minutes",
          });
        }

        const otp = otps.get(phone);
        if (!otp || otp.expiresAt <= now()) {
          return json(res, 400, { error: "code expired or not requested" });
        }

        if (!codesMatch(otp.code, code)) {
          const rec = lockout.get(phone) ?? { attempts: 0, lockedUntil: 0 };
          // A previously expired lock starts a fresh attempt counter.
          if (rec.lockedUntil !== 0 && rec.lockedUntil <= now()) {
            rec.attempts = 0;
            rec.lockedUntil = 0;
          }
          rec.attempts += 1;
          if (rec.attempts > MAX_WRONG_ATTEMPTS) {
            rec.attempts = 0;
            rec.lockedUntil = now() + LOCK_TTL_MS;
            lockout.set(phone, rec);
            return json(res, 429, {
              error: "too many wrong codes; phone is locked for 15 minutes",
            });
          }
          lockout.set(phone, rec);
          return json(res, 401, { error: "invalid code" });
        }

        accounts.set(phone, { phone, createdAt: now() });
        otps.delete(phone);
        lockout.delete(phone); // a correct code resets the attempt counter
        const token = signJwt(
          {
            sub: phone,
            iat: Math.floor(now() / 1000),
            exp: Math.floor(now() / 1000) + JWT_TTL_SECONDS,
          },
          jwtSecret,
        );
        return json(res, 200, { token, phone });
      }

      return json(res, 404, { error: "not found" });
    } catch {
      if (!res.headersSent) json(res, 500, { error: "internal server error" });
      else res.end();
    }
  });
}
