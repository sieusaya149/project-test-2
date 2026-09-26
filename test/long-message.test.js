import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";

const stylesCss = readFileSync(
  fileURLToPath(new URL("../public/styles.css", import.meta.url)),
  "utf8",
);

// ---- helpers for exercising the WebSocket send path ----

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

async function openConversation(base, aPhone, bPhone) {
  const a = await register(base, aPhone);
  const b = await register(base, bPhone);
  const sent = await api(base, "/friends/requests", {
    method: "POST",
    token: a,
    body: { phone: bPhone },
  });
  assert.equal(sent.status, 201);
  await api(base, `/friends/requests/${sent.body.id}/accept`, {
    method: "POST",
    token: b,
  });
  const chat = await api(base, "/conversations", {
    method: "POST",
    token: a,
    body: { phone: bPhone },
  });
  assert.equal(chat.status, 201);
  return { a, b, conversationId: chat.body.id };
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

const nextError = (ws) => waitFor(ws, (m) => m.type === "error");
const nextStatus = (ws) => waitFor(ws, (m) => m.type === "status");

// ---- tests ----

test("a message over 4000 characters is refused with a clear error and not persisted", async () => {
  await withServer({}, async (base, port) => {
    const { a, conversationId } = await openConversation(base, "0971111111", "0972222222");

    const aliceWs = await connectWs(
      `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(a)}`,
    );
    try {
      // 4000 characters is the limit and must still be accepted.
      const acceptedStatus = nextStatus(aliceWs);
      aliceWs.send(
        JSON.stringify({
          type: "send",
          conversationId,
          text: "x".repeat(4000),
        }),
      );
      const accepted = await acceptedStatus;
      assert.equal(accepted.message.status, "sent");

      // One character more is refused with the clear error, back to the sender.
      const err = nextError(aliceWs);
      aliceWs.send(
        JSON.stringify({
          type: "send",
          conversationId,
          text: "x".repeat(4001),
        }),
      );
      assert.equal(
        (await err).error,
        "Message is too long (max 4000 characters)",
      );

      // Only the accepted message was persisted; the refused one never was.
      const history = await api(base, `/conversations/${conversationId}/messages`, {
        token: a,
      });
      assert.equal(history.status, 200);
      assert.equal(history.body.messages.length, 1);
      assert.equal(history.body.messages[0].text.length, 4000);
    } finally {
      aliceWs.close();
    }
  });
});

test("the chat stylesheet wraps long words inside the message bubble", () => {
  // Extract the body of every rule matching a selector (no nested braces in
  // this stylesheet), so we check the actual declarations, not just presence.
  function ruleBodies(css, selector) {
    const re = new RegExp(
      selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}",
      "g",
    );
    return [...css.matchAll(re)].map((m) => m[1]);
  }

  const contentBodies = ruleBodies(stylesCss, ".message-content");
  assert.ok(contentBodies.length > 0, ".message-content must exist");
  assert.ok(
    contentBodies.some(
      (body) =>
        /overflow-wrap\s*:\s*(anywhere|break-word)/.test(body) ||
        /word-break\s*:\s*break-word/.test(body),
    ),
    ".message-content must wrap long words (overflow-wrap/word-break)",
  );

  const messageBodies = ruleBodies(stylesCss, ".message");
  assert.ok(
    messageBodies.some((body) => /max-width\s*:\s*100%/.test(body)),
    ".message must constrain its width so a long word cannot stretch the window",
  );
});
