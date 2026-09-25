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
    if (target === "friends") loadFriendsPage();
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
  connectSocket();
  loadConversations();
}

function showLoggedOut() {
  closeSocket();
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
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message-input");

let currentConversation = null;
let socket = null;
const renderedMessageIds = new Set();

// Opens (or reuses) one WebSocket per logged-in session so this tab receives
// live messages without reloading. `socket` keeps the current connection.
function connectSocket() {
  const token = getToken();
  if (!token) return;
  if (
    socket &&
    (socket.readyState === WebSocket.CONNECTING ||
      socket.readyState === WebSocket.OPEN)
  ) {
    return;
  }
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${scheme}//${location.host}/ws?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(url);
  socket = ws;
  ws.addEventListener("message", (event) => {
    let parsed;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }
    handleSocketEvent(parsed);
  });
  ws.addEventListener("close", () => {
    if (socket === ws) socket = null;
  });
}

function closeSocket() {
  const ws = socket;
  socket = null;
  if (!ws) return;
  try {
    ws.close();
  } catch {
    /* ignore */
  }
}

function handleSocketEvent(parsed) {
  if (!parsed || typeof parsed !== "object") return;
  if (parsed.type === "message") {
    appendMessage(parsed.message);
  } else if (parsed.type === "status") {
    // The sender's own message is confirmed via a `status` acknowledgement,
    // so show it in the thread once the server has accepted it.
    if (parsed.message && parsed.message.sender === getPhone()) {
      appendMessage(parsed.message);
    }
  }
}

function appendMessage(message) {
  if (!message || !message.id) return;
  if (!currentConversation || message.conversationId !== currentConversation.id) {
    return;
  }
  if (renderedMessageIds.has(message.id)) return;
  renderedMessageIds.add(message.id);
  messageList.appendChild(renderMessageItem(message));
}

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
  currentConversation = null;
  chatsLoggedOut.hidden = false;
  chatsListView.hidden = true;
  chatView.hidden = true;
  conversationList.replaceChildren();
  messageList.replaceChildren();
  renderedMessageIds.clear();
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
  currentConversation = null;
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
  currentConversation = conversation;
  const res = await fetch(`/conversations/${conversation.id}/messages`, {
    headers: tokenHeader(),
  });
  if (res.status !== 200) {
    currentConversation = null;
    // The conversation is gone (or we were signed out): refresh the list.
    loadConversations();
    return;
  }
  const body = await res.json();
  chatTitle.textContent = conversationTitle(conversation);
  chatsLoggedOut.hidden = true;
  chatsListView.hidden = true;
  chatView.hidden = false;
  messageInput.value = "";
  renderMessages(body.messages ?? []);
  connectSocket();
  messageInput.focus();
}

function renderMessageItem(message) {
  const li = document.createElement("li");
  li.className = "message";

  const sender = document.createElement("span");
  sender.className = "message-sender";
  sender.textContent = message.sender;

  const content = document.createElement("span");
  content.className = "message-content";
  content.textContent = message.kind === "image" ? "📷 Photo" : message.text;

  li.append(sender, content);
  return li;
}

function renderMessages(messages) {
  messageList.replaceChildren();
  renderedMessageIds.clear();
  if (messages.length === 0) {
    const empty = document.createElement("li");
    empty.className = "message-empty";
    empty.textContent = "No messages yet.";
    messageList.appendChild(empty);
    return;
  }
  // The API returns newest first; show oldest first in the thread.
  for (const message of [...messages].reverse()) {
    renderedMessageIds.add(message.id);
    messageList.appendChild(renderMessageItem(message));
  }
}

backToChatsButton.addEventListener("click", loadConversations);

messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !currentConversation) return;
  connectSocket();
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(
    JSON.stringify({
      type: "send",
      conversationId: currentConversation.id,
      text,
    }),
  );
  messageInput.value = "";
  messageInput.focus();
});

// ---- Friends page (ZALO-14) ----

const friendsLoginPrompt = document.getElementById("friends-login-prompt");
const friendsContent = document.getElementById("friends-content");
const friendRequestForm = document.getElementById("friend-request-form");
const friendPhoneInput = document.getElementById("friend-phone");
const friendRequestMessage = document.getElementById("friend-request-message");
const friendsList = document.getElementById("friends-list");
const requestsList = document.getElementById("requests-list");

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function getPhone() {
  return localStorage.getItem(PHONE_KEY);
}

