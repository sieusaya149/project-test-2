import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const appJs = readFileSync(
  fileURLToPath(new URL("../public/app.js", import.meta.url)),
  "utf8",
);

/**
 * A tiny DOM shim with just enough surface for the chat window's message list
 * to run inside `node:vm` without a browser (ZALO-18).
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

/** Loads public/app.js into a fake browser environment (logged out). */
function loadApp() {
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

function message(id, seq, text) {
  return {
    id,
    seq,
    conversationId: "c1",
    sender: "0980000000",
    kind: "text",
    text,
  };
}

/** The rendered message text of a <li> (from its `.message-content` span). */
function contentText(li) {
  const content = li.children.find((c) => c.className === "message-content");
  return content ? content.textContent : "";
}

test("the chat window orders history by seq and drops duplicates", () => {
  const { sandbox, document } = loadApp();
  const chat = sandbox.__zaloChat;
  chat.currentConversation = { id: "c1" };

  // Newest-first history, plus a message the client already holds, must come
  // out oldest-first and exactly once.
  chat.renderMessages([
    message("m3", 3, "third"),
    message("m1", 1, "first"),
    message("m2", 2, "second"),
    message("m2", 2, "second"), // duplicate
  ]);

  const list = document.getElementById("message-list");
  assert.deepEqual(
    list.children.map((li) => Number(li.dataset.seq)),
    [1, 2, 3],
    "messages must be ordered by seq",
  );
  assert.deepEqual(list.children.map(contentText), ["first", "second", "third"]);
});

test("live messages arriving out of order are inserted by seq", () => {
  const { sandbox, document } = loadApp();
  const chat = sandbox.__zaloChat;
  chat.currentConversation = { id: "c1" };

  chat.renderMessages([message("m1", 1, "first"), message("m3", 3, "third")]);

  // A reconnect delivers the buffered m2 after m3 and re-sends m3 (duplicate).
  chat.appendMessage(message("m3", 3, "third"));
  chat.appendMessage(message("m2", 2, "second"));

  const list = document.getElementById("message-list");
  assert.deepEqual(
    list.children.map((li) => Number(li.dataset.seq)),
    [1, 2, 3],
    "live messages must be inserted in seq order",
  );
  assert.deepEqual(list.children.map(contentText), ["first", "second", "third"]);
  assert.equal(list.children.length, 3, "m3 must not be shown twice");
});

test("the first live message replaces the empty-state placeholder", () => {
  const { sandbox, document } = loadApp();
  const chat = sandbox.__zaloChat;
  chat.currentConversation = { id: "c1" };

  chat.renderMessages([]);
  const list = document.getElementById("message-list");
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].className, "message-empty");

  chat.appendMessage(message("m1", 1, "first"));
  assert.deepEqual(list.children.map(contentText), ["first"]);
  assert.equal(list.children.length, 1);
});
