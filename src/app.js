import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { signJwt, verifyJwt } from "./jwt.js";
import { computeAccept, WebSocketConnection } from "./websocket.js";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  imageDimensions,
  makeThumbnail,
  normalizeMimeType,
  sniffImageMime,
} from "./images.js";

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const LOCK_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_WRONG_ATTEMPTS = 5;
const JWT_TTL_SECONDS = 60 * 60; // 1 hour
const DEFAULT_JWT_SECRET = "zalo-dev-secret-change-me";

// Local phone numbers (with an optional leading "+") between 9 and 15 digits.
const PHONE_RE = /^\+?\d{9,15}$/;
const CODE_RE = /^\d{6}$/;

// package.json name/version, read once at startup so the version endpoint
// never hardcodes them (ZALO-11).
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const MAX_MESSAGE_LENGTH = 4000;
const MIN_GROUP_MEMBERS = 2;
const MAX_GROUP_MEMBERS = 100;

// Static frontend shell (ZALO-12): every GET is resolved strictly inside
// public/, so path traversal (e.g. /../package.json) can never escape it.
const PUBLIC_DIR = resolve(fileURLToPath(new URL("../public", import.meta.url)));

const STATIC_MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

function contentTypeFor(filePath) {
  return (
    STATIC_MIME_TYPES[extname(filePath).toLowerCase()] ??
    "application/octet-stream"
  );
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Serves a static file under public/ for a GET request. Returns true when the
 * request was handled (served, or refused as an escape attempt); returns false
 * when the file simply does not exist, so the caller can answer 404.
 */
function servePublic(res, pathname) {
  if (pathname === "/") pathname = "/index.html";

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    json(res, 404, { error: "not found" });
    return true;
  }

  const filePath = resolve(PUBLIC_DIR, "." + decoded);
  if (!filePath.startsWith(PUBLIC_DIR + sep)) {
    // Path traversal: anything outside public/ is never served.
    json(res, 404, { error: "not found" });
    return true;
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) return false;

  const body = readFileSync(filePath);
  res.writeHead(200, {
    "content-type": contentTypeFor(filePath),
    "content-length": String(body.length),
  });
  res.end(body);
  return true;
}

/** Writes a raw binary body (used for serving image bytes). */
function sendBytes(res, status, buffer, contentType) {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": String(buffer.length),
    "cache-control": "public, max-age=31536000, immutable",
  });
  res.end(buffer);
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

/** Reads a raw (binary) request body into a Buffer. */
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
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
 * The text a message exposes to the search endpoint (ZALO-25). Text messages
 * search their body; image messages carry no body, so they only match against
 * their metadata (MIME type, byte size, dimensions).
 */
