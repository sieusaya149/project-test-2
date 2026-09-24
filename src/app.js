import { createServer } from "node:http";
import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { signJwt, verifyJwt } from "./jwt.js";
import { WsConnection, writeHandshake, rejectUpgrade } from "./ws.js";

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const LOCK_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_WRONG_ATTEMPTS = 5;
const JWT_TTL_SECONDS = 60 * 60; // 1 hour
const DEFAULT_JWT_SECRET = "zalo-dev-secret-change-me";

// Local phone numbers (with an optional leading "+") between 9 and 15 digits.
const PHONE_RE = /^\+?\d{9,15}$/;
const CODE_RE = /^\d{6}$/;
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;

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

/** Parses a pagination `limit`, clamping it to [min, max] (or the fallback). */
function clampInt(value, min, max, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
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
  const friendRequests = new Map(); // id -> { id, from, to, status, createdAt }
  const friends = new Map(); // phone -> Set of friend phones
  const conversations = new Map(); // id -> { id, participants, createdAt }
  const conversationByPair = new Map(); // "a:b" (sorted) -> conversation id
  const messages = new Map(); // conversationId -> [{ id, conversationId, sender, text, sentAt }]
  const connections = new Map(); // phone -> Set of live WebSocket connections
  let messageSeq = 0; // monotonic source of message ids (also the pagination cursor)

  /** Validates a JWT and returns the authenticated phone (`sub`) or null. */
  function authenticate(token) {
    if (typeof token !== "string" || token === "") return null;
    const payload = verifyJwt(token, jwtSecret);
    if (
      !payload ||
      typeof payload.sub !== "string" ||
      !isValidPhone(payload.sub) ||
      (typeof payload.exp === "number" && payload.exp <= Math.floor(now() / 1000))
    ) {
      return null;
    }
    return payload.sub;
  }

  /** Returns the authenticated phone (JWT `sub`) or null after replying 401. */
  function requireAuth(req, res) {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const phone = authenticate(token);
    if (!phone) {
      json(res, 401, { error: "unauthorized" });
      return null;
    }
    return phone;
  }

  function isFriend(a, b) {
    return friends.get(a)?.has(b) === true;
  }

  function addFriendship(a, b) {
    if (!friends.has(a)) friends.set(a, new Set());
    if (!friends.has(b)) friends.set(b, new Set());
    friends.get(a).add(b);
    friends.get(b).add(a);
  }

  function pendingRequestBetween(a, b) {
    for (const request of friendRequests.values()) {
      if (
        request.status === "pending" &&
        ((request.from === a && request.to === b) ||
          (request.from === b && request.to === a))
      ) {
        return request;
      }
    }
    return null;
  }

  function pairKey(a, b) {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }

  /** Pushes a JSON-serialisable payload to every live socket of a phone. */
  function pushTo(phone, payload) {
    const sockets = connections.get(phone);
    if (!sockets || sockets.size === 0) return;
    const data = JSON.stringify(payload);
    for (const conn of sockets) conn.send(data);
  }

  /** Handles an inbound WebSocket message (already parsed text) from `sender`. */
  function handleWsMessage(sender, conn, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return conn.send(JSON.stringify({ type: "error", error: "invalid JSON" }));
    }
    if (!msg || msg.type !== "message") {
      return conn.send(
        JSON.stringify({ type: "error", error: "expected a message frame" }),
      );
    }
    const { conversationId, text } = msg;
    if (typeof text !== "string" || text.length === 0) {
      return conn.send(JSON.stringify({ type: "error", error: "invalid text" }));
    }
    const conversation = conversations.get(conversationId);
    if (!conversation) {
      return conn.send(
        JSON.stringify({ type: "error", error: "conversation not found" }),
      );
    }
    if (!conversation.participants.includes(sender)) {
      return conn.send(
        JSON.stringify({ type: "error", error: "not a participant" }),
      );
    }
    // Only friends may chat: re-assert the invariant at send time.
    const [a, b] = conversation.participants;
    if (!isFriend(a, b)) {
      return conn.send(JSON.stringify({ type: "error", error: "not friends" }));
    }

    const message = {
      id: String(++messageSeq),
      conversationId,
      sender,
      text,
      sentAt: now(),
    };
    const list = messages.get(conversationId) ?? [];
    list.push(message);
    messages.set(conversationId, list);

    const payload = { type: "message", message };
    const recipient = a === sender ? b : a;
    pushTo(sender, payload); // echo back so the sender gets the canonical record
    pushTo(recipient, payload); // realtime push to the online recipient
  }

  const server = createServer(async (req, res) => {
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

      // ---- Friends & 1-1 chat (ZALO-3) ----

      if (method === "GET" && pathname === "/users/lookup") {
        const me = requireAuth(req, res);
        if (!me) return;
        const { searchParams } = new URL(req.url, "http://localhost");
        const phone = searchParams.get("phone");
        if (!isValidPhone(phone)) {
          return json(res, 400, { error: "invalid phone number" });
        }
        const account = accounts.get(phone);
        if (!account) return json(res, 404, { error: "user not found" });
        return json(res, 200, { phone: account.phone, createdAt: account.createdAt });
      }

      if (method === "GET" && pathname === "/friends/requests") {
        const me = requireAuth(req, res);
        if (!me) return;
        const requests = [];
        for (const request of friendRequests.values()) {
          if (request.to === me && request.status === "pending") {
            requests.push(request);
          }
        }
        return json(res, 200, { requests });
      }

      if (method === "POST" && pathname === "/friends/requests") {
        const me = requireAuth(req, res);
        if (!me) return;
        const body = await readJson(req);
        if (body === null) return json(res, 400, { error: "invalid JSON body" });
        const phone = body.phone;
        if (!isValidPhone(phone)) {
          return json(res, 400, { error: "invalid phone number" });
        }
        if (phone === me) {
          return json(res, 400, { error: "cannot send a friend request to yourself" });
        }
        if (!accounts.has(phone)) {
          return json(res, 404, { error: "user not found" });
        }
        if (isFriend(me, phone)) {
          return json(res, 400, { error: "already friends" });
        }
        if (pendingRequestBetween(me, phone)) {
          return json(res, 409, { error: "friend request already pending" });
        }
        const request = {
          id: randomUUID(),
          from: me,
          to: phone,
          status: "pending",
          createdAt: now(),
        };
        friendRequests.set(request.id, request);
        return json(res, 201, request);
      }

      if (
        method === "POST" &&
        pathname.startsWith("/friends/requests/")
      ) {
        const me = requireAuth(req, res);
        if (!me) return;
        const segments = pathname.split("/").filter(Boolean);
        if (segments.length !== 4) return json(res, 404, { error: "not found" });
        const id = segments[2];
        const action = segments[3];
        const request = friendRequests.get(id);
        if (!request) return json(res, 404, { error: "friend request not found" });
        if (request.to !== me) {
          return json(res, 403, { error: "this request is not addressed to you" });
        }
        if (request.status !== "pending") {
          return json(res, 409, { error: "friend request already handled" });
        }
        if (action === "accept") {
          request.status = "accepted";
          addFriendship(request.from, request.to);
          return json(res, 200, request);
        }
        if (action === "decline") {
          request.status = "declined";
          return json(res, 200, request);
        }
        return json(res, 404, { error: "not found" });
      }

      if (method === "POST" && pathname === "/conversations") {
        const me = requireAuth(req, res);
        if (!me) return;
        const body = await readJson(req);
        if (body === null) return json(res, 400, { error: "invalid JSON body" });
        const phone = body.phone;
        if (!isValidPhone(phone)) {
          return json(res, 400, { error: "invalid phone number" });
        }
        if (phone === me) {
          return json(res, 400, { error: "cannot chat with yourself" });
        }
        if (!accounts.has(phone)) {
          return json(res, 404, { error: "user not found" });
        }
        if (!isFriend(me, phone)) {
          return json(res, 403, { error: "can only start a chat with friends" });
        }
        const key = pairKey(me, phone);
        const existingId = conversationByPair.get(key);
        if (existingId) {
          return json(res, 200, conversations.get(existingId));
        }
        const conversation = {
          id: randomUUID(),
          participants: [me, phone],
          createdAt: now(),
        };
        conversations.set(conversation.id, conversation);
        conversationByPair.set(key, conversation.id);
        return json(res, 201, conversation);
      }

      // ---- Realtime 1-1 messaging (ZALO-5) ----

      const messagesMatch = pathname.match(/^\/conversations\/([^/]+)\/messages$/);
      if (method === "GET" && messagesMatch) {
        const me = requireAuth(req, res);
        if (!me) return;
        const conversationId = messagesMatch[1];
        const conversation = conversations.get(conversationId);
        if (!conversation) {
          return json(res, 404, { error: "conversation not found" });
        }
        if (!conversation.participants.includes(me)) {
          return json(res, 403, { error: "not a participant" });
        }
        const { searchParams } = new URL(req.url, "http://localhost");
        const limit = clampInt(
          searchParams.get("limit"),
          1,
          MAX_PAGE_LIMIT,
          DEFAULT_PAGE_LIMIT,
        );
        const before = searchParams.get("before");
        const list = messages.get(conversationId) ?? [];
        let window = list;
        if (before !== null && before !== undefined) {
          const index = list.findIndex((m) => m.id === before);
          if (index === -1) return json(res, 404, { error: "unknown cursor" });
          window = list.slice(0, index);
        }
        const page = window.slice(-limit);
        const hasMore = window.length > page.length;
        return json(res, 200, {
          conversationId,
          messages: page,
          hasMore,
          nextCursor: hasMore ? page[0].id : null,
        });
      }

      return json(res, 404, { error: "not found" });
    } catch {
      if (!res.headersSent) json(res, 500, { error: "internal server error" });
      else res.end();
    }
  });

  server.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== "/ws") {
        return rejectUpgrade(socket, 404, "Not Found");
      }
      const key = req.headers["sec-websocket-key"];
      if (
        (req.headers.upgrade ?? "").toLowerCase() !== "websocket" ||
        typeof key !== "string"
      ) {
        return rejectUpgrade(socket, 400, "Bad Request");
      }
      const user = authenticate(url.searchParams.get("token"));
      if (!user) {
        return rejectUpgrade(socket, 401, "Unauthorized");
      }
      writeHandshake(socket, key);
      const conn = new WsConnection(socket, head);
      let sockets = connections.get(user);
      if (!sockets) connections.set(user, (sockets = new Set()));
      sockets.add(conn);
      conn.onmessage = (raw) => handleWsMessage(user, conn, raw);
      conn.onclose = () => {
        const set = connections.get(user);
        if (set) {
          set.delete(conn);
          if (set.size === 0) connections.delete(user);
        }
      };
    } catch {
      rejectUpgrade(socket, 500, "Internal Server Error");
    }
  });

  return server;
}
