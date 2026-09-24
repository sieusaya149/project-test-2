import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { MAX_IMAGE_BYTES, encodePng } from "../src/images.js";

// A well-known 1x1 RGBA PNG, used as an independent real-world fixture.
const PNG_1x1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

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

/** Builds a valid, hard-to-compress RGBA PNG of the given dimensions. */
function makeNoisePng(width, height) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      rgba[i] = (x * 2654435761 + y) & 0xff;
      rgba[i + 1] = (x * 40503 + y * 2246822519) & 0xff;
      rgba[i + 2] = (x + y * 97) & 0xff;
      rgba[i + 3] = 255;
    }
  }
  return encodePng(width, height, rgba);
}

async function uploadImage(base, token, bytes, contentType) {
  const headers = { "content-type": contentType };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/images`, { method: "POST", headers, body: bytes });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, body };
}

async function getImage(base, path, token) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, { headers });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, contentType: res.headers.get("content-type"), bytes };
}

test("an image uploads, serves full-size, and serves a smaller thumbnail", async () => {
  await withServer({}, async (base) => {
    const token = await register(base, "0951010101");
    const png = makeNoisePng(512, 512);

    const up = await uploadImage(base, token, png, "image/png");
    assert.equal(up.status, 201);
    assert.ok(up.body.id, "upload must return an id");
    assert.equal(up.body.mimeType, "image/png");
    assert.equal(up.body.size, png.length);
    assert.equal(up.body.width, 512);
    assert.equal(up.body.height, 512);
    assert.equal(up.body.url, `/images/${up.body.id}`);
    assert.equal(up.body.thumbnailUrl, `/images/${up.body.id}/thumbnail`);

    // Full-size image is served byte-for-byte.
    const full = await getImage(base, up.body.url, token);
    assert.equal(full.status, 200);
    assert.equal(full.contentType, "image/png");
    assert.deepEqual(full.bytes, png);

    // The thumbnail is a real, downscaled PNG.
    const thumb = await getImage(base, up.body.thumbnailUrl, token);
    assert.equal(thumb.status, 200);
    assert.equal(thumb.contentType, "image/png");
    assert.ok(
      thumb.bytes.length < png.length,
      `thumbnail (${thumb.bytes.length}b) must be smaller than the original (${png.length}b)`,
    );
  });
});

test("a small image serves itself as its own thumbnail", async () => {
  await withServer({}, async (base) => {
    const token = await register(base, "0952020202");
    const one = Buffer.from(PNG_1x1_BASE64, "base64");

    const up = await uploadImage(base, token, one, "image/png");
    assert.equal(up.status, 201);
    assert.equal(up.body.width, 1);
    assert.equal(up.body.height, 1);

    const thumb = await getImage(base, up.body.thumbnailUrl, token);
    assert.equal(thumb.status, 200);
    assert.deepEqual(thumb.bytes, one, "a tiny image is already a thumbnail");
  });
});

test("unsupported formats are rejected with a clear error", async () => {
  await withServer({}, async (base) => {
    const token = await register(base, "0953030303");
    for (const type of [
      "text/plain",
      "image/svg+xml",
      "image/bmp",
      "application/octet-stream",
    ]) {
      const res = await uploadImage(base, token, Buffer.from("nope"), type);
      assert.equal(res.status, 415, `expected 415 for ${type}`);
      assert.match(res.body.error, /unsupported image type/);
      assert.match(res.body.error, /image\/png/);
    }
  });
});

test("bytes that do not match the declared content type are rejected", async () => {
  await withServer({}, async (base) => {
    const token = await register(base, "0954040404");
    const res = await uploadImage(base, token, Buffer.from("this is not a png"), "image/png");
    assert.equal(res.status, 415);
    assert.match(res.body.error, /do not match/);
  });
});

test("an empty body is rejected", async () => {
  await withServer({}, async (base) => {
    const token = await register(base, "0955050505");
    const res = await uploadImage(base, token, Buffer.alloc(0), "image/png");
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "image body is empty");
  });
});

test("images over 20 MB are rejected", async () => {
  await withServer({}, async (base) => {
    const token = await register(base, "0956060606");
    const big = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    const res = await uploadImage(base, token, big, "image/png");
    assert.equal(res.status, 413);
    assert.match(res.body.error, /20 MB/);
  });
});

test("uploading and serving images require authentication", async () => {
  await withServer({}, async (base) => {
    const png = makeNoisePng(8, 8);
    const noAuthUpload = await uploadImage(base, null, png, "image/png");
    assert.equal(noAuthUpload.status, 401);

    const noAuthGet = await getImage(base, "/images/whatever", null);
    assert.equal(noAuthGet.status, 401);
  });
});

test("an image can be sent in a 1-1 chat and is persisted", async () => {
  await withServer({}, async (base, port) => {
    const { a, b, conversationId } = await openConversation(
      base,
      "0957070707",
      "0958080808",
    );

    const png = makeNoisePng(256, 256);
    const up = await uploadImage(base, a, png, "image/png");
    assert.equal(up.status, 201);

    const aliceWs = await connectWs(wsUrl(base, port, a));
    const bobWs = await connectWs(wsUrl(base, port, b));
    try {
      const bobReceives = nextMessage(bobWs);
      aliceWs.send(
        JSON.stringify({ type: "image", conversationId, imageId: up.body.id }),
      );
      const received = await bobReceives;

      assert.equal(received.type, "message");
      assert.equal(received.message.kind, "image");
      assert.equal(received.message.sender, "0957070707");
      assert.equal(received.message.image.id, up.body.id);
      assert.equal(received.message.image.mimeType, "image/png");
      assert.equal(received.message.image.width, 256);
      assert.equal(received.message.image.height, 256);
      assert.equal(received.message.image.url, `/images/${up.body.id}`);
      assert.equal(
        received.message.image.thumbnailUrl,
        `/images/${up.body.id}/thumbnail`,
      );

      // Image messages are persisted and readable from history.
      const history = await api(base, `/conversations/${conversationId}/messages`, {
        token: b,
      });
      assert.equal(history.status, 200);
      assert.equal(history.body.messages.length, 1);
      assert.equal(history.body.messages[0].kind, "image");
      assert.equal(history.body.messages[0].image.id, up.body.id);

      // A bogus image id is reported as an error.
      const aliceErr = nextError(aliceWs);
      aliceWs.send(
        JSON.stringify({ type: "image", conversationId, imageId: "nope" }),
      );
      assert.equal((await aliceErr).error, "image not found");
    } finally {
      aliceWs.close();
      bobWs.close();
    }
  });
});

test("an image can be sent in a group chat to every other member", async () => {
  await withServer({}, async (base, port) => {
    const alice = await register(base, "0961010101");
    const bob = await register(base, "0962020202");
    const carol = await register(base, "0963030303");
    await befriend(base, alice, "0961010101", bob, "0962020202");
    await befriend(base, alice, "0961010101", carol, "0963030303");

    const created = await api(base, "/groups", {
      method: "POST",
      token: alice,
      body: { name: "trio", members: ["0962020202", "0963030303"] },
    });
    assert.equal(created.status, 201);
    const id = created.body.id;

    const png = makeNoisePng(300, 200);
    const up = await uploadImage(base, bob, png, "image/png");
    assert.equal(up.status, 201);

    const aliceWs = await connectWs(wsUrl(base, port, alice));
    const bobWs = await connectWs(wsUrl(base, port, bob));
    const carolWs = await connectWs(wsUrl(base, port, carol));
    try {
      const aliceReceives = nextMessage(aliceWs);
      const carolReceives = nextMessage(carolWs);
      bobWs.send(JSON.stringify({ type: "image", conversationId: id, imageId: up.body.id }));

      const [toAlice, toCarol] = await Promise.all([aliceReceives, carolReceives]);
      assert.equal(toAlice.type, "message");
      assert.equal(toAlice.message.kind, "image");
      assert.equal(toAlice.message.image.id, up.body.id);
      assert.equal(toAlice.message.sender, "0962020202");
      assert.equal(toCarol.message.kind, "image");
      assert.equal(toCarol.message.image.id, up.body.id);

      // Every member can read the image message from history.
      const history = await api(base, `/conversations/${id}/messages`, {
        token: alice,
      });
      assert.equal(history.status, 200);
      assert.equal(history.body.messages.length, 1);
      assert.equal(history.body.messages[0].image.id, up.body.id);
    } finally {
      aliceWs.close();
      bobWs.close();
      carolWs.close();
    }
  });
});
