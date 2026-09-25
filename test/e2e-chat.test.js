import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

/**
 * End-to-end test (ZALO-19): two users log in with OTP, become friends, open a
 * 1-1 conversation, and exchange a message over the WebSocket — each user sees
 * the other's message. Runs against a real server on a random port (listen(0))
 * and cleans up its sockets and server afterwards.
 */

async function withServer(fn) {
  const server = createApp().listen(0);
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`, port);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

/** Full OTP log-in: request a code, then verify it to obtain a JWT. */
async function loginWithOtp(base, phone) {
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

function wsUrl(port, token) {
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

/** Resolves with the next parsed event matching `predicate`. */
function nextEvent(ws, predicate) {
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

test("two users log in with OTP, become friends, and chat over WebSocket", async () => {
  await withServer(async (base, port) => {
    const alicePhone = "0981000001";
    const bobPhone = "0982000002";

    // Step 1 — each user logs in with OTP and gets a JWT.
    const alice = await loginWithOtp(base, alicePhone);
    const bob = await loginWithOtp(base, bobPhone);

    // Step 2 — Alice sends Bob a friend request; Bob accepts.
    const sent = await api(base, "/friends/requests", {
      method: "POST",
      token: alice,
      body: { phone: bobPhone },
    });
    assert.equal(sent.status, 201, "friend request must be created");
    assert.equal(sent.body.from, alicePhone);
    assert.equal(sent.body.to, bobPhone);

    const accepted = await api(base, `/friends/requests/${sent.body.id}/accept`, {
      method: "POST",
      token: bob,
    });
    assert.equal(accepted.status, 200, "friend request must be accepted");
    assert.equal(accepted.body.status, "accepted");

    // Step 3 — open their 1-1 conversation.
    const chat = await api(base, "/conversations", {
      method: "POST",
      token: alice,
      body: { phone: bobPhone },
    });
    assert.equal(chat.status, 201, "conversation must be created");
    const conversationId = chat.body.id;

    // Step 4 — both connect to the realtime channel.
    const aliceWs = await connectWs(wsUrl(port, alice));
    const bobWs = await connectWs(wsUrl(port, bob));
    try {
      // Alice → Bob: Bob must see Alice's message live.
      const bobSeesAlice = nextEvent(bobWs, (m) => m.type === "message");
      aliceWs.send(
        JSON.stringify({ type: "send", conversationId, text: "hi bob" }),
      );
      const toBob = await bobSeesAlice;
      assert.equal(toBob.message.sender, alicePhone);
      assert.equal(toBob.message.text, "hi bob");
      assert.equal(toBob.message.conversationId, conversationId);

      // Bob → Alice: Alice must see Bob's message live.
      const aliceSeesBob = nextEvent(aliceWs, (m) => m.type === "message");
      bobWs.send(
        JSON.stringify({ type: "send", conversationId, text: "hi alice" }),
      );
      const toAlice = await aliceSeesBob;
      assert.equal(toAlice.message.sender, bobPhone);
      assert.equal(toAlice.message.text, "hi alice");
      assert.equal(toAlice.message.conversationId, conversationId);

      // Both messages are persisted and readable from the REST history.
      const history = await api(base, `/conversations/${conversationId}/messages`, {
        token: alice,
      });
      assert.equal(history.status, 200);
      const texts = history.body.messages.map((m) => m.text).sort();
      assert.deepEqual(texts, ["hi alice", "hi bob"]);
    } finally {
      aliceWs.close();
      bobWs.close();
    }
  });
});
