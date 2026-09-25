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

test("GET / serves the log-in form (phone → code → verify → log out)", async () => {
  const server = createApp().listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.equal(body, indexHtml);
    for (const needle of [
      'id="phone-form"',
      'id="phone"',
      'id="code-form"',
      'id="code"',
      'id="logout"',
      "Request code",
      "Verify",
      "Log out",
    ]) {
      assert.ok(body.includes(needle), `log-in form should contain ${needle}`);
    }
  } finally {
    server.close();
  }
});

test("the frontend script drives the auth endpoints and stores the JWT", async () => {
  const server = createApp().listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/app.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/javascript/);
    const body = await res.text();
    assert.equal(body, appJs);
    for (const needle of [
      "/auth/otp",
      "/auth/verify",
      "localStorage",
      "zalo.token",
      "removeItem",
    ]) {
      assert.ok(body.includes(needle), `script should reference ${needle}`);
    }
  } finally {
    server.close();
  }
});
