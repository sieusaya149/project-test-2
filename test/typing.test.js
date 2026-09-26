import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createApp } from "../src/app.js";

// ---- Backend helpers (mirrors chat.test.js / receipts.test.js) ----

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

const nextTyping = (ws) => waitFor(ws, (m) => m.type === "typing");
const nextError = (ws) => waitFor(ws, (m) => m.type === "error");

/** Fails if a `type` event arrives on `ws` within `ms` (asserts no echo). */
function expectNoEvent(ws, type, ms = 150) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      let parsed;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (parsed.type === type) {
        cleanup();
        reject(new Error(`unexpected ${type} event`));
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
    };
    ws.addEventListener("message", onMessage);
  });
}

test("a typing event is relayed to the other participant and never echoed", async () => {
  await withServer({}, async (base, port) => {
    const { a, b, conversationId } = await openConversation(
      base,
      "0981111111",
      "0982222222",
    );

    const aliceWs = await connectWs(wsUrl(base, port, a));
    const bobWs = await connectWs(wsUrl(base, port, b));
    try {
      const bobSees = nextTyping(bobWs);
      const aliceSeesNothing = expectNoEvent(aliceWs, "typing");
      aliceWs.send(
        JSON.stringify({ type: "typing", conversationId, isTyping: true }),
      );

      const [typing] = await Promise.all([bobSees, aliceSeesNothing]);
      assert.equal(typing.type, "typing");
      assert.equal(typing.conversationId, conversationId);
      assert.equal(typing.sender, "0981111111");
      assert.equal(typing.isTyping, true);
    } finally {
      aliceWs.close();
      bobWs.close();
    }
  });
});

test("a typing event is fanned out to every other group member except the sender", async () => {
  await withServer({}, async (base, port) => {
    const alice = await register(base, "0983333333");
    const bob = await register(base, "0984444444");
    const carol = await register(base, "0985555555");
    await befriend(base, alice, "0983333333", bob, "0984444444");
    await befriend(base, alice, "0983333333", carol, "0985555555");

    const created = await api(base, "/groups", {
      method: "POST",
      token: alice,
      body: { name: "trio", members: ["0984444444", "0985555555"] },
    });
    assert.equal(created.status, 201);
    const id = created.body.id;

    const aliceWs = await connectWs(wsUrl(base, port, alice));
    const bobWs = await connectWs(wsUrl(base, port, bob));
    const carolWs = await connectWs(wsUrl(base, port, carol));
    try {
      const bobSees = nextTyping(bobWs);
      const carolSees = nextTyping(carolWs);
      const aliceSeesNothing = expectNoEvent(aliceWs, "typing");
      aliceWs.send(JSON.stringify({ type: "typing", conversationId: id, isTyping: true }));

      const [toBob, toCarol] = await Promise.all([
        bobSees,
        carolSees,
        aliceSeesNothing,
      ]);
      assert.equal(toBob.sender, "0983333333");
      assert.equal(toBob.conversationId, id);
      assert.equal(toBob.isTyping, true);
      assert.equal(toCarol.sender, "0983333333");
      assert.equal(toCarol.conversationId, id);
    } finally {
      aliceWs.close();
      bobWs.close();
      carolWs.close();
    }
  });
});

test("a non-participant cannot send a typing event into a conversation", async () => {
  await withServer({}, async (base, port) => {
    const { conversationId } = await openConversation(
      base,
      "0986666666",
      "0987777777",
    );
    const stranger = await register(base, "0988888888");
    const strangerWs = await connectWs(wsUrl(base, port, stranger));
    try {
      const err = nextError(strangerWs);
      strangerWs.send(
        JSON.stringify({ type: "typing", conversationId, isTyping: true }),
      );
      assert.equal((await err).error, "not a participant");
    } finally {
      strangerWs.close();
    }
  });
});

// ---- Frontend throttle (loads public/app.js in node:vm) ----

const appJs = readFileSync(
  fileURLToPath(new URL("../public/app.js", import.meta.url)),
  "utf8",
);

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.hidden = false;
    this.textContent = "";
    this.value = "";
    this.className = "";
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
  set innerHTML(value) {
    this.textContent = value;
    this.replaceChildren();
  }
  get innerHTML() {
    return this.textContent;
  }
}

/**
 * Loads public/app.js with a fake clock, fake timers, and a recording fake
 * WebSocket so the throttle behaviour can be driven deterministically.
 */
function loadApp() {
  let fakeNow = 1_000_000;
  const sockets = [];
  const timers = [];
  let nextTimerId = 1;

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
  const sandbox = {
    document,
    location: { protocol: "http:", host: "localhost" },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
    WebSocket: class {
      static OPEN = 1;
      static CONNECTING = 0;
      constructor() {
        this.readyState = 1;
        this.sent = [];
        sockets.push(this);
      }
      addEventListener() {}
      send(data) {
        this.sent.push(data);
      }
      close() {}
    },
    fetch: async () => {
      throw new Error("fetch should not be called by this test");
    },
    Date: class extends Date {
      static now() {
        return fakeNow;
      }
    },
    setTimeout: (fn, delay) => {
      const id = nextTimerId++;
      timers.push({ id, fn, delay, cleared: false });
      return id;
    },
    clearTimeout: (id) => {
      const timer = timers.find((t) => t.id === id);
      if (timer) timer.cleared = true;
    },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(appJs, sandbox, { filename: "public/app.js" });

  return {
    sandbox,
    document,
    store,
    sockets,
    // Fires every scheduled (non-cancelled) timeout, simulating elapsed time.
    fireTimers() {
      for (const timer of timers) {
        if (timer.cleared) continue;
        timer.cleared = true;
        timer.fn();
      }
    },
  };
}

test("typing events from the chat input are throttled to one per 2s", () => {
  const app = loadApp();
  const chat = app.sandbox.__zaloChat;
  app.store.set("zalo.token", "tok");
  app.store.set("zalo.phone", "0989999999");
  chat.currentConversation = { id: "c1" };
  chat.connectSocket();
  const ws = app.sockets[0];

  // A burst of keystrokes inside the 2s window sends only the first event.
  chat.sendTyping();
  chat.sendTyping();
  chat.sendTyping();
  assert.equal(ws.sent.length, 1, "a typing burst must send exactly one event");
  assert.deepEqual(JSON.parse(ws.sent[0]), {
    type: "typing",
    conversationId: "c1",
    isTyping: true,
  });

  // Once the throttle window elapses, the trailing event is delivered.
  app.fireTimers();
  assert.equal(ws.sent.length, 2, "one trailing event after the 2s window");
  assert.deepEqual(JSON.parse(ws.sent[1]), {
    type: "typing",
    conversationId: "c1",
    isTyping: true,
  });
});

test("a received typing event shows and auto-clears the indicator", () => {
  const app = loadApp();
  const chat = app.sandbox.__zaloChat;
  const indicator = app.document.getElementById("typing-indicator");
  app.store.set("zalo.phone", "0989999999");
  chat.currentConversation = { id: "c1" };

  chat.showTypingIndicator({
    type: "typing",
    conversationId: "c1",
    sender: "0988888888",
    isTyping: true,
  });
  assert.equal(indicator.hidden, false);
  assert.equal(indicator.textContent, "0988888888 is typing…");

  app.fireTimers(); // 5s auto-clear timer fires
  assert.equal(indicator.hidden, true);
  assert.equal(indicator.textContent, "");
});
