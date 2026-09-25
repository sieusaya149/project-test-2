// Minimal frontend shell: switch the visible panel from the nav, no framework.
const links = document.querySelectorAll(".nav-link");
const panels = {
  chats: document.getElementById("chats"),
  friends: document.getElementById("friends"),
  login: document.getElementById("login"),
};

for (const link of links) {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    const target = link.getAttribute("href").slice(1);

    for (const [name, panel] of Object.entries(panels)) {
      panel.hidden = name !== target;
    }

    for (const other of links) {
      other.classList.toggle("is-active", other === link);
    }

    if (target === "chats") loadConversations();
  });
}

// ---- Log in: phone → OTP → verify → JWT (ZALO-13) ----

const TOKEN_KEY = "zalo.token";
const PHONE_KEY = "zalo.phone";
// Mirrors the server's 15-minute lockout so we can tell the user when to retry.
const LOCKOUT_MS = 15 * 60 * 1000;

const phoneForm = document.getElementById("phone-form");
const codeForm = document.getElementById("code-form");
const phoneInput = document.getElementById("phone");
const codeInput = document.getElementById("code");
const codePhone = document.getElementById("code-phone");
const changePhoneButton = document.getElementById("change-phone");
const loginMessage = document.getElementById("login-message");
const devCodeHint = document.getElementById("dev-code-hint");
const devCodeValue = document.getElementById("dev-code-value");
const loginFormView = document.getElementById("login-form");
const loggedInView = document.getElementById("logged-in-view");
const loggedInPhone = document.getElementById("logged-in-phone");
const logoutButton = document.getElementById("logout");

let pendingPhone = null;

function showError(text) {
  loginMessage.textContent = text;
  loginMessage.classList.add("is-error");
  loginMessage.hidden = false;
}

function clearMessage() {
  loginMessage.textContent = "";
  loginMessage.classList.remove("is-error");
  loginMessage.hidden = true;
}

function showDevCode(code) {
  devCodeValue.textContent = code;
  devCodeHint.hidden = false;
}

function hideDevCode() {
  devCodeHint.hidden = true;
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // Ignore non-JSON error bodies.
  }
  return { status: res.status, body };
}

phoneForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessage();
  hideDevCode();
  const phone = phoneInput.value.trim();
  const { status, body } = await postJson("/auth/otp", { phone });
  if (status !== 200) {
    showError(body?.error ?? "Could not request a code.");
    return;
  }
  pendingPhone = phone;
  codePhone.textContent = phone;
  // There is no SMS provider yet, so the API returns the code in the response.
  // Surface it in the demo UI so the flow is usable end to end.
  showDevCode(body.code);
  phoneForm.hidden = true;
  codeForm.hidden = false;
  codeInput.value = "";
  codeInput.focus();
});

codeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessage();
  const code = codeInput.value.trim();
  const { status, body } = await postJson("/auth/verify", {
    phone: pendingPhone,
    code,
  });
  if (status !== 200) {
    const message = body?.error ?? "Could not verify the code.";
    // A locked-out phone can retry once the 15-minute lock expires: surface
    // that alongside the API's own message.
    if (status === 429) {
      const retryAt = new Date(Date.now() + LOCKOUT_MS);
      showError(
        `${message} You can try again after ${retryAt.toLocaleTimeString()}.`,
      );
    } else {
      showError(message);
    }
    return;
  }
  localStorage.setItem(TOKEN_KEY, body.token);
  localStorage.setItem(PHONE_KEY, body.phone);
  hideDevCode();
  showLoggedIn(body.phone);
  codeForm.hidden = true;
  phoneForm.hidden = false;
  codeInput.value = "";
  pendingPhone = null;
});

changePhoneButton.addEventListener("click", () => {
  clearMessage();
  hideDevCode();
  codeForm.hidden = true;
  phoneForm.hidden = false;
  codeInput.value = "";
  pendingPhone = null;
  phoneInput.focus();
});

logoutButton.addEventListener("click", () => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(PHONE_KEY);
  showLoggedOut();
});

function showLoggedIn(phone) {
  loggedInPhone.textContent = phone;
  loginFormView.hidden = true;
  loggedInView.hidden = false;
  loadConversations();
}

function showLoggedOut() {
  loggedInView.hidden = true;
  loginFormView.hidden = false;
  phoneForm.hidden = false;
  codeForm.hidden = true;
  clearMessage();
  hideDevCode();
  showChatsLoggedOut();
}

