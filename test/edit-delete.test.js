import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createApp } from "../src/app.js";

const appJs = readFileSync(
  fileURLToPath(new URL("../public/app.js", import.meta.url)),
  "utf8",
);

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

/** Resolves with the next parsed event matching `predicate`. */
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

/** Sends a text message from `ws` and resolves with its server-assigned id. */
async function sendText(ws, conversationId, text) {
  const sent = waitFor(
    ws,
    (m) => m.type === "status" && m.message.status === "sent",
  );
  ws.send(JSON.stringify({ type: "send", conversationId, text }));
  const event = await sent;
  return event.message.id;
}

// ---------------------------------------------------------------------------
// Backend: edit & delete over REST
// ---------------------------------------------------------------------------

test("editing then deleting my own message persists and masks the text", async () => {
  await withServer({}, async (base, port) => {
    const { a, b, conversationId } = await openConversation(
      base,
      "0911010101",
      "0912020202",
    );

    const aliceWs = await connectWs(wsUrl(base, port, a));
    const bobWs = await connectWs(wsUrl(base, port, b));
    try {
      const messageId = await sendText(aliceWs, conversationId, "hello");
      // Make sure Bob consumed the delivered message before we assert history.
      await nextMessage(bobWs);

      const edited = await api(
        base,
        `/conversations/${conversationId}/messages/${messageId}`,
        { method: "PATCH", token: a, body: { text: "hello, edited" } },
      );
      assert.equal(edited.status, 200);
      assert.equal(edited.body.edited, true);
      assert.equal(edited.body.text, "hello, edited");
      assert.equal(typeof edited.body.editedAt, "number");

      // The edit is persisted and visible to both participants.
      const history = await api(base, `/conversations/${conversationId}/messages`, {
        token: b,
      });
      assert.equal(history.status, 200);
      assert.equal(history.body.messages.length, 1);
      assert.equal(history.body.messages[0].text, "hello, edited");
      assert.equal(history.body.messages[0].edited, true);

      const deleted = await api(
        base,
        `/conversations/${conversationId}/messages/${messageId}`,
        { method: "DELETE", token: a },
      );
      assert.equal(deleted.status, 200);
      assert.equal(deleted.body.deleted, true);
      assert.equal(deleted.body.text, "", "deleted text must be masked");
      assert.equal(typeof deleted.body.deletedAt, "number");

      // Soft delete: the slot stays so ordering/history stays consistent, but
      // the original text is never served again.
      const after = await api(base, `/conversations/${conversationId}/messages`, {
        token: a,
      });
      assert.equal(after.body.messages.length, 1);
      assert.equal(after.body.messages[0].deleted, true);
      assert.equal(after.body.messages[0].text, "");

      // A deleted message can no longer be edited.
      const reEdit = await api(
        base,
        `/conversations/${conversationId}/messages/${messageId}`,
        { method: "PATCH", token: a, body: { text: "again" } },
      );
      assert.equal(reEdit.status, 409);
    } finally {
      aliceWs.close();
      bobWs.close();
    }
  });
});

