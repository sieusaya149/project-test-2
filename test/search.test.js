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
    (m) =>
      m.type === "status" &&
      m.message.status === "sent" &&
      m.message.text === text,
  );
  ws.send(JSON.stringify({ type: "send", conversationId, text }));
  await sent;
}

/** Sends every text and resolves once all "sent" acknowledgements arrived. */
async function sendMany(ws, conversationId, texts) {
  let remaining = texts.length;
  const all = waitFor(ws, (m) => {
    if (m.type === "status" && m.message.status === "sent") {
      remaining -= 1;
      if (remaining === 0) return true;
    }
    return false;
  });
  for (const text of texts) {
    ws.send(JSON.stringify({ type: "send", conversationId, text }));
  }
  await all;
}

test("search returns the caller's own matches, case-insensitive, newest first", async () => {
  await withServer({}, async (base, port) => {
    const { a, b, conversationId } = await openConversation(
      base,
      "0971111111",
      "0972222222",
    );

    const aliceWs = await connectWs(wsUrl(base, port, a));
    const bobWs = await connectWs(wsUrl(base, port, b));
    try {
      await sendMessage(aliceWs, conversationId, "hello world");
      await sendMessage(aliceWs, conversationId, "HELLO again");
      await sendMessage(bobWs, conversationId, "hello from bob");

      // Alice searches case-insensitively and sees only her own messages,
      // newest first (seq desc).
      const aliceRes = await api(
        base,
        `/conversations/${conversationId}/messages?q=HELLO`,
        { token: a },
      );
      assert.equal(aliceRes.status, 200);
      assert.deepEqual(
        aliceRes.body.messages.map((m) => m.text),
        ["HELLO again", "hello world"],
      );

      // Bob's own message is the only match on his side.
      const bobRes = await api(
        base,
        `/conversations/${conversationId}/messages?q=hello`,
        { token: b },
      );
      assert.equal(bobRes.status, 200);
      assert.deepEqual(
        bobRes.body.messages.map((m) => m.text),
        ["hello from bob"],
      );
    } finally {
      aliceWs.close();
      bobWs.close();
    }
  });
});

test("search with no matches returns an empty list", async () => {
  await withServer({}, async (base, port) => {
    const { a, conversationId } = await openConversation(
      base,
      "0973333333",
      "0974444444",
    );

    const aliceWs = await connectWs(wsUrl(base, port, a));
    try {
      await sendMessage(aliceWs, conversationId, "hello world");

      const res = await api(
        base,
        `/conversations/${conversationId}/messages?q=zzzz`,
        { token: a },
      );
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.messages, []);
    } finally {
      aliceWs.close();
    }
  });
});

test("a non-member cannot search a conversation", async () => {
  await withServer({}, async (base, port) => {
    const { a, conversationId } = await openConversation(
      base,
      "0975555555",
      "0976666666",
    );

    const aliceWs = await connectWs(wsUrl(base, port, a));
    try {
      await sendMessage(aliceWs, conversationId, "hello world");

      const carol = await register(base, "0977777777");
      const res = await api(
        base,
        `/conversations/${conversationId}/messages?q=hello`,
        { token: carol },
      );
      assert.equal(res.status, 403);
      assert.equal(res.body.error, "not a participant");
    } finally {
      aliceWs.close();
    }
  });
});

test("search returns at most 50 results", async () => {
  await withServer({}, async (base, port) => {
    const { a, conversationId } = await openConversation(
      base,
      "0978888888",
      "0979999999",
    );

    const aliceWs = await connectWs(wsUrl(base, port, a));
    try {
      const texts = Array.from({ length: 51 }, (_, i) => `match ${i}`);
      await sendMany(aliceWs, conversationId, texts);

      const res = await api(
        base,
        `/conversations/${conversationId}/messages?q=match`,
        { token: a },
      );
      assert.equal(res.status, 200);
      assert.equal(res.body.messages.length, 50);
      // Newest first: "match 50" down to "match 1".
      assert.equal(res.body.messages[0].text, "match 50");
      assert.equal(res.body.messages[49].text, "match 1");
    } finally {
      aliceWs.close();
    }
  });
});

test("the chat window serves a search box wired to the search endpoint", async () => {
  const server = createApp().listen(0);
  try {
    const { port } = server.address();

    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    for (const needle of [
      'id="search-form"',
      'id="search-input"',
      'name="q"',
      "Search",
    ]) {
      assert.ok(html.includes(needle), `chat window should contain ${needle}`);
    }

    const js = await (await fetch(`http://127.0.0.1:${port}/app.js`)).text();
    for (const needle of [
      "?q=",
      "search-input",
      "is-highlight",
      "encodeURIComponent",
      "scrollIntoView",
    ]) {
      assert.ok(js.includes(needle), `script should reference ${needle}`);
    }
  } finally {
    server.close();
  }
});