// ---- Chats: list conversations and open one (ZALO-15) ----

const chatsLoggedOut = document.getElementById("chats-logged-out");
const chatsListView = document.getElementById("chats-list-view");
const conversationList = document.getElementById("conversation-list");
const chatView = document.getElementById("chat-view");
const chatTitle = document.getElementById("chat-title");
const messageList = document.getElementById("message-list");
const backToChatsButton = document.getElementById("back-to-chats");

function tokenHeader() {
  const token = localStorage.getItem(TOKEN_KEY);
  return token ? { authorization: `Bearer ${token}` } : {};
}

function conversationTitle(conversation) {
  if (conversation.type === "group") {
    return conversation.name || conversation.participants.join(", ");
  }
  const me = localStorage.getItem(PHONE_KEY);
  return (
    conversation.participants.find((p) => p !== me) ??
    conversation.participants[0] ??
    "Conversation"
  );
}

function messagePreview(message) {
  if (!message) return "No messages yet";
  return message.kind === "image" ? "📷 Photo" : message.text;
}

function formatTime(timestamp) {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function showChatsLoggedOut() {
  chatsLoggedOut.hidden = false;
  chatsListView.hidden = true;
  chatView.hidden = true;
  conversationList.replaceChildren();
  messageList.replaceChildren();
}

async function loadConversations() {
  if (!localStorage.getItem(TOKEN_KEY)) {
    showChatsLoggedOut();
    return;
  }
  const res = await fetch("/conversations", { headers: tokenHeader() });
  if (res.status !== 200) {
    showChatsLoggedOut();
    return;
  }
  const body = await res.json();
  renderConversations(body.conversations ?? []);
}

function renderConversations(conversations) {
  chatsLoggedOut.hidden = true;
  chatsListView.hidden = false;
  chatView.hidden = true;
  conversationList.replaceChildren();

  if (conversations.length === 0) {
    const empty = document.createElement("li");
    empty.className = "conversation-empty";
    empty.textContent = "No conversations yet.";
    conversationList.appendChild(empty);
    return;
  }

  for (const conversation of conversations) {
    const li = document.createElement("li");
    li.className = "conversation-item";
    li.tabIndex = 0;
    li.setAttribute("role", "button");

    const title = document.createElement("span");
    title.className = "conversation-title";
    title.textContent = conversationTitle(conversation);

    const preview = document.createElement("span");
    preview.className = "conversation-preview";
    preview.textContent = messagePreview(conversation.latestMessage);

    const time = document.createElement("span");
    time.className = "conversation-time";
    time.textContent = formatTime(
      conversation.latestMessage?.createdAt ?? conversation.createdAt,
    );

    li.append(title, preview, time);
    li.addEventListener("click", () => openConversation(conversation));
    conversationList.appendChild(li);
  }
}

async function openConversation(conversation) {
  const res = await fetch(`/conversations/${conversation.id}/messages`, {
    headers: tokenHeader(),
  });
  if (res.status !== 200) {
    // The conversation is gone (or we were signed out): refresh the list.
    loadConversations();
    return;
  }
  const body = await res.json();
  chatTitle.textContent = conversationTitle(conversation);
  chatsLoggedOut.hidden = true;
  chatsListView.hidden = true;
  chatView.hidden = false;
  renderMessages(body.messages ?? []);
}

function renderMessages(messages) {
  messageList.replaceChildren();
  if (messages.length === 0) {
    const empty = document.createElement("li");
    empty.className = "message-empty";
    empty.textContent = "No messages yet.";
    messageList.appendChild(empty);
    return;
  }
  // The API returns newest first; show oldest first in the thread.
  for (const message of [...messages].reverse()) {
    const li = document.createElement("li");
    li.className = "message";

    const sender = document.createElement("span");
    sender.className = "message-sender";
    sender.textContent = message.sender;

    const content = document.createElement("span");
    content.className = "message-content";
    content.textContent = message.kind === "image" ? "📷 Photo" : message.text;

    li.append(sender, content);
    messageList.appendChild(li);
  }
}

backToChatsButton.addEventListener("click", loadConversations);

// Restore a stored session (or start logged out) on page load.
(function restoreSession() {
  const token = localStorage.getItem(TOKEN_KEY);
  const phone = localStorage.getItem(PHONE_KEY);
  if (token && phone) {
    showLoggedIn(phone);
  } else {
    showLoggedOut();
  }
})();
