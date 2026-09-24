import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

// A fixed clock makes every message share the same `createdAt`, reproducing the
// exact condition that used to make send order ambiguous after a reconnect.
const FIXED_NOW = 1_700_000_000_000;

async function withServer(options, fn) {
  const server = createApp(options).listen(0);
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`, port);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

async function register(base, phone) {
  const otpRes = await fetch(`${base}/auth/otp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone }),
  });
  assert.equal(otpRes.status, 200, `request OTP for ${phone}`);
  const { code } = await otpRes.json();

  const verifyRes = await fetch(`${base}/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone, code }),
  });
  assert.equal(verifyRes.status, 200, `verify ${phone}`);
  return (await verifyRes.json()).token;
}

async function api(base, path, { method = "GET", token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, body: data };
}

/** Makes `aPhone` and `bPhone` friends. */
async function befriend(base, aToken, aPhone, bToken, bPhone) {
  const sent = await api(base, "/friends/requests", {
    method: "POST",
    token: aToken,
    body: { phone: bPhone },
  });
  assert.equal(sent.status, 201, `friend request ${aPhone} -> ${bPhone}`);
  const accepted = await api(base, `/friends/requests/${sent.body.id}/accept`, {
    method: "POST",
    token: bToken,
  });
  assert.equal(accepted.status, 200, `accept ${aPhone} -> ${bPhone}`);
}

/** Registers `aPhone` and `bPhone`, makes them friends, opens their 1-1 chat. */
async function openConversation(base, aPhone, bPhone) {
  const a = await register(base, aPhone);
  const b = await register(base, bPhone);
  await befriend(base, a, aPhone, b, bPhone);
  const chat = await api(base, "/conversations", {
    method: "POST",
    token: a,
    body: { phone: bPhone },
  });
  assert.equal(chat.status, 201);
  return { a, b, conversationId: chat.body.id };
}

function wsUrl(base, port, token) {
  return `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`;
}

function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => {
      reject(new Error("websocket connection failed"));
    });
  });
}

/**
 * Connects and collects exactly `count` parsed events, buffering any that
 * arrive before the caller starts awaiting — needed because the server pushes
 * missed messages the moment the handshake completes.
 */
function connectAndCollect(url, count) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const received = [];
    const onMessage = (event) => {
      received.push(JSON.parse(event.data));
      if (received.length >= count) finish();
    };
    const onError = () => finish(new Error("websocket connection failed"));
    const finish = (err) => {
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      if (err) reject(err);
      else resolve({ ws, received });
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
  });
}

/** Resolves with the next parsed event matching `predicate`. */
function waitFor(ws, predicate) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      let parsed;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!predicate(parsed)) return;
      cleanup();
      resolve(parsed);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket closed before the expected event"));
    };
    const cleanup = () => {
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
  });
}

test("messages buffered while offline arrive in send order on reconnect", async () => {
  await withServer({ now: () => FIXED_NOW }, async (base, port) => {
    const { a, b, conversationId } = await openConversation(
      base,
      "0971111111",
      "0972121212",
    );

    // Only Alice is online; Bob stays offline so the next three messages buffer.
    const aliceWs = await connectWs(wsUrl(base, port, a));
    try {
      const texts = ["first", "second", "third"];
      for (const text of texts) {
        const sent = waitFor(
          aliceWs,
          (m) => m.type === "status" && m.message.status === "sent",
        );
        aliceWs.send(JSON.stringify({ type: "send", conversationId, text }));
        await sent;
      }

      // Bob reconnects and must receive the buffered messages in send order.
      const bob = await connectAndCollect(wsUrl(base, port, b), texts.length);
      try {
        const got = bob.received.filter((m) => m.type === "message");
        assert.equal(got.length, texts.length);
        assert.deepEqual(
          got.map((m) => m.message.text),
          texts,
          "reconnected client must see messages in send order",
        );

        // The fixed clock gives all three the same createdAt, so only the
        // monotonic sequence number can be responsible for the correct order.
        assert.deepEqual(
          [...new Set(got.map((m) => m.message.createdAt))],
          [FIXED_NOW],
        );
        const seqs = got.map((m) => m.message.seq);
        assert.ok(
          seqs[0] < seqs[1] && seqs[1] < seqs[2],
          `seq must strictly increase, got ${seqs.join(", ")}`,
        );
      } finally {
        bob.ws.close();
      }
    } finally {
      aliceWs.close();
    }
  });
});
