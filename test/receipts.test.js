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
const nextError = (ws) => waitFor(ws, (m) => m.type === "error");
const nextStatus = (ws, status) =>
  waitFor(ws, (m) => m.type === "status" && m.message.status === status);

test("a 1-1 message progresses sent -> delivered -> read over the socket", async () => {
  await withServer({}, async (base, port) => {
    const { a, b, conversationId } = await openConversation(
      base,
      "0941010101",
      "0942020202",
    );

    const aliceWs = await connectWs(wsUrl(base, port, a));
    const bobWs = await connectWs(wsUrl(base, port, b));
    try {
      const bobReceives = nextMessage(bobWs);
      const sentStatus = nextStatus(aliceWs, "sent");
      const deliveredStatus = nextStatus(aliceWs, "delivered");
      aliceWs.send(JSON.stringify({ type: "send", conversationId, text: "hello" }));

      const [sent, delivered, received] = await Promise.all([
        sentStatus,
        deliveredStatus,
        bobReceives,
      ]);

      assert.equal(sent.type, "status");
      assert.equal(sent.message.status, "sent");
      assert.equal(sent.message.id, received.message.id);
      assert.deepEqual(sent.message.readBy, []);

      assert.equal(delivered.type, "status");
      assert.equal(delivered.message.status, "delivered");
      assert.deepEqual(delivered.message.deliveredTo, ["0942020202"]);

      assert.equal(received.type, "message");
      assert.equal(received.message.text, "hello");
      assert.equal(received.message.status, "delivered");

      // Bob marks the message read; Alice sees the status flip to "read".
      const readStatus = nextStatus(aliceWs, "read");
      bobWs.send(
        JSON.stringify({ type: "read", conversationId, messageId: received.message.id }),
      );
      const read = await readStatus;
      assert.equal(read.message.status, "read");
      assert.deepEqual(read.message.readBy, ["0942020202"]);

      // The final status is persisted and visible in history.
      const history = await api(base, `/conversations/${conversationId}/messages`, {
        token: a,
      });
      assert.equal(history.status, 200);
      assert.equal(history.body.messages[0].status, "read");
      assert.deepEqual(history.body.messages[0].readBy, ["0942020202"]);
    } finally {
      aliceWs.close();
      bobWs.close();
    }
  });
});

test("a message to an offline friend stays sent", async () => {
  await withServer({}, async (base, port) => {
    const { a, conversationId } = await openConversation(
      base,
      "0943030303",
      "0944040404",
    );

    // Only the sender is online.
    const aliceWs = await connectWs(wsUrl(base, port, a));
    try {
      const sentStatus = nextStatus(aliceWs, "sent");
      aliceWs.send(JSON.stringify({ type: "send", conversationId, text: "you there?" }));
      const sent = await sentStatus;
      assert.equal(sent.message.status, "sent");
      assert.deepEqual(sent.message.deliveredTo, []);

      const history = await api(base, `/conversations/${conversationId}/messages`, {
        token: a,
      });
      assert.equal(history.body.messages[0].status, "sent");
      assert.deepEqual(history.body.messages[0].deliveredTo, []);
    } finally {
      aliceWs.close();
    }
  });
});

test("group messages report how many members have read them", async () => {
  await withServer({}, async (base, port) => {
    const alice = await register(base, "0945050505");
    const bob = await register(base, "0946060606");
    const carol = await register(base, "0947070707");
    await befriend(base, alice, "0945050505", bob, "0946060606");
    await befriend(base, alice, "0945050505", carol, "0947070707");

    const created = await api(base, "/groups", {
      method: "POST",
      token: alice,
      body: { name: "trio", members: ["0946060606", "0947070707"] },
    });
    assert.equal(created.status, 201);
    const id = created.body.id;

    const aliceWs = await connectWs(wsUrl(base, port, alice));
    const bobWs = await connectWs(wsUrl(base, port, bob));
    const carolWs = await connectWs(wsUrl(base, port, carol));
    try {
      const bobReceives = nextMessage(bobWs);
      const carolReceives = nextMessage(carolWs);
      const aliceDelivered = nextStatus(aliceWs, "delivered");
      aliceWs.send(
        JSON.stringify({ type: "send", conversationId: id, text: "hello group" }),
      );
      const [toBob, toCarol, delivered] = await Promise.all([
        bobReceives,
        carolReceives,
        aliceDelivered,
      ]);
      const messageId = toBob.message.id;

      assert.equal(delivered.message.status, "delivered");
      assert.equal(delivered.message.readCount, 0);

      // Bob reads first -> 1 of the other 2 members has read.
      const readOne = nextStatus(aliceWs, "read");
      bobWs.send(JSON.stringify({ type: "read", conversationId: id, messageId }));
      const first = await readOne;
      assert.equal(first.message.status, "read");
      assert.equal(first.message.readCount, 1);
      assert.deepEqual(first.message.readBy, ["0946060606"]);

      // Carol reads -> 2 of the other 2 members have read.
      const readTwo = nextStatus(aliceWs, "read");
      carolWs.send(JSON.stringify({ type: "read", conversationId: id, messageId }));
      const second = await readTwo;
      assert.equal(second.message.readCount, 2);
      assert.deepEqual(second.message.readBy, ["0946060606", "0947070707"]);

      // History exposes the same read count.
      const history = await api(base, `/conversations/${id}/messages`, { token: alice });
      assert.equal(history.status, 200);
      assert.equal(history.body.messages[0].status, "read");
      assert.equal(history.body.messages[0].readCount, 2);
    } finally {
      aliceWs.close();
      bobWs.close();
      carolWs.close();
    }
  });
});

test("read receipts reject non-participants, own messages, and unknown ids", async () => {
  await withServer({}, async (base, port) => {
    const { a, b, conversationId } = await openConversation(
      base,
      "0948080808",
      "0949090909",
    );
    const aliceWs = await connectWs(wsUrl(base, port, a));
    const bobWs = await connectWs(wsUrl(base, port, b));
    const stranger = await register(base, "0950000000");
    const strangerWs = await connectWs(wsUrl(base, port, stranger));
    try {
      const bobReceives = nextMessage(bobWs);
      aliceWs.send(JSON.stringify({ type: "send", conversationId, text: "hi" }));
      const received = await bobReceives;
      const messageId = received.message.id;

      // A non-participant cannot mark the message read.
      const strangerErr = nextError(strangerWs);
      strangerWs.send(JSON.stringify({ type: "read", conversationId, messageId }));
      assert.equal((await strangerErr).error, "not a participant");

      // The author of the message cannot read their own message.
      const aliceErr = nextError(aliceWs);
      aliceWs.send(JSON.stringify({ type: "read", conversationId, messageId }));
      assert.equal((await aliceErr).error, "cannot read your own message");

      // An unknown message id is rejected.
      const bobErr = nextError(bobWs);
      bobWs.send(
        JSON.stringify({ type: "read", conversationId, messageId: "does-not-exist" }),
      );
      assert.equal((await bobErr).error, "message not found");
    } finally {
      aliceWs.close();
      bobWs.close();
      strangerWs.close();
    }
  });
});
