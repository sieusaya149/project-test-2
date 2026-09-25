import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";

const indexHtml = readFileSync(
  fileURLToPath(new URL("../public/index.html", import.meta.url)),
  "utf8",
);
const appJs = readFileSync(
  fileURLToPath(new URL("../public/app.js", import.meta.url)),
  "utf8",
);

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

test("GET /friends requires auth", async () => {
  await withServer({}, async (base) => {
    const res = await request(base, "/friends");
    assert.equal(res.status, 401);
  });
});

test("GET /friends returns the caller's friends", async () => {
  await withServer({}, async (base) => {
    const alice = await register(base, "0901111111");
    const bob = await register(base, "0902222222");

    // No friends yet.
    const empty = await request(base, "/friends", { token: alice });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.friends, []);

    // Bob sends a request, Alice accepts, and both now see each other.
    const sent = await request(base, "/friends/requests", {
      method: "POST",
      token: bob,
      body: { phone: "0901111111" },
    });
    assert.equal(sent.status, 201);

    const accepted = await request(
      base,
      `/friends/requests/${sent.body.id}/accept`,
      { method: "POST", token: alice },
    );
    assert.equal(accepted.status, 200);

    assert.deepEqual(
      (await request(base, "/friends", { token: alice })).body.friends,
      ["0902222222"],
    );
    assert.deepEqual(
      (await request(base, "/friends", { token: bob })).body.friends,
      ["0901111111"],
    );
  });
});

test("GET / serves the Friends page (send box, friends list, requests)", async () => {
  const server = createApp().listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.equal(body, indexHtml);
    for (const needle of [
      'id="friend-request-form"',
      'id="friend-phone"',
      'id="friends-list"',
      'id="requests-list"',
      "Send request",
    ]) {
      assert.ok(body.includes(needle), `Friends page should contain ${needle}`);
    }
  } finally {
    server.close();
  }
});

test("the frontend script drives the friends endpoints", async () => {
  const server = createApp().listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/app.js`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.equal(body, appJs);
    for (const needle of [
      '"/friends"',
      '"/friends/requests"',
      "accept",
      "decline",
      "Bearer",
    ]) {
      assert.ok(body.includes(needle), `script should reference ${needle}`);
    }
  } finally {
    server.close();
  }
});