async function authedFetch(url, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  headers.authorization = `Bearer ${getToken()}`;
  const res = await fetch(url, { ...options, headers });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON body.
  }
  return { status: res.status, body };
}

function showFriendRequestMessage(text, isError) {
  friendRequestMessage.textContent = text;
  friendRequestMessage.classList.toggle("is-error", Boolean(isError));
  friendRequestMessage.hidden = false;
}

function clearFriendRequestMessage() {
  friendRequestMessage.textContent = "";
  friendRequestMessage.classList.remove("is-error");
  friendRequestMessage.hidden = true;
}

function renderFriends(friends) {
  friendsList.innerHTML = "";
  if (friends.length === 0) {
    const li = document.createElement("li");
    li.className = "list-empty";
    li.textContent = "You have no friends yet.";
    friendsList.appendChild(li);
    return;
  }
  for (const phone of friends) {
    const li = document.createElement("li");
    li.className = "list-item";
    li.textContent = phone;
    friendsList.appendChild(li);
  }
}

function renderRequests(requests) {
  requestsList.innerHTML = "";
  if (requests.length === 0) {
    const li = document.createElement("li");
    li.className = "list-empty";
    li.textContent = "No incoming requests.";
    requestsList.appendChild(li);
    return;
  }
  for (const request of requests) {
    const li = document.createElement("li");
    li.className = "list-item request-item";

    const from = document.createElement("span");
    from.className = "request-from";
    from.textContent = request.from;
    li.appendChild(from);

    const actions = document.createElement("div");
    actions.className = "btn-row";

    const accept = document.createElement("button");
    accept.type = "button";
    accept.className = "btn btn-primary btn-small";
    accept.textContent = "Accept";
    accept.addEventListener("click", () => handleRequest(request.id, "accept"));
    actions.appendChild(accept);

    const decline = document.createElement("button");
    decline.type = "button";
    decline.className = "btn btn-ghost btn-small";
    decline.textContent = "Decline";
    decline.addEventListener("click", () => handleRequest(request.id, "decline"));
    actions.appendChild(decline);

    li.appendChild(actions);
    requestsList.appendChild(li);
  }
}

async function refreshFriends() {
  const { status, body } = await authedFetch("/friends");
  if (status === 401) return handleFriendsUnauthorized();
  if (status !== 200) return;
  renderFriends(body.friends ?? []);
}

async function refreshRequests() {
  const { status, body } = await authedFetch("/friends/requests");
  if (status === 401) return handleFriendsUnauthorized();
  if (status !== 200) return;
  renderRequests(body.requests ?? []);
}

function handleFriendsUnauthorized() {
  // The stored token is no longer valid: drop the session and ask to log in.
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(PHONE_KEY);
  showLoggedOut();
  friendsContent.hidden = true;
  friendsLoginPrompt.textContent = "Your session expired. Please log in again.";
  friendsLoginPrompt.hidden = false;
}

async function loadFriendsPage() {
  clearFriendRequestMessage();
  if (!getToken()) {
    friendsContent.hidden = true;
    friendsLoginPrompt.textContent = "Log in to see your friends.";
    friendsLoginPrompt.hidden = false;
    return;
  }
  friendsLoginPrompt.hidden = true;
  friendsContent.hidden = false;
  await Promise.all([refreshFriends(), refreshRequests()]);
}

async function handleRequest(id, action) {
  const { status, body } = await authedFetch(
    `/friends/requests/${id}/${action}`,
    { method: "POST" },
  );
  if (status === 401) return handleFriendsUnauthorized();
  if (status !== 200) {
    showFriendRequestMessage(
      body?.error ?? `Could not ${action} the request.`,
      true,
    );
    return;
  }
  // Accepting changes the friends list; declining removes the request.
  await Promise.all([refreshFriends(), refreshRequests()]);
}

friendRequestForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearFriendRequestMessage();
  const phone = friendPhoneInput.value.trim();
  if (!phone) return;
  const { status, body } = await authedFetch("/friends/requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone }),
  });
  if (status === 401) return handleFriendsUnauthorized();
  if (status === 201) {
    friendPhoneInput.value = "";
    showFriendRequestMessage("Friend request sent.", false);
  } else {
    showFriendRequestMessage(
      body?.error ?? "Could not send the friend request.",
      true,
    );
  }
});

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
