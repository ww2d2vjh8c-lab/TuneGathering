import { escapeHtml, getUsername, randomRoomId, setUsername } from "./common.js";

const TIPS = [
  "Put every device on the same Wi-Fi network for the tightest sync.",
  "Chrome gives the most accurate timing. Safari works too.",
  "Turn on spatial audio and let the sound orbit around your crew.",
  "Hear an echo? Open Settings in the room and nudge your device's timing.",
  "The Sync Check click track makes it easy to hear if devices line up.",
  "Anyone with the 6-digit code can join. Admins can lock the controls.",
];

const codeInput = document.getElementById("room-code");
const boxes = [...document.querySelectorAll("#code-boxes span")];
const joinBtn = document.getElementById("join-btn");
const nameBtn = document.getElementById("name-btn");

const goToRoom = (id) => (window.location.href = `/room/${id}`);

nameBtn.textContent = getUsername();
nameBtn.addEventListener("click", () => {
  const next = window.prompt("Your display name", getUsername())?.trim();
  if (next) {
    setUsername(next.slice(0, 32));
    nameBtn.textContent = getUsername();
  }
});

function renderCode() {
  const v = codeInput.value;
  const focused = document.activeElement === codeInput;
  boxes.forEach((box, i) => {
    box.textContent = v[i] ?? "";
    box.classList.toggle("filled", i < v.length);
    box.classList.toggle("cursor", focused && i === Math.min(v.length, 5));
  });
  joinBtn.disabled = v.length !== 6;
}

codeInput.addEventListener("input", () => {
  codeInput.value = codeInput.value.replace(/\D/g, "").slice(0, 6);
  renderCode();
  if (codeInput.value.length === 6) goToRoom(codeInput.value);
});
codeInput.addEventListener("focus", renderCode);
codeInput.addEventListener("blur", renderCode);

document.getElementById("join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (/^\d{6}$/.test(codeInput.value)) goToRoom(codeInput.value);
});

document.getElementById("create-btn").addEventListener("click", () => goToRoom(randomRoomId()));

async function loadActiveRooms() {
  try {
    const res = await fetch("/api/rooms");
    const { rooms } = await res.json();
    const total = rooms.reduce((n, r) => n + r.listeners, 0);
    document.getElementById("live-count").textContent = total ? `${total} online` : "";
    document.getElementById("corner-text").textContent = rooms.length ? `${rooms.length} sessions live` : "Online";
    document.getElementById("room-list").innerHTML = rooms.length
      ? rooms
          .map(
            (r) => `
        <li>
          <a class="menu-item" href="/room/${r.id}">
            <span>${r.id} <span class="meta">${r.isPlaying ? `<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span> ${escapeHtml(r.nowPlaying ?? "Playing")}` : "Idle"}</span></span>
            <span class="meta">${r.listeners}/∞</span>
          </a>
        </li>`
          )
          .join("")
      : `<li class="session-empty">No sessions running. Start one and share the code.</li>`;
  } catch {
    /* server unreachable — keep the last list */
  }
}

let tipIndex = Math.floor(Math.random() * TIPS.length);
const tipEl = document.getElementById("tip");
function rotateTip() {
  tipEl.style.opacity = 0;
  setTimeout(() => {
    tipEl.textContent = TIPS[tipIndex++ % TIPS.length];
    tipEl.style.opacity = 1;
  }, 400);
}

renderCode();
rotateTip();
setInterval(rotateTip, 7000);
loadActiveRooms();
setInterval(loadActiveRooms, 5000);
codeInput.focus();
