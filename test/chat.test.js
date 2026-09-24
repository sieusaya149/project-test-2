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

/** Makes `a` and `b` friends and opens their 1-1 conversation. */
async function openConversation(base, aPhone, bPhone) {
  const a = await register(base, aPhone);
  const b = await register(base, bPhone);

  const sent = await api(base, "/friends/requests", {
    method: "POST",
    token: a,
    body: { phone: bPhone },
  });
  assert.equal(sent.status, 201);

  const accepted = await api(base, `/friends/requests/${sent.body.id}/accept`, {
    method: "POST",
    token: b,
  });
  assert.equal(accepted.status, 200);

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

/** Resolves with the next parsed text message on the socket. */
function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      cleanup();
      resolve(JSON.parse(event.data));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket closed before a message arrived"));
    };
    const cleanup = () => {
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
  });
}

test("a WebSocket connection requires a valid token", async () => {
  await withServer({}, async (base, port) => {
    await assert.rejects(
      connectWs(wsUrl(base, port, "not-a-jwt")),
      /failed/,
      "a bad token must be refused",
    );

    const token = await register(base, "0901010101");
    const ws = await connectWs(wsUrl(base, port, token));
    ws.close();
  });
});

test("friends exchange a message over WebSocket in under 1 second and it is persisted", async () => {
  await withServer({}, async (base, port) => {
    const { a, b, conversationId } = await openConversation(
      base,
      "0902020202",
      "0903030303",
    );

    const aliceWs = await connectWs(wsUrl(base, port, a));
    const bobWs = await connectWs(wsUrl(base, port, b));
    try {
      const bobReceives = nextMessage(bobWs);
      const startedAt = Date.now();
      aliceWs.send(JSON.stringify({ type: "send", conversationId, text: "hello" }));

      const received = await bobReceives;
      const elapsed = Date.now() - startedAt;

      assert.equal(received.type, "message");
      assert.equal(received.message.sender, "0902020202");
      assert.equal(received.message.text, "hello");
      assert.equal(received.message.conversationId, conversationId);
      assert.ok(received.message.id, "message must have an id");
      assert.ok(received.message.createdAt, "message must have a timestamp");
      assert.ok(elapsed < 1000, `delivery took ${elapsed}ms`);

      // The message must be persisted and loadable from the REST history.
      const history = await api(base, `/conversations/${conversationId}/messages`, {
        token: b,
      });
      assert.equal(history.status, 200);
      assert.equal(history.body.messages.length, 1);
      assert.equal(history.body.messages[0].id, received.message.id);
      assert.equal(history.body.messages[0].text, "hello");
      assert.equal(history.body.hasMore, false);
    } finally {
      aliceWs.close();
      bobWs.close();
    }
  });
});

test("GET /conversations/:id/messages is paginated, newest first", async () => {
  await withServer({}, async (base, port) => {
    const { a, b, conversationId } = await openConversation(
      base,
      "0904040404",
      "0905050505",
    );

    const aliceWs = await connectWs(wsUrl(base, port, a));
    const bobWs = await connectWs(wsUrl(base, port, b));
    try {
      const sentIds = [];
      for (let i = 1; i <= 5; i += 1) {
        const bobReceives = nextMessage(bobWs);
        aliceWs.send(JSON.stringify({ type: "send", conversationId, text: `msg ${i}` }));
        const received = await bobReceives;
        sentIds.push(received.message.id);
      }

      // First page (newest first): msg 5 and msg 4.
      const page1 = await api(
        base,
        `/conversations/${conversationId}/messages?limit=2`,
        { token: a },
      );
      assert.equal(page1.status, 200);
      assert.equal(page1.body.messages.length, 2);
      assert.deepEqual(
        page1.body.messages.map((m) => m.text),
        ["msg 5", "msg 4"],
      );
      assert.equal(page1.body.hasMore, true);
      assert.equal(page1.body.nextCursor, sentIds[3]); // msg 4

      // Second page using the cursor: msg 3 and msg 2.
      const page2 = await api(
        base,
        `/conversations/${conversationId}/messages?limit=2&before=${page1.body.nextCursor}`,
        { token: b },
      );
      assert.equal(page2.status, 200);
      assert.deepEqual(
        page2.body.messages.map((m) => m.text),
        ["msg 3", "msg 2"],
      );
      assert.equal(page2.body.hasMore, true);
      assert.equal(page2.body.nextCursor, sentIds[1]); // msg 2

      // Last page: msg 1 only, nothing older.
      const page3 = await api(
        base,
        `/conversations/${conversationId}/messages?limit=2&before=${page2.body.nextCursor}`,
        { token: a },
      );
      assert.equal(page3.status, 200);
      assert.deepEqual(
        page3.body.messages.map((m) => m.text),
        ["msg 1"],
      );
      assert.equal(page3.body.hasMore, false);
      assert.equal(page3.body.nextCursor, sentIds[0]);
    } finally {
      aliceWs.close();
      bobWs.close();
    }
  });
});

test("only conversation participants can read or send messages", async () => {
  await withServer({}, async (base, port) => {
    const { a, conversationId } = await openConversation(
      base,
      "0906060606",
      "0907070707",
    );
    // Carol is a friend of neither, but registers to prove non-membership is refused.
    const carol = await register(base, "0908080808");

    // Carol cannot read the conversation history.
    const history = await api(base, `/conversations/${conversationId}/messages`, {
      token: carol,
    });
    assert.equal(history.status, 403);
    assert.equal(history.body.error, "not a participant");

    // Carol cannot send into the conversation either.
    const carolWs = await connectWs(wsUrl(base, port, carol));
    try {
      const carolReceives = nextMessage(carolWs);
      carolWs.send(
        JSON.stringify({ type: "send", conversationId, text: "intruder" }),
      );
      const reply = await carolReceives;
      assert.equal(reply.type, "error");
      assert.equal(reply.error, "not a participant");
    } finally {
      carolWs.close();
    }

    // Alice (a participant) can read her own conversation.
    const ownHistory = await api(base, `/conversations/${conversationId}/messages`, {
      token: a,
    });
    assert.equal(ownHistory.status, 200);
    assert.equal(ownHistory.body.messages.length, 0);
  });
});

test("a message sent while the recipient is offline is still persisted", async () => {
  await withServer({}, async (base, port) => {
    const { a, b, conversationId } = await openConversation(
      base,
      "0909090909",
      "0910101010",
    );

    // Only the sender is online.
    const aliceWs = await connectWs(wsUrl(base, port, a));
    try {
      aliceWs.send(JSON.stringify({ type: "send", conversationId, text: "are you there?" }));
      // Give the server a tick to persist the message.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const history = await api(base, `/conversations/${conversationId}/messages`, {
        token: b,
      });
      assert.equal(history.status, 200);
      assert.equal(history.body.messages.length, 1);
      assert.equal(history.body.messages[0].text, "are you there?");
      assert.equal(history.body.messages[0].sender, "0909090909");
    } finally {
      aliceWs.close();
    }
  });
});
