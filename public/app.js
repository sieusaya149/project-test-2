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