test("editing someone else's message is refused, and missing/invalid targets fail", async () => {
  await withServer({}, async (base, port) => {
    const { a, b, conversationId } = await openConversation(
      base,
      "0913030303",
      "0914040404",
    );
    const stranger = await register(base, "0915050505");

    const aliceWs = await connectWs(wsUrl(base, port, a));
    const bobWs = await connectWs(wsUrl(base, port, b));
    try {
      const messageId = await sendText(aliceWs, conversationId, "mine");
      await nextMessage(bobWs);

      // Bob cannot edit or delete Alice's message.
      const bobEdit = await api(
        base,
        `/conversations/${conversationId}/messages/${messageId}`,
        { method: "PATCH", token: b, body: { text: "hijacked" } },
      );
      assert.equal(bobEdit.status, 403);
      assert.equal(bobEdit.body.error, "can only edit or delete your own messages");

      const bobDelete = await api(
        base,
        `/conversations/${conversationId}/messages/${messageId}`,
        { method: "DELETE", token: b },
      );
      assert.equal(bobDelete.status, 403);

      // A non-existent message is 404.
      const missing = await api(
        base,
        `/conversations/${conversationId}/messages/does-not-exist`,
        { method: "DELETE", token: a },
      );
      assert.equal(missing.status, 404);
      assert.equal(missing.body.error, "message not found");

      // A non-participant is refused even if the message exists.
      const strangerEdit = await api(
        base,
        `/conversations/${conversationId}/messages/${messageId}`,
        { method: "PATCH", token: stranger, body: { text: "intruder" } },
      );
      assert.equal(strangerEdit.status, 403);
      assert.equal(strangerEdit.body.error, "not a participant");

      // Authentication is required.
      const noAuth = await api(
        base,
        `/conversations/${conversationId}/messages/${messageId}`,
        { method: "PATCH", body: { text: "x" } },
      );
      assert.equal(noAuth.status, 401);

      // Empty/invalid text is refused.
      const empty = await api(
        base,
        `/conversations/${conversationId}/messages/${messageId}`,
        { method: "PATCH", token: a, body: { text: "   " } },
      );
      assert.equal(empty.status, 400);
    } finally {
      aliceWs.close();
      bobWs.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Backend: edits & deletes are pushed to the other side over the WebSocket
// ---------------------------------------------------------------------------

test("edits and deletes are pushed to the other participant over the socket", async () => {
  await withServer({}, async (base, port) => {
    const { a, b, conversationId } = await openConversation(
      base,
      "0916060606",
      "0917070707",
    );

    const aliceWs = await connectWs(wsUrl(base, port, a));
    const bobWs = await connectWs(wsUrl(base, port, b));
    try {
      const bobReceives = nextMessage(bobWs);
      const messageId = await sendText(aliceWs, conversationId, "original");
      const received = await bobReceives;
      assert.equal(received.message.id, messageId);

      // Edit -> Bob sees `message:edited` with the updated text.
      const editedEvent = waitFor(bobWs, (m) => m.type === "message:edited");
      const patch = await api(
        base,
        `/conversations/${conversationId}/messages/${messageId}`,
        { method: "PATCH", token: a, body: { text: "updated text" } },
      );
      assert.equal(patch.status, 200);
      const edited = await editedEvent;
      assert.equal(edited.type, "message:edited");
      assert.equal(edited.message.id, messageId);
      assert.equal(edited.message.text, "updated text");
      assert.equal(edited.message.edited, true);

      // Delete -> Bob sees `message:deleted` with the id.
      const deletedEvent = waitFor(bobWs, (m) => m.type === "message:deleted");
      const del = await api(
        base,
        `/conversations/${conversationId}/messages/${messageId}`,
        { method: "DELETE", token: a },
      );
      assert.equal(del.status, 200);
      const deleted = await deletedEvent;
      assert.equal(deleted.type, "message:deleted");
      assert.equal(deleted.conversationId, conversationId);
      assert.equal(deleted.messageId, messageId);
    } finally {
      aliceWs.close();
      bobWs.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Frontend: chat-window wiring
// ---------------------------------------------------------------------------

test("the frontend script wires edit/delete endpoints and live events", async () => {
  const server = createApp().listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/app.js`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.equal(body, appJs);
    for (const needle of [
      'method: "PATCH"',
      'method: "DELETE"',
      '"message:edited"',
      '"message:deleted"',
      "message deleted",
      "edited",
      '"Edit"',
      '"Delete"',
    ]) {
      assert.ok(body.includes(needle), `script should reference ${needle}`);
    }
  } finally {
    server.close();
  }
});

/**
 * A tiny DOM shim (mirroring `message-order.test.js`) with enough surface for
 * the chat window's message list to run inside `node:vm`.
 */
class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.hidden = false;
    this.textContent = "";
    this.value = "";
    this.className = "";
    this.type = "";
    this.dataset = {};
    this._classes = new Set();
    this._listeners = new Map();
  }
  get classList() {
    return {
      add: (...names) => names.forEach((n) => this._classes.add(n)),
      remove: (...names) => names.forEach((n) => this._classes.delete(n)),
      toggle: (name, force) => {
        if (force === undefined) {
          this._classes.has(name)
            ? this._classes.delete(name)
            : this._classes.add(name);
        } else if (force) {
          this._classes.add(name);
        } else {
          this._classes.delete(name);
        }
        return this._classes.has(name);
      },
      contains: (name) => this._classes.has(name),
    };
  }
  addEventListener(type, listener) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(listener);
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...children) {
    for (const child of children) this.appendChild(child);
  }
  insertBefore(child, before) {
    child.parentNode = this;
    const index = before ? this.children.indexOf(before) : -1;
    if (index === -1) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    for (const child of children) this.appendChild(child);
  }
  remove() {
    if (this.parentNode) {
      const index = this.parentNode.children.indexOf(this);
      if (index !== -1) this.parentNode.children.splice(index, 1);
      this.parentNode = null;
    }
  }
  setAttribute(name, value) {
    this.dataset[name] = String(value);
  }
  getAttribute(name) {
    return name in this.dataset ? this.dataset[name] : null;
  }
  focus() {}
}

/** Loads public/app.js into a fake browser (logged out, with a known phone). */
function loadApp(phone) {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement());
      return elements.get(id);
    },
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    querySelectorAll() {
      return [];
    },
  };
  const store = new Map();
  if (phone) store.set("zalo.phone", phone);
  const sandbox = {
    document,
    location: { protocol: "http:", host: "localhost" },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
    WebSocket: class {
      constructor() {
        this.readyState = 0;
      }
      addEventListener() {}
      send() {}
      close() {}
    },
    fetch: async () => {
      throw new Error("fetch should not be called by this test");
    },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(appJs, sandbox, { filename: "public/app.js" });
  return { sandbox, document };
}

function message(id, seq, overrides = {}) {
  return {
    id,
    seq,
    conversationId: "c1",
    sender: "0980000000",
    kind: "text",
    text: "hello",
    ...overrides,
  };
}

function contentText(li) {
  const content = li.children.find((c) => c.className === "message-content");
  return content ? content.textContent : "";
}

test("edited messages render an edited marker and deleted ones a placeholder", () => {
  const { sandbox, document } = loadApp("0980000000");
  const chat = sandbox.__zaloChat;
  chat.currentConversation = { id: "c1" };

  chat.renderMessages([
    message("m1", 1, { text: "updated", edited: true, editedAt: 123 }),
    message("m2", 2, { sender: "0981111111", text: "secret", deleted: true }),
  ]);

  const list = document.getElementById("message-list");
  assert.equal(list.children.length, 2);

  assert.equal(contentText(list.children[0]), "updated");
  assert.ok(
    list.children[0].children.some(
      (c) => c.className === "message-edited" && c.textContent === "edited",
    ),
    "edited message must carry an 'edited' marker",
  );

  assert.equal(contentText(list.children[1]), "message deleted");
  assert.ok(
    list.children[1].className.split(" ").includes("message-deleted"),
    "deleted message must show the placeholder, not the original text",
  );
});

test("only the user's own messages get edit/delete affordances", () => {
  const { sandbox, document } = loadApp("0980000000");
  const chat = sandbox.__zaloChat;
  chat.currentConversation = { id: "c1" };

  chat.renderMessages([
    message("m1", 1, { sender: "0980000000", text: "mine" }),
    message("m2", 2, { sender: "0981111111", text: "theirs" }),
  ]);

  const list = document.getElementById("message-list");
  const mine = list.children[0];
  const theirs = list.children[1];

  const actions = mine.children.find((c) => c.className === "message-actions");
  assert.ok(actions, "own message must have action buttons");
  assert.ok(
    actions.children.some((c) => c.textContent === "Edit"),
    "own message must have an Edit button",
  );
  assert.ok(
    actions.children.some((c) => c.textContent === "Delete"),
    "own message must have a Delete button",
  );

  assert.equal(
    theirs.children.find((c) => c.className === "message-actions"),
    undefined,
    "someone else's message must not expose actions",
  );
});

test("live edit/delete events update an already-rendered message in place", () => {
  const { sandbox, document } = loadApp("0980000000");
  const chat = sandbox.__zaloChat;
  chat.currentConversation = { id: "c1" };

  chat.renderMessages([message("m1", 1, { text: "hello" })]);
  const list = document.getElementById("message-list");

  chat.updateMessage(
    message("m1", 1, { text: "updated", edited: true, editedAt: 456 }),
  );
  assert.equal(list.children.length, 1);
  assert.equal(contentText(list.children[0]), "updated");
  assert.ok(
    list.children[0].children.some((c) => c.className === "message-edited"),
    "live edit must add the edited marker",
  );

  chat.markMessageDeleted("c1", "m1");
  assert.equal(list.children.length, 1);
  assert.equal(contentText(list.children[0]), "message deleted");
  assert.ok(
    list.children[0].className.split(" ").includes("message-deleted"),
    "live delete must replace the message with the placeholder",
  );
});
