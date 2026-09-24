import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { signJwt } from "../src/jwt.js";

async function withServer(options, fn) {
  const server = createApp(options).listen(0);
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

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

async function request(base, path, { method = "GET", token, body } = {}) {
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

test("GET /users/lookup requires auth and finds a registered user", async () => {
  await withServer({}, async (base) => {
    const token = await register(base, "0901111111");

    const unauthenticated = await request(base, "/users/lookup?phone=0901111111");
    assert.equal(unauthenticated.status, 401);

    const found = await request(base, "/users/lookup?phone=0901111111", { token });
    assert.equal(found.status, 200);
    assert.equal(found.body.phone, "0901111111");
    assert.equal(typeof found.body.createdAt, "number");

    const missing = await request(base, "/users/lookup?phone=0909999999", { token });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, "user not found");

    const invalid = await request(base, "/users/lookup?phone=123", { token });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, "invalid phone number");
  });
});

test("friend request sent, accepted, then a 1-1 chat is allowed", async () => {
  await withServer({}, async (base) => {
    const alice = await register(base, "0902222222");
    const bob = await register(base, "0903333333");

    // Not friends yet: opening a conversation must be refused.
    const refused = await request(base, "/conversations", {
      method: "POST",
      token: alice,
      body: { phone: "0903333333" },
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, "can only start a chat with friends");

    // Alice sends a friend request to Bob.
    const sent = await request(base, "/friends/requests", {
      method: "POST",
      token: alice,
      body: { phone: "0903333333" },
    });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.from, "0902222222");
    assert.equal(sent.body.to, "0903333333");
    assert.equal(sent.body.status, "pending");

    // Bob sees the incoming request and accepts it.
    const inbox = await request(base, "/friends/requests", { token: bob });
    assert.equal(inbox.status, 200);
    assert.equal(inbox.body.requests.length, 1);
    assert.equal(inbox.body.requests[0].id, sent.body.id);

    const accepted = await request(
      base,
      `/friends/requests/${sent.body.id}/accept`,
      { method: "POST", token: bob },
    );
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.status, "accepted");

    // Now a conversation can be opened.
    const chat = await request(base, "/conversations", {
      method: "POST",
      token: alice,
      body: { phone: "0903333333" },
    });
    assert.equal(chat.status, 201);
    assert.ok(chat.body.id);
    assert.deepEqual(
      [...chat.body.participants].sort(),
      ["0902222222", "0903333333"],
    );

    // Reopening the same 1-1 chat is idempotent and returns the same one.
    const again = await request(base, "/conversations", {
      method: "POST",
      token: bob,
      body: { phone: "0902222222" },
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.id, chat.body.id);
  });
});

test("declining a friend request leaves the users unable to chat", async () => {
  await withServer({}, async (base) => {
    const alice = await register(base, "0904444444");
    const bob = await register(base, "0905555555");

    const sent = await request(base, "/friends/requests", {
      method: "POST",
      token: alice,
      body: { phone: "0905555555" },
    });
    assert.equal(sent.status, 201);

    const declined = await request(
      base,
      `/friends/requests/${sent.body.id}/decline`,
      { method: "POST", token: bob },
    );
    assert.equal(declined.status, 200);
    assert.equal(declined.body.status, "declined");

    const chat = await request(base, "/conversations", {
      method: "POST",
      token: alice,
      body: { phone: "0905555555" },
    });
    assert.equal(chat.status, 403);
  });
});

test("friend request validation: self, unknown, duplicate, wrong recipient", async () => {
  await withServer({}, async (base) => {
    const alice = await register(base, "0906666666");
    const bob = await register(base, "0907777777");

    const self = await request(base, "/friends/requests", {
      method: "POST",
      token: alice,
      body: { phone: "0906666666" },
    });
    assert.equal(self.status, 400);
    assert.equal(self.body.error, "cannot send a friend request to yourself");

    const unknown = await request(base, "/friends/requests", {
      method: "POST",
      token: alice,
      body: { phone: "0909999999" },
    });
    assert.equal(unknown.status, 404);

    const first = await request(base, "/friends/requests", {
      method: "POST",
      token: alice,
      body: { phone: "0907777777" },
    });
    assert.equal(first.status, 201);

    const duplicate = await request(base, "/friends/requests", {
      method: "POST",
      token: alice,
      body: { phone: "0907777777" },
    });
    assert.equal(duplicate.status, 409);

    // Bob cannot accept the request he himself sent (he is not the recipient).
    const wrongRecipient = await request(
      base,
      `/friends/requests/${first.body.id}/accept`,
      { method: "POST", token: alice },
    );
    assert.equal(wrongRecipient.status, 403);
  });
});

test("an expired, forged, or malformed token is rejected", async () => {
  await withServer({ jwtSecret: "test-secret" }, async (base) => {
    await register(base, "0908888888");

    const expired = signJwt(
      { sub: "0908888888", iat: 1, exp: 2 },
      "test-secret",
    );
    const expiredRes = await request(base, "/users/lookup?phone=0908888888", {
      token: expired,
    });
    assert.equal(expiredRes.status, 401);

    const forged = signJwt(
      { sub: "0908888888", iat: 1, exp: 4_000_000_000 },
      "wrong-secret",
    );
    const forgedRes = await request(base, "/users/lookup?phone=0908888888", {
      token: forged,
    });
    assert.equal(forgedRes.status, 401);

    const malformed = await request(base, "/users/lookup?phone=0908888888", {
      token: "not-a-jwt",
    });
    assert.equal(malformed.status, 401);
  });
});
