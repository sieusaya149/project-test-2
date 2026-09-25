import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

// A fixed clock keeps `createdAt` identical across messages, so the list order
// must come from the monotonic sequence number (ZALO-10) rather than time.
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

/** Makes `aToken` (phone `aPhone`) and `bToken` (phone `bPhone`) friends. */
async function befriend(base, aToken, bToken, bPhone) {
  const sent = await api(base, "/friends/requests", {
    method: "POST",
    token: aToken,
    body: { phone: bPhone },
  });
  assert.equal(sent.status, 201);
  const accepted = await api(base, `/friends/requests/${sent.body.id}/accept`, {
    method: "POST",
    token: bToken,
  });
  assert.equal(accepted.status, 200);
}

/** Registers two friends and opens their 1-1 conversation. */
async function openConversation(base, aPhone, bPhone) {
  const a = await register(base, aPhone);
  const b = await register(base, bPhone);
  await befriend(base, a, b, bPhone);
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

/** Sends a text message and waits for the sender's "sent" acknowledgement. */
async function sendMessage(ws, conversationId, text) {
  const sent = waitFor(
    ws,
    (m) => m.type === "status" && m.message.status === "sent" && m.message.text === text,
  );
  ws.send(JSON.stringify({ type: "send", conversationId, text }));
  await sent;
}

test("GET /conversations requires a valid JWT", async () => {
  await withServer({}, async (base) => {
    const res = await api(base, "/conversations");
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "unauthorized");
  });
});

test("GET /conversations lists only the caller's conversations", async () => {
  await withServer({}, async (base) => {
    const { a, b, conversationId } = await openConversation(
      base,
      "0981111111",
      "0982222222",
    );

    // A sees their conversation with the other participant listed.
    const list = await api(base, "/conversations", { token: a });
    assert.equal(list.status, 200);
    assert.equal(list.body.conversations.length, 1);
    const conversation = list.body.conversations[0];
    assert.equal(conversation.id, conversationId);
    assert.equal(conversation.type, "direct");
    assert.deepEqual(
      [...conversation.participants].sort(),
      ["0981111111", "0982222222"].sort(),
    );
    assert.equal(conversation.latestMessage, null);

    // B sees the same conversation (mirrored participants).
    const other = await api(base, "/conversations", { token: b });
    assert.equal(other.status, 200);
    assert.equal(other.body.conversations.length, 1);

    // A stranger sees nothing, even though the conversation exists in the store.
    const stranger = await register(base, "0983333333");
    const none = await api(base, "/conversations", { token: stranger });
    assert.equal(none.status, 200);
    assert.deepEqual(none.body.conversations, []);
  });
});

test("GET /conversations is sorted most recent first and carries the latest message", async () => {
  await withServer({ now: () => FIXED_NOW }, async (base, port) => {
    const { a, b, conversationId: abId } = await openConversation(
      base,
      "0984444444",
      "0985555555",
    );
    // Second conversation: A with C.
    const c = await register(base, "0986666666");
    await befriend(base, a, c, "0986666666");
    const acChat = await api(base, "/conversations", {
      method: "POST",
      token: a,
      body: { phone: "0986666666" },
    });
    assert.equal(acChat.status, 201);
    const acId = acChat.body.id;

    const aliceWs = await connectWs(wsUrl(base, port, a));
    try {
      await sendMessage(aliceWs, abId, "first");
      await sendMessage(aliceWs, acId, "second");

      const list = await api(base, "/conversations", { token: a });
      assert.equal(list.status, 200);
      const conversations = list.body.conversations;
      assert.equal(conversations.length, 2);

      // Most recent first: the A-C chat got the later message ("second").
      assert.deepEqual(
        conversations.map((c) => c.id),
        [acId, abId],
      );
      assert.equal(conversations[0].latestMessage.text, "second");
      assert.equal(conversations[1].latestMessage.text, "first");

      // Each conversation exposes its participants and its creation time.
      assert.ok(conversations[0].participants.includes("0984444444"));
      assert.ok(conversations[0].participants.includes("0986666666"));
      assert.ok(conversations[1].participants.includes("0985555555"));
      assert.equal(conversations[0].createdAt, FIXED_NOW);
    } finally {
      aliceWs.close();
    }

    // The other side (B) only sees the one conversation it belongs to.
    const bList = await api(base, "/conversations", { token: b });
    assert.equal(bList.status, 200);
    assert.equal(bList.body.conversations.length, 1);
    assert.equal(bList.body.conversations[0].id, abId);
    assert.equal(bList.body.conversations[0].latestMessage.text, "first");
  });
});
