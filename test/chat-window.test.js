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

test("GET / serves the chat window with a message box and history list", async () => {
  const server = createApp().listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.equal(body, indexHtml);
    for (const needle of [
      'id="message-form"',
      'id="message-input"',
      'id="message-list"',
      "Send",
    ]) {
      assert.ok(body.includes(needle), `chat window should contain ${needle}`);
    }
  } finally {
    server.close();
  }
});

test("the frontend script sends and receives messages over the WebSocket", async () => {
  const server = createApp().listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/app.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/javascript/);
    const body = await res.text();
    assert.equal(body, appJs);
    for (const needle of [
      "/ws",
      "WebSocket",
      'type: "send"',
      "conversationId",
      "/conversations/",
      'parsed.type === "message"',
      'parsed.type === "status"',
    ]) {
      assert.ok(body.includes(needle), `script should reference ${needle}`);
    }
  } finally {
    server.close();
  }
});