function searchableText(message) {
  if (typeof message.text === "string") return message.text;
  if (message.kind === "image" && message.image) {
    return [
      message.image.mimeType,
      message.image.size,
      message.image.width,
      message.image.height,
    ]
      .filter((part) => part !== null && part !== undefined)
      .join(" ");
  }
  return "";
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
  const connections = new Map(); // phone -> Set of open WebSocket connections
  const images = new Map(); // id -> { id, mimeType, size, width, height, uploader, createdAt, bytes, thumbnail }
  let nextSeq = 1; // Monotonic, server-assigned send order across all messages

  /** Returns the authenticated phone (JWT `sub`) or null after replying 401. */
  function requireAuth(req, res) {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const payload = verifyJwt(token, jwtSecret);
    if (
      !payload ||
      typeof payload.sub !== "string" ||
      !isValidPhone(payload.sub) ||
      (typeof payload.exp === "number" && payload.exp <= Math.floor(now() / 1000))
    ) {
      json(res, 401, { error: "unauthorized" });
      return null;
    }
    return payload.sub;
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

  function rejectUpgrade(socket, status) {
    const reason =
      status === 401
        ? "Unauthorized"
        : status === 404
          ? "Not Found"
          : "Bad Request";
    try {
      socket.write(
        `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
      socket.destroy();
    } catch {
      /* ignore */
    }
  }

  function sendWsError(conn, error) {
    conn.sendText(JSON.stringify({ type: "error", error }));
  }

  /** The wire representation of a message, with the read count for groups. */
  function messageView(conversation, message) {
    const view = { ...message };
    if (conversation.type === "group") {
      view.readCount = message.readBy.length;
    }
    return view;
  }

  /** Phones (other than the sender) that have an open socket right now. */
  function onlineRecipients(conversation, sender) {
    const list = [];
    for (const participant of conversation.participants) {
      if (participant === sender) continue;
      if ((connections.get(participant)?.size ?? 0) > 0) list.push(participant);
    }
    return list;
  }

  /** Derives the aggregate status (sent/delivered/read) from receipt state. */
  function recomputeStatus(message) {
    if (message.readBy.length > 0) message.status = "read";
    else if (message.deliveredTo.length > 0) message.status = "delivered";
    else message.status = "sent";
  }

  /** Pushes a message's current status to its sender over the socket. */
  function pushStatus(phone, conversation, message) {
    const set = connections.get(phone);
    if (!set || set.size === 0) return;
    const payload = JSON.stringify({
      type: "status",
      message: messageView(conversation, message),
    });
    for (const conn of [...set]) conn.sendText(payload);
  }

  function deliver(conversation, message) {
    const payload = JSON.stringify({
      type: "message",
      message: messageView(conversation, message),
    });
    for (const participant of message.deliveredTo) {
      const set = connections.get(participant);
      if (!set || set.size === 0) continue;
      for (const conn of [...set]) conn.sendText(payload);
    }
  }

  /**
   * Pushes the messages `phone` missed while offline to a freshly (re)connected
   * socket, ordered by the monotonic `seq` so they always arrive in send order
   * even when several share the same `createdAt` (ZALO-10).
   */
  function deliverMissed(phone, conn) {
    for (const conversation of conversations.values()) {
      if (!conversation.participants.includes(phone)) continue;
      const missed = (conversation.messages ?? [])
        .filter((m) => m.sender !== phone && !m.deliveredTo.includes(phone))
        .sort((a, b) => a.seq - b.seq);
      for (const message of missed) {
        message.deliveredTo.push(phone);
        recomputeStatus(message);
        conn.sendText(
          JSON.stringify({
            type: "message",
            message: messageView(conversation, message),
          }),
        );
        pushStatus(message.sender, conversation, message);
      }
    }
  }

  /** Marks a message as read by `phone` and notifies the sender. */
  function handleRead(phone, conn, parsed) {
    const { conversationId, messageId } = parsed;
    const conversation = conversations.get(conversationId);
    if (!conversation) return sendWsError(conn, "conversation not found");
    if (!conversation.participants.includes(phone)) {
      return sendWsError(conn, "not a participant");
    }
    const message = (conversation.messages ?? []).find((m) => m.id === messageId);
    if (!message) return sendWsError(conn, "message not found");
    if (message.sender === phone) {
      return sendWsError(conn, "cannot read your own message");
    }
    if (message.readBy.includes(phone)) return; // re-reading is a no-op
    message.readBy.push(phone);
    recomputeStatus(message);
    pushStatus(message.sender, conversation, message);
  }

  function handleWsMessage(phone, conn, raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return sendWsError(conn, "invalid JSON");
    }
    if (!parsed || typeof parsed !== "object") {
      return sendWsError(conn, "unsupported message type");
    }
    if (parsed.type === "read") return handleRead(phone, conn, parsed);

    const kind =
      parsed.type === "send" ? "text" : parsed.type === "image" ? "image" : null;
    if (!kind) return sendWsError(conn, "unsupported message type");

    const { conversationId } = parsed;
    const conversation = conversations.get(conversationId);
    if (!conversation) return sendWsError(conn, "conversation not found");
    if (!conversation.participants.includes(phone)) {
      return sendWsError(conn, "not a participant");
    }
    if (conversation.type !== "group") {
      const recipient = conversation.participants.find((p) => p !== phone);
      if (!isFriend(phone, recipient)) {
        return sendWsError(conn, "can only message friends");
      }
    }

    let message;
    if (kind === "text") {
      const { text } = parsed;
      if (typeof text !== "string" || text.trim() === "") {
        return sendWsError(conn, "text must be a non-empty string");
      }
      if (text.length > MAX_MESSAGE_LENGTH) {
        return sendWsError(conn, "text too long");
      }
      message = {
        id: randomUUID(),
        seq: nextSeq++,
        conversationId,
        sender: phone,
        kind: "text",
        text,
        createdAt: now(),
        status: "sent",
        deliveredTo: [],
        readBy: [],
      };
    } else {
      const image = images.get(parsed.imageId);
      if (!image) return sendWsError(conn, "image not found");
      message = {
        id: randomUUID(),
        seq: nextSeq++,
        conversationId,
        sender: phone,
        kind: "image",
        image: {
          id: image.id,
          url: `/images/${image.id}`,
          thumbnailUrl: `/images/${image.id}/thumbnail`,
          mimeType: image.mimeType,
          size: image.size,
          width: image.width,
          height: image.height,
        },
        createdAt: now(),
        status: "sent",
        deliveredTo: [],
        readBy: [],
      };
    }

    if (!conversation.messages) conversation.messages = [];
    conversation.messages.push(message);

    // Acknowledge the initial "sent" state, then report "delivered" and
    // push the message to whatever recipients are online right now.
    pushStatus(phone, conversation, message);
    message.deliveredTo = onlineRecipients(conversation, phone);
    recomputeStatus(message);
    if (message.status !== "sent") pushStatus(phone, conversation, message);
    deliver(conversation, message);
  }

  const server = createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, "http://localhost");
      const method = req.method;

      if (method === "GET" && pathname === "/health") {
        return json(res, 200, { status: "ok" });
      }

      if (method === "GET" && pathname === "/api/version") {
        return json(res, 200, { name: pkg.name, version: pkg.version });
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

      if (method === "GET" && pathname === "/friends") {
        const me = requireAuth(req, res);
        if (!me) return;
        // The caller's friends as a sorted list of phones (ZALO-14).
        const list = [...(friends.get(me) ?? [])].sort();
        return json(res, 200, { friends: list });
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
          type: "direct",
          participants: [me, phone],
          createdAt: now(),
          messages: [],
        };
        conversations.set(conversation.id, conversation);
        conversationByPair.set(key, conversation.id);
        return json(res, 201, conversation);
      }

      // The Chats page needs to list a user's conversations (ZALO-15):
      // return the caller's own conversations (direct and group) with their
      // latest message, ordered most recent first.
      if (method === "GET" && pathname === "/conversations") {
        const me = requireAuth(req, res);
        if (!me) return;

        const list = [];
        for (const conversation of conversations.values()) {
          if (!conversation.participants.includes(me)) continue;
          const messages = conversation.messages ?? [];
          let latest = null;
          let unreadCount = 0;
          for (const message of messages) {
            if (latest === null || message.seq > latest.seq) latest = message;
            // A message is unread for the caller when someone else sent it and
            // the caller is not yet in its read receipts (ZALO-24).
            if (message.sender !== me && !message.readBy.includes(me)) {
              unreadCount += 1;
            }
          }
          list.push({
            id: conversation.id,
            type: conversation.type,
            name: conversation.name,
            participants: [...conversation.participants],
            latestMessage: latest ? messageView(conversation, latest) : null,
            createdAt: conversation.createdAt,
            unreadCount,
          });
        }

        // Most recent first: by the newest activity (the latest message, or the
        // conversation's own creation time when it has no messages yet).
        list.sort((a, b) => {
          const aAt = a.latestMessage ? a.latestMessage.createdAt : a.createdAt;
          const bAt = b.latestMessage ? b.latestMessage.createdAt : b.createdAt;
          if (aAt !== bAt) return bAt - aAt;
          const aSeq = a.latestMessage ? a.latestMessage.seq : 0;
          const bSeq = b.latestMessage ? b.latestMessage.seq : 0;
          if (aSeq !== bSeq) return bSeq - aSeq;
          return b.createdAt - a.createdAt;
        });

        return json(res, 200, { conversations: list });
      }

      if (method === "GET" && pathname.startsWith("/conversations/")) {
        const match = pathname.match(/^\/conversations\/([^/]+)\/messages$/);
        if (match) {
          const me = requireAuth(req, res);
          if (!me) return;
          const conversation = conversations.get(match[1]);
          if (!conversation) {
            return json(res, 404, { error: "conversation not found" });
          }
          if (!conversation.participants.includes(me)) {
            return json(res, 403, { error: "not a participant" });
          }

          const { searchParams } = new URL(req.url, "http://localhost");

          // Search (ZALO-25): the caller's own messages containing the query,
          // case-insensitive, newest first, at most 50. Image messages only
          // match on their metadata (see `searchableText`).
          const q = searchParams.get("q");
          if (q !== null) {
            const query = q.toLowerCase();
            const results = (conversation.messages ?? [])
              .filter(
                (m) =>
                  m.sender === me &&
                  searchableText(m).toLowerCase().includes(query),
              )
              .sort((a, b) => b.seq - a.seq)
              .slice(0, 50)
              .map((m) => messageView(conversation, m));
            return json(res, 200, { messages: results });
          }

          let limit = 50;
          const limitRaw = searchParams.get("limit");
          if (limitRaw !== null) {
            limit = Number.parseInt(limitRaw, 10);
            if (!Number.isInteger(limit) || limit < 1) {
              return json(res, 400, { error: "invalid limit" });
            }
            limit = Math.min(limit, 100);
          }
          const before = searchParams.get("before");
          // Order by the monotonic sequence number so history is stable even
          // when several messages share the same `createdAt` (ZALO-10).
          const messages = [...(conversation.messages ?? [])].sort(
            (a, b) => a.seq - b.seq,
          );
          let end = messages.length;
          if (before) {
            const idx = messages.findIndex((m) => m.id === before);
            if (idx === -1) {
              return json(res, 404, { error: "message not found" });
            }
            end = idx;
          }
          const page = messages
            .slice(Math.max(0, end - limit), end)
            .reverse()
            .map((m) => messageView(conversation, m));
          return json(res, 200, {
            messages: page,
            hasMore: end - limit > 0,
            nextCursor: page.length > 0 ? page[page.length - 1].id : null,
          });
        }
      }

      // ---- Group chat (ZALO-6) ----

      if (method === "POST" && pathname === "/groups") {
        const me = requireAuth(req, res);
        if (!me) return;
        const body = await readJson(req);
        if (body === null) return json(res, 400, { error: "invalid JSON body" });
        const { name, members } = body;
        if (typeof name !== "string" || name.trim() === "") {
          return json(res, 400, { error: "group name is required" });
        }
        if (
          !Array.isArray(members) ||
          members.some((member) => !isValidPhone(member))
        ) {
          return json(res, 400, { error: "members must be an array of phone numbers" });
        }
        if (new Set(members).size !== members.length) {
          return json(res, 400, { error: "members must be unique" });
        }
        if (members.includes(me)) {
          return json(res, 400, { error: "the creator is already a member" });
        }
        const total = members.length + 1;
        if (total < MIN_GROUP_MEMBERS || total > MAX_GROUP_MEMBERS) {
          return json(res, 400, { error: "a group must have between 2 and 100 members" });
        }
        for (const phone of members) {
          if (!accounts.has(phone)) {
            return json(res, 404, { error: "user not found" });
          }
          if (!isFriend(me, phone)) {
            return json(res, 403, { error: "members must be friends" });
          }
        }
        const group = {
          id: randomUUID(),
          type: "group",
          name,
          admin: me,
          participants: [me, ...members],
          createdAt: now(),
          messages: [],
        };
        conversations.set(group.id, group);
        return json(res, 201, group);
      }

      if (method === "POST" && /^\/groups\/[^/]+\/members$/.test(pathname)) {
        const me = requireAuth(req, res);
        if (!me) return;
        const segments = pathname.split("/").filter(Boolean);
        const group = conversations.get(segments[1]);
        if (!group || group.type !== "group") {
          return json(res, 404, { error: "group not found" });
        }
        if (group.admin !== me) {
          return json(res, 403, { error: "only the group admin can add members" });
        }
        const body = await readJson(req);
        if (body === null) return json(res, 400, { error: "invalid JSON body" });
        const phone = body.phone;
        if (!isValidPhone(phone)) {
          return json(res, 400, { error: "invalid phone number" });
        }
        if (group.participants.includes(phone)) {
          return json(res, 409, { error: "already a member" });
        }
        if (!accounts.has(phone)) {
          return json(res, 404, { error: "user not found" });
        }
        if (group.participants.length >= MAX_GROUP_MEMBERS) {
          return json(res, 400, { error: "group is full" });
        }
        if (!isFriend(me, phone)) {
          return json(res, 403, { error: "can only add friends" });
        }
        group.participants.push(phone);
        return json(res, 200, group);
      }

      if (
        method === "DELETE" &&
        /^\/groups\/[^/]+\/members\/[^/]+$/.test(pathname)
      ) {
        const me = requireAuth(req, res);
        if (!me) return;
        const segments = pathname.split("/").filter(Boolean);
        const group = conversations.get(segments[1]);
        if (!group || group.type !== "group") {
          return json(res, 404, { error: "group not found" });
        }
        if (group.admin !== me) {
          return json(res, 403, { error: "only the group admin can remove members" });
        }
        const phone = segments[3];
        if (phone === me) {
          return json(res, 400, { error: "the admin cannot remove themselves" });
        }
        const index = group.participants.indexOf(phone);
        if (index === -1) {
          return json(res, 404, { error: "member not found" });
        }
        if (group.participants.length <= MIN_GROUP_MEMBERS) {
          return json(res, 400, { error: "a group must have at least 2 members" });
        }
        group.participants.splice(index, 1);
        return json(res, 200, group);
      }

      // ---- Images (ZALO-9) ----

      if (method === "POST" && pathname === "/images") {
        const me = requireAuth(req, res);
        if (!me) return;

        const mimeType = normalizeMimeType(req.headers["content-type"]);
        if (!mimeType) {
          return json(res, 415, {
            error: `unsupported image type; allowed types: ${[...ALLOWED_IMAGE_TYPES.keys()].join(", ")}`,
          });
        }

        const body = await readBody(req);
        if (body.length === 0) {
          return json(res, 400, { error: "image body is empty" });
        }
        if (body.length > MAX_IMAGE_BYTES) {
          return json(res, 413, {
            error: "image exceeds the 20 MB limit",
          });
        }
        const sniffed = sniffImageMime(body);
        if (sniffed !== mimeType) {
          return json(res, 415, {
            error: "image bytes do not match the declared content type",
          });
        }

        const id = randomUUID();
        const dimensions = imageDimensions(body, mimeType);
        const thumbnail = makeThumbnail(body, mimeType);
        images.set(id, {
          id,
          mimeType,
          size: body.length,
          width: dimensions?.width ?? null,
          height: dimensions?.height ?? null,
          uploader: me,
          createdAt: now(),
          bytes: body,
          thumbnailBytes: thumbnail.bytes,
          thumbnailMimeType: thumbnail.mimeType,
        });
        return json(res, 201, {
          id,
          mimeType,
          size: body.length,
          width: dimensions?.width ?? null,
          height: dimensions?.height ?? null,
          url: `/images/${id}`,
          thumbnailUrl: `/images/${id}/thumbnail`,
        });
      }

      if (method === "GET" && /^\/images\/[^/]+\/thumbnail$/.test(pathname)) {
        const me = requireAuth(req, res);
        if (!me) return;
        const id = pathname.split("/")[2];
        const image = images.get(id);
        if (!image) return json(res, 404, { error: "image not found" });
        return sendBytes(res, 200, image.thumbnailBytes, image.thumbnailMimeType);
      }

      if (method === "GET" && /^\/images\/[^/]+$/.test(pathname)) {
        const me = requireAuth(req, res);
        if (!me) return;
        const id = pathname.split("/")[2];
        const image = images.get(id);
        if (!image) return json(res, 404, { error: "image not found" });
        return sendBytes(res, 200, image.bytes, image.mimeType);
      }

      // ---- Static frontend shell (ZALO-12) ----

      if (method === "GET" && servePublic(res, pathname)) return;

      return json(res, 404, { error: "not found" });
    } catch {
      if (!res.headersSent) json(res, 500, { error: "internal server error" });
      else res.end();
    }
  });

  server.on("upgrade", (req, socket, head) => {
    try {
      const { pathname, searchParams } = new URL(req.url, "http://localhost");
      if (pathname !== "/ws") return rejectUpgrade(socket, 404);

      const token = searchParams.get("token") ?? "";
      const payload = verifyJwt(token, jwtSecret);
      const phone =
        payload &&
        typeof payload.sub === "string" &&
        isValidPhone(payload.sub) &&
        !(
          typeof payload.exp === "number" &&
          payload.exp <= Math.floor(now() / 1000)
        )
          ? payload.sub
          : null;
      if (!phone) return rejectUpgrade(socket, 401);

      const key = req.headers["sec-websocket-key"];
      const version = req.headers["sec-websocket-version"];
      if (typeof key !== "string" || key.length === 0) {
        return rejectUpgrade(socket, 400);
      }
      if (version !== "13") return rejectUpgrade(socket, 400);

      const conn = new WebSocketConnection(socket);
      if (!connections.has(phone)) connections.set(phone, new Set());
      connections.get(phone).add(conn);

      conn.onMessage = (raw) => handleWsMessage(phone, conn, raw);
      conn.onClose = () => {
        const set = connections.get(phone);
        if (!set) return;
        set.delete(conn);
        if (set.size === 0) connections.delete(phone);
      };

      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${computeAccept(key)}\r\n\r\n`,
      );

      // Deliver anything this user missed while offline, in send order, so a
      // reconnect never shows messages shuffled (ZALO-10).
      deliverMissed(phone, conn);

      if (head && head.length > 0) conn.feed(head);
    } catch {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
  });

  return server;
}
