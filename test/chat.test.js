import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

/** Registers a phone number via the ZALO-2 OTP flow and returns its JWT. */
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

async function jsonRequest(base, path, { method = "GET", token, body } = {}) {
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

/** Registers two users, makes them friends, and returns their tokens. */
async function twoFriends(base, aPhone, bPhone) {
  const tokenA = await register(base, aPhone);
  const tokenB = await register(base, bPhone);
  const sent = await jsonRequest(base, "/friends/requests", {
    method: "POST",
    token: tokenA,
    body: { phone: bPhone },
  });
  assert.equal(sent.status, 201);
  const accepted = await jsonRequest(
    base,
    `/friends/requests/${sent.body.id}/accept`,
    { method: "POST", token: tokenB },
  );
  assert.equal(accepted.status, 200);
  return { tokenA, tokenB };
}

async function withServer(options, fn) {
  const server = createApp(options).listen(0);
  const clients = new Set();
  try {
    const { port } = server.address();
    const ctx = {
      base: `http://127.0.0.1:${port}`,
      wsBase: `ws://127.0.0.1:${port}`,
      track: (ws) => clients.add(ws),
    };
    await fn(ctx);
  } finally {
    for (const ws of clients) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Opens a WebSocket as `token`, resolving on the `open` event. */
function connectWs(ctx, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${ctx.wsBase}/ws?token=${token}`);
    const messages = [];
    ctx.track(ws);
    ws.addEventListener("open", () => resolve({ ws, messages }));
    ws.addEventListener("message", (event) =>
      messages.push({ data: event.data, at: Date.now() }),
    );
    ws.addEventListener("error", () => reject(new Error("WebSocket error")));
  });
}

function parse(event) {
  return JSON.parse(event.data);
}

/** Polls `messages` until `predicate` matches, resolving with the elapsed ms. */
function waitFor(messages, predicate, { timeoutMs = 3000 } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      const found = messages.find(predicate);
      if (found) return resolve({ event: found, elapsedMs: Date.now() - started });
      if (Date.now() - started > timeoutMs) {
        return reject(new Error("timed out waiting for a message"));
      }
      setTimeout(poll, 2);
    })();
  });
}

test("a text message is pushed to an online friend and persisted", async () => {
  await withServer({}, async (ctx) => {
    const { tokenA, tokenB } = await twoFriends(ctx.base, "0901111111", "0902222222");
    const chat = await jsonRequest(ctx.base, "/conversations", {
      method: "POST",
      token: tokenA,
      body: { phone: "0902222222" },
    });
    assert.equal(chat.status, 201);
    const conversationId = chat.body.id;

    const bob = await connectWs(ctx, tokenB);
    const alice = await connectWs(ctx, tokenA);

    const sentAt = Date.now();
    alice.ws.send(
      JSON.stringify({ type: "message", conversationId, text: "hello bob" }),
    );

    // Real-time delivery: Bob receives it over the socket (no polling).
    const { event, elapsedMs } = await waitFor(bob.messages, (m) => {
      try {
        return parse(m).message?.text === "hello bob";
      } catch {
        return false;
      }
    });
    assert.ok(elapsedMs < 1000, `delivery took ${elapsedMs}ms`);

    const delivered = parse(event).message;
    assert.equal(delivered.sender, "0901111111");
    assert.equal(delivered.text, "hello bob");
    assert.equal(delivered.conversationId, conversationId);
    assert.equal(typeof delivered.id, "string");
    assert.equal(typeof delivered.sentAt, "number");
    assert.ok(delivered.sentAt >= sentAt);

    // The sender also gets an echo back (the canonical, persisted record).
    await waitFor(alice.messages, (m) => {
      try {
        return parse(m).message?.text === "hello bob";
      } catch {
        return false;
      }
    });

    // Persistence: the message is loadable via the history endpoint.
    const history = await jsonRequest(
      ctx.base,
      `/conversations/${conversationId}/messages`,
      { token: tokenB },
    );
    assert.equal(history.status, 200);
    assert.equal(history.body.messages.length, 1);
    assert.equal(history.body.messages[0].text, "hello bob");
    assert.equal(history.body.messages[0].sender, "0901111111");
  });
});

test("GET /conversations/:id/messages paginates oldest-first", async () => {
  await withServer({}, async (ctx) => {
    const { tokenA } = await twoFriends(ctx.base, "0903333333", "0904444444");
    const chat = await jsonRequest(ctx.base, "/conversations", {
      method: "POST",
      token: tokenA,
      body: { phone: "0904444444" },
    });
    const conversationId = chat.body.id;

    const alice = await connectWs(ctx, tokenA);
    for (let i = 1; i <= 7; i++) {
      alice.ws.send(
        JSON.stringify({ type: "message", conversationId, text: `m${i}` }),
      );
      await waitFor(alice.messages, (m) => {
        try {
          return parse(m).message?.text === `m${i}`;
        } catch {
          return false;
        }
      });
    }

    const page1 = await jsonRequest(
      ctx.base,
      `/conversations/${conversationId}/messages?limit=3`,
      { token: tokenA },
    );
    assert.equal(page1.status, 200);
    assert.deepEqual(
      page1.body.messages.map((m) => m.text),
      ["m5", "m6", "m7"],
    );
    assert.equal(page1.body.hasMore, true);
    assert.equal(page1.body.nextCursor, "5");

    const page2 = await jsonRequest(
      ctx.base,
      `/conversations/${conversationId}/messages?limit=3&before=${page1.body.nextCursor}`,
      { token: tokenA },
    );
    assert.deepEqual(
      page2.body.messages.map((m) => m.text),
      ["m2", "m3", "m4"],
    );
    assert.equal(page2.body.hasMore, true);
    assert.equal(page2.body.nextCursor, "2");

    const page3 = await jsonRequest(
      ctx.base,
      `/conversations/${conversationId}/messages?limit=3&before=${page2.body.nextCursor}`,
      { token: tokenA },
    );
    assert.deepEqual(
      page3.body.messages.map((m) => m.text),
      ["m1"],
    );
    assert.equal(page3.body.hasMore, false);
    assert.equal(page3.body.nextCursor, null);
  });
});

test("history endpoint enforces auth, membership and existence", async () => {
  await withServer({}, async (ctx) => {
    const { tokenA } = await twoFriends(ctx.base, "0905555555", "0906666666");
    const stranger = await register(ctx.base, "0907777777");
    const chat = await jsonRequest(ctx.base, "/conversations", {
      method: "POST",
      token: tokenA,
      body: { phone: "0906666666" },
    });
    const conversationId = chat.body.id;

    const unauth = await jsonRequest(
      ctx.base,
      `/conversations/${conversationId}/messages`,
    );
    assert.equal(unauth.status, 401);

    const outsider = await jsonRequest(
      ctx.base,
      `/conversations/${conversationId}/messages`,
      { token: stranger },
    );
    assert.equal(outsider.status, 403);

    const missing = await jsonRequest(
      ctx.base,
      "/conversations/nope/messages",
      { token: tokenA },
    );
    assert.equal(missing.status, 404);
  });
});

test("a non-participant cannot send over the socket", async () => {
  await withServer({}, async (ctx) => {
    const { tokenA } = await twoFriends(ctx.base, "0908888888", "0909999999");
    const stranger = await register(ctx.base, "0900000000");
    const chat = await jsonRequest(ctx.base, "/conversations", {
      method: "POST",
      token: tokenA,
      body: { phone: "0909999999" },
    });
    const conversationId = chat.body.id;

    const intruder = await connectWs(ctx, stranger);
    intruder.ws.send(
      JSON.stringify({ type: "message", conversationId, text: "hi" }),
    );
    const { event } = await waitFor(intruder.messages, (m) => {
      try {
        return parse(m).type === "error";
      } catch {
        return false;
      }
    });
    assert.equal(parse(event).error, "not a participant");
  });
});

test("the WebSocket endpoint rejects a missing or invalid token", async () => {
  await withServer({}, async (ctx) => {
    const outcome = await new Promise((resolve) => {
      const ws = new WebSocket(`${ctx.wsBase}/ws?token=bogus`);
      ws.addEventListener("open", () => resolve("open"));
      ws.addEventListener("error", () => resolve("error"));
      ws.addEventListener("close", () => resolve("close"));
    });
    assert.notEqual(outcome, "open");
  });
});
