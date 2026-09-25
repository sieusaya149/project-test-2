import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createApp } from "../src/app.js";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

test("GET /api/version returns package name and version", async () => {
  const server = createApp().listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/version`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      name: pkg.name,
      version: pkg.version,
    });
  } finally {
    server.close();
  }
});

test("GET /api/version works with no auth header", async () => {
  const server = createApp().listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/version`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.name, pkg.name);
    assert.equal(body.version, pkg.version);
  } finally {
    server.close();
  }
});
