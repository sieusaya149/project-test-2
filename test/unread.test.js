import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

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

const nextMessage = (ws) => waitFor(ws, (m) => m.type === "message");
const nextStatus = (ws, status) =>
  waitFor(ws, (m) => m.type === "status" && m.message.status === status);

test("GET /conversations reports an unreadCount from read receipts", async () => {
  await withServer({}, async (base, port) => {
    const { a, b, conversationId } = await openConversation(
      base,
      "0981111111",
      "0982222222",
    );

    // Alice sends three messages while Bob is offline: none have been read.
    const aliceWs = await connectWs(wsUrl(base, port, a));
    try {
      for (const text of ["one", "two", "three"]) {
        const sent = nextStatus(aliceWs, "sent");
        aliceWs.send(JSON.stringify({ type: "send", conversationId, text }));
        await sent;
      }
    } finally {
      aliceWs.close();
    }

    // Bob's unread count is 3; Alice's own messages are not unread for her.
    const bobList = await api(base, "/conversations", { token: b });
    assert.equal(bobList.status, 200);
    const bobConversation = bobList.body.conversations[0];
    assert.equal(bobConversation.unreadCount, 3);

    const aliceList = await api(base, "/conversations", { token: a });
    assert.equal(aliceList.body.conversations[0].unreadCount, 0);

    // The existing fields survive alongside the new one.
    assert.equal(bobConversation.id, conversationId);
    assert.equal(bobConversation.type, "direct");
    assert.deepEqual(
      [...bobConversation.participants].sort(),
      ["0981111111", "0982222222"].sort(),
    );
    assert.equal(bobConversation.latestMessage.text, "three");
    assert.ok("createdAt" in bobConversation);

    // A stranger still sees nothing (caller-only list).
    const stranger = await register(base, "0983333333");
    const none = await api(base, "/conversations", { token: stranger });
    assert.deepEqual(none.body.conversations, []);
  });
});

test("marking messages read clears the unread count", async () => {
  await withServer({}, async (base, port) => {
    const { a, b, conversationId } = await openConversation(
      base,
      "0984444444",
      "0985555555",
    );

    const aliceWs = await connectWs(wsUrl(base, port, a));
    const bobWs = await connectWs(wsUrl(base, port, b));
    try {
      // Alice sends two messages; Bob receives them live but has not read them.
      const first = nextMessage(bobWs);
      const firstSent = nextStatus(aliceWs, "sent");
      aliceWs.send(JSON.stringify({ type: "send", conversationId, text: "one" }));
      const m1 = await first;
      await firstSent;

      const second = nextMessage(bobWs);
      const secondSent = nextStatus(aliceWs, "sent");
      aliceWs.send(JSON.stringify({ type: "send", conversationId, text: "two" }));
      const m2 = await second;
      await secondSent;

      const unreadBefore = await api(base, "/conversations", { token: b });
      assert.equal(unreadBefore.body.conversations[0].unreadCount, 2);

      // Bob reads the first message -> one unread remains.
      const readOne = nextStatus(aliceWs, "read");
      bobWs.send(
        JSON.stringify({ type: "read", conversationId, messageId: m1.message.id }),
      );
      await readOne;
      const afterFirst = await api(base, "/conversations", { token: b });
      assert.equal(afterFirst.body.conversations[0].unreadCount, 1);

      // Bob reads the second message -> cleared.
      const readTwo = nextStatus(aliceWs, "read");
      bobWs.send(
        JSON.stringify({ type: "read", conversationId, messageId: m2.message.id }),
      );
      await readTwo;
      const afterSecond = await api(base, "/conversations", { token: b });
      assert.equal(afterSecond.body.conversations[0].unreadCount, 0);

      // Alice never has unread messages she wrote herself.
      const aliceList = await api(base, "/conversations", { token: a });
      assert.equal(aliceList.body.conversations[0].unreadCount, 0);
    } finally {
      aliceWs.close();
      bobWs.close();
    }
  });
});
