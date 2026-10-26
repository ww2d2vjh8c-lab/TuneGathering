// Shared helpers for the landing and room pages.

export const epochNow = () => performance.timeOrigin + performance.now();

// Optional Pricedown font (not bundled — see public/fonts/README.md).
fetch("/api/features")
  .then((res) => res.json())
  .then(({ pricedownFont }) => {
    if (!pricedownFont) return;
    const face = new FontFace("TG Display", "url(/fonts/pricedown.otf)");
    return face.load().then((f) => document.fonts.add(f));
  })
  .catch(() => {});

const ADJECTIVES = ["Cosmic", "Velvet", "Neon", "Lunar", "Golden", "Electric", "Mellow", "Funky", "Dreamy", "Sonic", "Groovy", "Midnight", "Crystal", "Echo", "Solar", "Lofi"];
const NOUNS = ["Otter", "Falcon", "Panda", "Koala", "Fox", "Dolphin", "Tiger", "Lynx", "Raven", "Gecko", "Moth", "Heron", "Badger", "Comet", "Whale", "Sparrow"];

export function randomUsername() {
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  return `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
}

export function randomRoomId() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/** Storage that never throws (private mode, blocked site data, ...). */
export const store = {
  get(key, fallback = null, area = localStorage) {
    try {
      const v = area.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value, area = localStorage) {
    try {
      area.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  },
};

export function getUsername() {
  let name = store.get("tg:username");
  if (!name) {
    name = randomUsername();
    store.set("tg:username", name);
  }
  return name;
}

export function setUsername(name) {
  store.set("tg:username", name);
}

/** One identity per tab, so a refresh rejoins as the same person. */
export function getClientId() {
  let id = store.get("tg:clientId", null, sessionStorage);
  if (!id) {
    id = crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    store.set("tg:clientId", id, sessionStorage);
  }
  return id;
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function initials(name) {
  return String(name ?? "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}

export function toast(message, { kind = "info", timeout = 3200 } = {}) {
  let host = document.getElementById("toasts");
  if (!host) {
    host = document.createElement("div");
    host.id = "toasts";
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    document.body.appendChild(host);
  }
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, timeout);
}

export function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  let lastArgs;
  return (...args) => {
    lastArgs = args;
    const now = Date.now();
    const remaining = ms - (now - last);
    if (remaining <= 0) {
      clearTimeout(timer);
      timer = null;
      last = now;
      fn(...lastArgs);
    } else if (!timer) {
      timer = setTimeout(() => {
        last = Date.now();
        timer = null;
        fn(...lastArgs);
      }, remaining);
    }
  };
}
