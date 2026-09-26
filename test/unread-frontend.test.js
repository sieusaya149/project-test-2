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
 * A tiny DOM shim with just enough surface for the Chats list (and the rest of
 * public/app.js) to run inside `node:vm` without a browser (ZALO-24).
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

/** Recursively finds the first descendant with the given className. */
function findClass(node, className) {
  if (node.className === className) return node;
  for (const child of node.children) {
    const found = findClass(child, className);
    if (found) return found;
  }
  return null;
}

function conversation(id, unreadCount) {
  return {
    id,
    type: "direct",
    name: undefined,
    participants: ["0981111111", "0982222222"],
    latestMessage: {
      id: `${id}-m`,
      kind: "text",
      text: "hi",
      createdAt: 1_700_000_000_000,
    },
    createdAt: 1_700_000_000_000,
    unreadCount,
  };
}

test("the Chats list renders an unread badge and updates it live", () => {
  const { sandbox, document } = loadApp();
  sandbox.localStorage.setItem("zalo.phone", "0981111111");
  const chat = sandbox.__zaloChat;

  chat.renderConversations([conversation("c-a", 2), conversation("c-b", 0)]);

  const list = document.getElementById("conversation-list");
  assert.equal(list.children.length, 2);

  const badgeA = findClass(list.children[0], "conversation-unread");
  const badgeB = findClass(list.children[1], "conversation-unread");
  assert.ok(badgeA, "conversation with unread messages should carry a badge");
  assert.equal(badgeA.hidden, false);
  assert.equal(badgeA.textContent, "2");
  assert.ok(badgeB, "every conversation should carry a badge element");
  assert.equal(badgeB.hidden, true);
  assert.equal(badgeB.textContent, "");

  // A live message for a conversation that is not open bumps its badge.
  chat.noteUnreadMessage({ conversationId: "c-b", sender: "0982222222" });
  assert.equal(badgeB.hidden, false);
  assert.equal(badgeB.textContent, "1");

  // Opening (marking read) clears the badge.
  chat.clearUnreadBadge("c-a");
  assert.equal(badgeA.hidden, true);
  assert.equal(badgeA.textContent, "");

  // A message arriving in the open conversation does not bump the badge.
  chat.currentConversation = { id: "c-a" };
  chat.noteUnreadMessage({ conversationId: "c-a", sender: "0982222222" });
  assert.equal(badgeA.hidden, true);
  assert.equal(badgeA.textContent, "");

  // Messages the caller wrote themselves never count as unread.
  chat.currentConversation = null;
  chat.noteUnreadMessage({ conversationId: "c-b", sender: "0981111111" });
  assert.equal(badgeB.textContent, "1");
});

test("buffered messages already counted are not double-counted", () => {
  const { sandbox, document } = loadApp();
  sandbox.localStorage.setItem("zalo.phone", "0981111111");
  const chat = sandbox.__zaloChat;

  const list = [
    conversation("c-a", 2),
  ];
  list[0].latestMessage = {
    id: "m5",
    seq: 5,
    kind: "text",
    text: "five",
    createdAt: 1_700_000_000_000,
  };
  chat.renderConversations(list);

  const badge = findClass(
    document.getElementById("conversation-list").children[0],
    "conversation-unread",
  );
  assert.equal(badge.textContent, "2");

  // A buffered message (seq <= the list's latest seq) was already in the count.
  chat.noteUnreadMessage({ conversationId: "c-a", sender: "0982222222", seq: 5 });
  assert.equal(badge.textContent, "2");

  // A genuinely new message (seq > the list's latest seq) bumps the badge.
  chat.noteUnreadMessage({ conversationId: "c-a", sender: "0982222222", seq: 6 });
  assert.equal(badge.textContent, "3");
  assert.equal(badge.hidden, false);
});
