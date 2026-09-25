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
}

function showLoggedOut() {
  loggedInView.hidden = true;
  loginFormView.hidden = false;
  phoneForm.hidden = false;
  codeForm.hidden = true;
  clearMessage();
  hideDevCode();
}

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
