import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";

const indexHtml = readFileSync(
  fileURLToPath(new URL("../public/index.html", import.meta.url)),
  "utf8",
);
const stylesCss = readFileSync(
  fileURLToPath(new URL("../public/styles.css", import.meta.url)),
  "utf8",
);
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

/** Sends a raw GET request with an exact path (no client URL normalization). */
function rawGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "GET" },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("GET / serves public/index.html", async () => {
  const server = createApp().listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/html/);
    const body = await res.text();
    assert.equal(body, indexHtml);
    assert.match(body, /Zalo/);
    for (const label of ["Chats", "Friends", "Log in"]) {
      assert.ok(body.includes(label), `nav should contain "${label}"`);
    }
  } finally {
    server.close();
  }
});

test("a static file is served with the correct content type", async () => {
  const server = createApp().listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/styles.css`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/css/);
    assert.equal(await res.text(), stylesCss);
  } finally {
    server.close();
  }
});

test("a path-traversal request outside public/ is refused", async () => {
  const server = createApp().listen(0);
  try {
    const { port } = server.address();
    // %2e%2e%2f is an encoded ../ so the client does not normalize it away;
    // it decodes to /../package.json, which lives outside public/.
    const res = await rawGet(port, "/%2e%2e%2fpackage.json");
    assert.equal(res.status, 404);
    assert.equal(res.body.includes(pkg.name), false);
    assert.equal(res.body.includes('"name"'), false);
  } finally {
    server.close();
  }
});
