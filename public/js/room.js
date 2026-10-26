import { AudioEngine } from "./audio.js";
import { escapeHtml, formatTime, getClientId, getUsername, initials, setUsername, store, throttle, toast } from "./common.js";
import { SpatialGrid } from "./spatial-grid.js";
import { ClockSync } from "./sync.js";

const roomId = window.location.pathname.split("/").filter(Boolean)[1];
const clientId = getClientId();
const $ = (id) => document.getElementById(id);

const state = {
  connected: false,
  everConnected: false,
  clients: [],
  tracks: [],
  playback: { trackId: null, isPlaying: false, trackTime: 0, serverTime: 0 },
  permissions: "EVERYONE",
  volume: 1,
  lowPassFreq: 20000,
  spatial: { enabled: false, mode: "orbit", source: { x: 50, y: 50 }, gains: {} },
  loadingTrackId: null,
  durations: new Map(), // trackId → seconds, learned from decoding
  needsLateSync: false,
  syncedOnce: false,
  unreadChat: 0,
  activeTab: "queue",
  nudgeMs: store.get("tg:nudgeMs", 0),
  lastAnnouncedTrack: null,
};

let engine = null;
let ws = null;
let reconnectDelay = 500;
let actionSeq = 0; // guards async PLAY handling against newer actions

document.title = `TuneGathering · ${roomId}`;
document.querySelectorAll("[data-room-code]").forEach((el) => (el.textContent = roomId));

// ── Clock sync ─────────────────────────────────────────────────────

const compensationMs = () => (engine ? engine.outputLatencyMs() : 0) + state.nudgeMs;

const sync = new ClockSync((msg) => send(msg), {
  getCompensationMs: () => Math.max(0, compensationMs()),
  onUpdate: () => {
    if (sync.synced && state.needsLateSync) {
      state.needsLateSync = false;
      send({ type: "SYNC" });
    }
    if (sync.synced && !state.syncedOnce) {
      state.syncedOnce = true;
      banner("Synced", `Clock locked · <b>±${Math.max(0.1, sync.jitter).toFixed(1)} ms</b>`);
    }
  },
});

/**
 * Convert a server timestamp to the AudioContext time that makes the sound
 * reach this device's speaker at that instant (minus any manual nudge).
 */
function ctxTimeFor(serverTime) {
  return engine.ctxTimeAtEpoch(serverTime - sync.offset - state.nudgeMs);
}

// ── WebSocket ──────────────────────────────────────────────────────

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const params = new URLSearchParams({ roomId, clientId, username: getUsername() });
  ws = new WebSocket(`${proto}://${location.host}/ws?${params}`);

  ws.onopen = () => {
    state.connected = true;
    state.everConnected = true;
    reconnectDelay = 500;
    document.body.classList.remove("disconnected");
    $("wasted")?.remove();
    sync.reset();
    sync.start();
  };
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    handleServerMessage(msg);
  };
  ws.onclose = (e) => {
    state.connected = false;
    sync.stop();
    if (e.code === 4000) return; // this tab was replaced by a newer connection
    if (state.everConnected) showWasted();
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(8000, reconnectDelay * 2);
  };
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case "WELCOME":
      return applySnapshot(msg.room);
    case "NTP_RESPONSE":
      return sync.handleResponse(msg);
    case "ROOM_EVENT":
      return handleRoomEvent(msg.event);
    case "SCHEDULED_ACTION":
      return handleScheduledAction(msg.serverTimeToExecute, msg.action);
  }
}

function applySnapshot(room) {
  state.clients = room.clients;
  state.tracks = room.tracks;
  state.permissions = room.permissions;
  state.volume = room.volume;
  state.lowPassFreq = room.lowPassFreq;
  state.spatial = { ...state.spatial, ...room.spatial };
  state.playback = room.playback;

  engine.setVolume(room.volume);
  engine.setLowPass(room.lowPassFreq);
  if (!room.spatial.enabled) engine.setSpatialGain(1);

  // If music is already playing, drop in as soon as our clock is trustworthy.
  if (room.playback.isPlaying) {
    state.needsLateSync = true;
    const track = findTrack(room.playback.trackId);
    if (track) engine.load(track).catch(() => {});
  } else {
    engine.stopNow();
  }

  $("chat-log").innerHTML = "";
  room.chat.forEach((m) => appendChat(m, { silent: true }));
  renderAll();
}

function handleRoomEvent(event) {
  switch (event.type) {
    case "CLIENTS":
      state.clients = event.clients;
      renderCrew();
      renderHeader();
      renderPermissions();
      renderControls();
      renderRadar();
      break;
    case "TRACKS":
      state.tracks = event.tracks;
      renderQueue();
      renderNowPlaying();
      break;
    case "CHAT":
      appendChat(event.message);
      break;
    case "PERMISSIONS":
      state.permissions = event.permissions;
      renderPermissions();
      renderControls();
      break;
    case "LOAD_TRACK":
      loadForPlay(event.trackId);
      break;
    case "PLAYBACK_RESET":
      actionSeq++;
      engine.stopNow();
      state.playback = { trackId: null, isPlaying: false, trackTime: 0, serverTime: 0 };
      renderQueue();
      renderNowPlaying();
      break;
  }
}

async function loadForPlay(trackId) {
  const track = findTrack(trackId);
  if (!track) return;
  state.loadingTrackId = trackId;
  renderQueue();
  try {
    const buffer = await engine.load(track);
    state.durations.set(trackId, buffer.duration);
    send({ type: "AUDIO_LOADED", trackId, duration: buffer.duration });
  } catch (err) {
    toast(`Couldn't load "${track.name}" on this device`, { kind: "error" });
    console.error(err);
  } finally {
    if (state.loadingTrackId === trackId) state.loadingTrackId = null;
    renderQueue();
  }
}

async function handleScheduledAction(serverTime, action) {
  switch (action.type) {
    case "PLAY": {
      const seq = ++actionSeq;
      const track = findTrack(action.trackId);
      if (!track) return;
      state.playback = { trackId: action.trackId, isPlaying: true, trackTime: action.trackTimeSeconds, serverTime };
      renderQueue();
      renderNowPlaying();
      renderControls();
      if (state.lastAnnouncedTrack !== track.id) {
        state.lastAnnouncedTrack = track.id;
        radioPop(track.name);
      }
      try {
        const buffer = await engine.load(track);
        state.durations.set(track.id, buffer.duration);
        if (seq !== actionSeq) return; // something newer arrived while decoding
        engine.playAt(track.id, buffer, ctxTimeFor(serverTime), action.trackTimeSeconds);
      } catch {
        toast(`Couldn't play "${track.name}" on this device`, { kind: "error" });
      }
      break;
    }
    case "PAUSE":
      actionSeq++;
      state.playback = { trackId: action.trackId, isPlaying: false, trackTime: action.trackTimeSeconds, serverTime };
      engine.stopAt(ctxTimeFor(serverTime));
      renderQueue();
      renderControls();
      break;
    case "VOLUME":
      state.volume = action.volume;
      engine.setVolume(action.volume, ctxTimeFor(serverTime), action.rampTime);
      renderSliders();
      break;
    case "LOW_PASS":
      state.lowPassFreq = action.freq;
      engine.setLowPass(action.freq, ctxTimeFor(serverTime), action.rampTime);
      renderSliders();
      break;
    case "SPATIAL_CONFIG":
      state.spatial = { enabled: true, mode: action.mode, source: action.source, gains: action.gains };
      engine.setSpatialGain(action.gains[clientId] ?? 1, 0, action.rampTime);
      renderRadar();
      break;
    case "SPATIAL_OFF":
      state.spatial = { ...state.spatial, enabled: false, gains: {} };
      engine.setSpatialGain(1, ctxTimeFor(serverTime), 0.3);
      renderRadar();
      break;
  }
}

/** Re-align this device after a local timing change, without involving others. */
async function resyncLocal() {
  const { trackId, isPlaying, trackTime, serverTime } = state.playback;
  if (!isPlaying || !engine.isPlaying()) return;
  const track = findTrack(trackId);
  const seq = actionSeq;
  const buffer = await engine.load(track);
  if (seq !== actionSeq) return;
  const at = sync.serverNow() + 120;
  engine.playAt(trackId, buffer, ctxTimeFor(at), trackTime + (at - serverTime) / 1000);
}

// ── Derived state ──────────────────────────────────────────────────

const findTrack = (id) => state.tracks.find((t) => t.id === id);
const me = () => state.clients.find((c) => c.clientId === clientId);
const canControl = () => state.permissions === "EVERYONE" || !!me()?.isAdmin;
const durationOf = (track) => (track ? state.durations.get(track.id) ?? track.duration ?? 0 : 0);

function currentPosition() {
  const { isPlaying, trackTime, serverTime } = state.playback;
  if (!isPlaying) return trackTime;
  return Math.max(trackTime, trackTime + (sync.serverNow() - serverTime) / 1000);
}

// ── Rendering ──────────────────────────────────────────────────────

const ICONS = {
  play: '<path d="M8 5v14l11-7z"/>',
  pause: '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
};

function renderAll() {
  renderHeader();
  renderQueue();
  renderCrew();
  renderNowPlaying();
  renderControls();
  renderPermissions();
  renderSliders();
  renderRadar();
}

function renderHeader() {
  $("name-btn").textContent = me()?.username ?? getUsername();
  const n = state.clients.length;
  $("crew-count").textContent = `♪ ${n} ${n === 1 ? "listener" : "listeners"}`;
  $("stars").innerHTML = Array.from({ length: 5 }, (_, i) => `<span class="${i < n ? "on" : "off"}">★</span>`).join("");
}

function renderQueue() {
  const list = $("queue");
  const control = canControl();
  $("queue-empty").hidden = state.tracks.length > 0;
  list.innerHTML = state.tracks
    .map((t, i) => {
      const current = t.id === state.playback.trackId;
      const loading = t.id === state.loadingTrackId;
      const dur = durationOf(t);
      const idx = current && state.playback.isPlaying ? '<span class="eq" aria-label="Playing"><i></i><i></i><i></i></span>' : i + 1;
      return `
      <li class="track-row ${current ? "current" : ""} ${loading ? "loading" : ""}" data-id="${t.id}" tabindex="0" aria-current="${current}">
        <span class="idx">${idx}</span>
        <div style="min-width:0">
          <div class="t-name">${escapeHtml(t.name)}</div>
          <div class="t-meta">${escapeHtml(t.artist ?? `Added by ${t.addedBy ?? "someone"}`)}</div>
        </div>
        <span class="t-dur">${dur ? formatTime(dur) : "—"}</span>
        <span class="t-actions">
          <button class="icon-btn" data-act="up" aria-label="Move up" ${!control || i === 0 ? "disabled" : ""}>${ICONS.up}</button>
          <button class="icon-btn" data-act="down" aria-label="Move down" ${!control || i === state.tracks.length - 1 ? "disabled" : ""}>${ICONS.down}</button>
          <button class="icon-btn" data-act="delete" aria-label="Remove" ${!control ? "disabled" : ""}>${ICONS.trash}</button>
        </span>
      </li>`;
    })
    .join("");
  $("demo-btn").disabled = !control;
  $("upload-label").classList.toggle("disabled", !control);
  $("upload-label").style.pointerEvents = control ? "" : "none";
  $("upload-label").style.opacity = control ? "" : "0.4";
}

function renderCrew() {
  const admin = !!me()?.isAdmin;
  $("crew").innerHTML = state.clients
    .map((c) => {
      const isMe = c.clientId === clientId;
      const ping = c.rtt ? `${Math.round(c.rtt)} ms` : "syncing";
      const toggle = admin && !isMe ? `<button class="btn btn-sm" data-admin="${c.clientId}" data-make="${!c.isAdmin}">${c.isAdmin ? "Demote" : "Make admin"}</button>` : "";
      return `
      <li class="crew-row ${isMe ? "me" : ""}">
        <span class="avatar" style="--c:${c.color}">${escapeHtml(initials(c.username))}</span>
        <div style="min-width:0">
          <div class="crew-name">${escapeHtml(c.username)}</div>
          <div class="crew-meta">
            ${isMe ? '<span class="rank you">You</span>' : ""}
            ${c.isAdmin ? '<span class="rank">Boss</span>' : ""}
            <span>Ping ${ping}</span>
          </div>
        </div>
        ${toggle}
      </li>`;
    })
    .join("");
}

function renderNowPlaying() {
  const track = findTrack(state.playback.trackId);
  $("np-title").textContent = track ? track.name : "Nothing playing";
  $("np-sub").textContent = track ? track.artist ?? `Added by ${track.addedBy ?? "someone"}` : state.tracks.length ? "Pick a track from the queue." : "Add some music to get started.";
  $("p-title").textContent = track ? track.name : "No track";
  $("p-sub").textContent = track ? "TuneGathering FM" : `Session ${roomId}`;
}

function renderControls() {
  const control = canControl();
  const playing = state.playback.isPlaying;
  $("play-icon").innerHTML = playing ? ICONS.pause : ICONS.play;
  $("play-btn").setAttribute("aria-label", playing ? "Pause" : "Play");
  $("play-btn").disabled = !control || state.tracks.length === 0;
  $("prev-btn").disabled = !control || state.tracks.length === 0;
  $("next-btn").disabled = !control || state.tracks.length === 0;
  $("volume").disabled = !control;
  $("lowpass").disabled = !control;
  $("seek").setAttribute("aria-disabled", String(!control || !state.playback.trackId));
  document.querySelectorAll("[data-spatial]").forEach((b) => (b.disabled = !control));
  $("disc").classList.toggle("spinning", playing);
}

function renderPermissions() {
  const admin = !!me()?.isAdmin;
  document.querySelectorAll("[data-perm]").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.perm === state.permissions));
    b.disabled = !admin;
  });
  $("perm-note").textContent = admin ? "You're a boss in this session, so you decide." : "Only bosses (admins) can change this.";
}

const freqToSlider = (f) => Math.round((Math.log(f / 20) / Math.log(1000)) * 1000);
const sliderToFreq = (v) => 20 * Math.pow(1000, v / 1000);
const setPct = (input) => input.style.setProperty("--pct", `${((input.value - input.min) / (input.max - input.min)) * 100}%`);

function renderSliders() {
  const vol = $("volume");
  const lp = $("lowpass");
  const nudge = $("nudge");
  if (document.activeElement !== vol) vol.value = Math.round(state.volume * 100);
  if (document.activeElement !== lp) lp.value = freqToSlider(state.lowPassFreq);
  nudge.value = state.nudgeMs;
  $("lowpass-val").textContent = state.lowPassFreq >= 19900 ? "Off" : `${Math.round(state.lowPassFreq)} Hz`;
  $("nudge-val").textContent = `${state.nudgeMs > 0 ? "+" : ""}${state.nudgeMs} ms`;
  [vol, lp, nudge].forEach(setPct);
}

function renderRadar() {
  radar.update({ clients: state.clients.map((c) => ({ ...c, position: { ...c.position } })), myId: clientId, gains: state.spatial.gains, source: state.spatial.source, enabled: state.spatial.enabled });
  const mode = state.spatial.enabled ? state.spatial.mode : "off";
  document.querySelectorAll("[data-spatial]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.spatial === mode)));
}

function setStat(id, fill, label) {
  const bar = $(id);
  const segs = bar.children;
  for (let i = 0; i < segs.length; i++) segs[i].style.setProperty("--fill", Math.min(1, Math.max(0, fill * segs.length - i)));
  $(`${id}-val`).textContent = label;
}

// ── Chat ───────────────────────────────────────────────────────────

function appendChat(m, { silent = false } = {}) {
  const log = $("chat-log");
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  const el = document.createElement("div");
  el.className = "chat-msg";
  const time = new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  el.innerHTML = `<span class="who" style="color:${m.color}">${escapeHtml(m.username)}</span>${escapeHtml(m.text)}<span class="when">${time}</span>`;
  log.appendChild(el);
  if (nearBottom || m.clientId === clientId) log.scrollTop = log.scrollHeight;

  if (!silent && m.clientId !== clientId && state.activeTab !== "chat") {
    state.unreadChat++;
    $("chat-badge").hidden = false;
    $("chat-badge").textContent = state.unreadChat;
    feedToast(m.username, m.text);
  }
}

function feedToast(from, text) {
  toast("", { kind: "chat", timeout: 4200 });
  const last = document.querySelector("#toasts .toast:last-child");
  last.innerHTML = `<span class="toast-from">${escapeHtml(from)}</span>${escapeHtml(text.length > 120 ? text.slice(0, 120) + "…" : text)}`;
}

// ── Game-style overlays ────────────────────────────────────────────

function banner(big, small) {
  const el = document.createElement("div");
  el.className = "banner";
  el.innerHTML = `<div class="big display">${escapeHtml(big)}</div><div class="small">${small}</div>`;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add("out"), 2600);
  setTimeout(() => el.remove(), 3200);
}

let radioTimer;
function radioPop(song) {
  document.querySelector(".radio-pop")?.remove();
  clearTimeout(radioTimer);
  const el = document.createElement("div");
  el.className = "radio-pop";
  el.innerHTML = `<div class="station display">TuneGathering FM</div><div class="song">${escapeHtml(song)}</div>`;
  document.body.appendChild(el);
  radioTimer = setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 450);
  }, 3200);
}

function showWasted() {
  document.body.classList.add("disconnected");
  if ($("wasted")) return;
  const el = document.createElement("div");
  el.className = "wasted";
  el.id = "wasted";
  el.innerHTML = `<div class="big display">Connection lost</div><div class="small"><div class="spinner"></div>Reconnecting to session ${roomId}</div>`;
  document.body.appendChild(el);
}

// ── Animation loop: seek bar, clock, visualizer, stats ─────────────

const viz = $("viz");
const vizCtx = viz.getContext("2d");
let freqData;

function frame() {
  const track = findTrack(state.playback.trackId);
  const dur = durationOf(track);
  const pos = Math.min(currentPosition(), dur || Infinity);
  $("t-cur").textContent = formatTime(track ? pos : 0);
  $("t-dur").textContent = formatTime(dur);
  const pct = dur ? Math.min(100, (pos / dur) * 100) : 0;
  $("seek-fill").style.width = `${pct}%`;
  $("seek").setAttribute("aria-valuenow", String(Math.round(pct)));

  drawViz();
  requestAnimationFrame(frame);
}

function drawViz() {
  const w = (viz.width = viz.clientWidth * devicePixelRatio);
  const h = (viz.height = viz.clientHeight * devicePixelRatio);
  if (!w || !h) return;
  const bars = 48;
  const gap = 3 * devicePixelRatio;
  const bw = (w - gap * (bars - 1)) / bars;
  if (engine) {
    freqData ??= new Uint8Array(engine.analyser.frequencyBinCount);
    engine.analyser.getByteFrequencyData(freqData);
  }
  for (let i = 0; i < bars; i++) {
    const v = freqData ? freqData[Math.floor((i / bars) * freqData.length * 0.75)] / 255 : 0;
    const bh = Math.max(2 * devicePixelRatio, v * h);
    vizCtx.fillStyle = i % 8 === 0 ? "rgba(171,237,171,0.95)" : "rgba(255,255,255,0.85)";
    vizCtx.fillRect(i * (bw + gap), h - bh, bw, bh);
  }
}

function slowTick() {
  const now = new Date();
  $("clock").textContent = `${now.toLocaleDateString([], { weekday: "short" })} ${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

  const pill = $("sync-pill");
  pill.classList.toggle("ok", state.connected && sync.synced);
  pill.classList.toggle("bad", !state.connected);
  $("sync-text").textContent = !state.connected ? "Offline" : sync.synced ? `Synced ±${Math.max(0.1, sync.jitter).toFixed(1)} ms` : `Syncing ${Math.round(sync.progress * 100)}%`;

  if (sync.synced) setStat("stat-sync", 1 - Math.min(1, sync.jitter / 8), `±${Math.max(0.1, sync.jitter).toFixed(1)} ms`);
  else setStat("stat-sync", sync.progress * 0.4, "syncing");
  setStat("stat-rtt", sync.rtt ? 1 - Math.min(1, sync.rtt / 250) : 0, sync.rtt ? `${Math.round(sync.rtt)} ms ping` : "—");
  const ready = state.clients.filter((c) => c.rtt > 0).length;
  setStat("stat-crew", state.clients.length ? ready / state.clients.length : 0, `${ready}/${state.clients.length}`);

  $("diag").innerHTML = engine
    ? `Clock offset ${sync.offset.toFixed(2)} ms · round trip ${sync.rtt.toFixed(1)} ms · ${sync.measurements.length} samples<br>Output latency ${engine.outputLatencyMs().toFixed(1)} ms · nudge ${state.nudgeMs} ms · ${engine.ctx.sampleRate} Hz`
    : "";
}

// ── Wiring ─────────────────────────────────────────────────────────

const radar = new SpatialGrid($("radar"), {
  canDragSource: () => canControl() && state.spatial.enabled,
  canDragClient: (id) => id === clientId || canControl(),
  onMoveSource: throttle((p) => send({ type: "SET_LISTENING_SOURCE", x: p.x, y: p.y }), 60),
  onMoveClient: throttle((id, p) => send({ type: "MOVE_CLIENT", clientId: id, x: p.x, y: p.y }), 60),
});

function selectTab(name) {
  state.activeTab = name;
  document.querySelectorAll(".pm-tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === name)));
  document.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== name));
  if (name === "chat") {
    state.unreadChat = 0;
    $("chat-badge").hidden = true;
    const log = $("chat-log");
    log.scrollTop = log.scrollHeight;
    $("chat-input").focus({ preventScroll: true });
  }
  if (name === "radar") radar.resize();
}

document.querySelectorAll(".pm-tab").forEach((tab) => tab.addEventListener("click", () => selectTab(tab.dataset.tab)));
document.querySelector(".pm-tabs").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
  const tabs = [...document.querySelectorAll(".pm-tab")];
  const i = tabs.findIndex((t) => t.dataset.tab === state.activeTab);
  const next = tabs[(i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
  selectTab(next.dataset.tab);
  next.focus();
});

$("play-btn").addEventListener("click", () => {
  if (state.playback.isPlaying) return send({ type: "PAUSE" });
  const track = findTrack(state.playback.trackId) ?? state.tracks[0];
  if (!track) return;
  let at = track.id === state.playback.trackId ? currentPosition() : 0;
  if (durationOf(track) && at >= durationOf(track) - 0.5) at = 0;
  send({ type: "PLAY", trackId: track.id, trackTimeSeconds: at });
});
$("prev-btn").addEventListener("click", () => send({ type: "PREVIOUS" }));
$("next-btn").addEventListener("click", () => send({ type: "NEXT" }));

function seekTo(seconds) {
  const track = findTrack(state.playback.trackId);
  if (!track || !canControl()) return;
  const dur = durationOf(track);
  send({ type: "PLAY", trackId: track.id, trackTimeSeconds: Math.max(0, Math.min(seconds, dur ? dur - 0.25 : seconds)) });
}
$("seek").addEventListener("click", (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  seekTo(((e.clientX - rect.left) / rect.width) * durationOf(findTrack(state.playback.trackId)));
});
$("seek").addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight") seekTo(currentPosition() + 5);
  if (e.key === "ArrowLeft") seekTo(currentPosition() - 5);
});

$("queue").addEventListener("click", (e) => {
  const row = e.target.closest(".track-row");
  if (!row || !canControl()) return;
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "up" || act === "down") return send({ type: "MOVE_TRACK", trackId: row.dataset.id, direction: act === "up" ? -1 : 1 });
  if (act === "delete") return send({ type: "DELETE_TRACK", trackId: row.dataset.id });
  send({ type: "PLAY", trackId: row.dataset.id, trackTimeSeconds: 0 });
});
$("queue").addEventListener("keydown", (e) => {
  const row = e.target.closest(".track-row");
  if (row && e.target === row && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    if (canControl()) send({ type: "PLAY", trackId: row.dataset.id, trackTimeSeconds: 0 });
  }
});

$("demo-btn").addEventListener("click", () => send({ type: "ADD_DEMO_TRACKS" }));

const sendVolume = throttle((v) => send({ type: "SET_VOLUME", volume: v }), 80);
$("volume").addEventListener("input", (e) => {
  setPct(e.target);
  sendVolume(e.target.value / 100);
});
const sendLowPass = throttle((f) => send({ type: "SET_LOW_PASS", freq: f }), 80);
$("lowpass").addEventListener("input", (e) => {
  setPct(e.target);
  const f = sliderToFreq(Number(e.target.value));
  $("lowpass-val").textContent = f >= 19900 ? "Off" : `${Math.round(f)} Hz`;
  sendLowPass(f);
});
let nudgeTimer;
$("nudge").addEventListener("input", (e) => {
  state.nudgeMs = Number(e.target.value);
  store.set("tg:nudgeMs", state.nudgeMs);
  renderSliders();
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(resyncLocal, 250);
});

document.querySelectorAll("[data-spatial]").forEach((b) =>
  b.addEventListener("click", () => {
    const mode = b.dataset.spatial;
    if (mode === "off") return send({ type: "STOP_SPATIAL" });
    if (!state.spatial.enabled) send({ type: "START_SPATIAL" });
    send({ type: "SET_SPATIAL_MODE", mode });
  })
);
document.querySelectorAll("[data-perm]").forEach((b) => b.addEventListener("click", () => send({ type: "SET_PERMISSIONS", permissions: b.dataset.perm })));
$("crew").addEventListener("click", (e) => {
  const b = e.target.closest("[data-admin]");
  if (b) send({ type: "SET_ADMIN", clientId: b.dataset.admin, isAdmin: b.dataset.make === "true" });
});

$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text) return;
  send({ type: "CHAT", text });
  input.value = "";
});

const inviteLink = () => `${location.origin}/room/${roomId}`;
async function copyInvite() {
  try {
    await navigator.clipboard.writeText(inviteLink());
    toast("Invite link copied", { kind: "success" });
  } catch {
    window.prompt("Copy this invite link", inviteLink());
  }
}
$("copy-link").addEventListener("click", copyInvite);
$("invite-btn").addEventListener("click", async () => {
  if (navigator.share) {
    try {
      return await navigator.share({ title: "Join my TuneGathering", text: `Session ${roomId}`, url: inviteLink() });
    } catch {
      /* cancelled — fall through to copy */
    }
  }
  copyInvite();
});
$("sync-pill").addEventListener("click", () => selectTab("settings"));

$("name-btn").addEventListener("click", () => {
  $("name-input").value = me()?.username ?? getUsername();
  $("name-dialog").showModal();
});
$("name-dialog").addEventListener("close", () => {
  if ($("name-dialog").returnValue !== "ok") return;
  const name = $("name-input").value.trim().slice(0, 32);
  if (!name) return;
  setUsername(name);
  send({ type: "SET_USERNAME", username: name });
});

// ── Uploads ────────────────────────────────────────────────────────

function uploadFile(file) {
  const item = document.createElement("div");
  item.className = "upload-item";
  item.innerHTML = `<span>${escapeHtml(file.name)}</span><div class="hud-bar"><i style="width:0%"></i></div>`;
  $("uploads").appendChild(item);
  const bar = item.querySelector("i");

  const xhr = new XMLHttpRequest();
  xhr.open("PUT", `/api/rooms/${roomId}/upload`);
  xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
  xhr.setRequestHeader("X-Client-Id", clientId);
  xhr.upload.onprogress = (e) => e.lengthComputable && (bar.style.width = `${(e.loaded / e.total) * 100}%`);
  xhr.onload = () => {
    item.remove();
    if (xhr.status >= 200 && xhr.status < 300) toast(`Added "${file.name}"`, { kind: "success" });
    else {
      let error = `Upload failed (${xhr.status})`;
      try {
        error = JSON.parse(xhr.responseText).error ?? error;
      } catch {
        /* keep generic message */
      }
      toast(error, { kind: "error" });
    }
  };
  xhr.onerror = () => {
    item.remove();
    toast(`Upload of "${file.name}" failed`, { kind: "error" });
  };
  xhr.send(file);
}

$("file-input").addEventListener("change", (e) => {
  [...e.target.files].forEach(uploadFile);
  e.target.value = "";
});
const dz = $("dropzone");
["dragenter", "dragover"].forEach((ev) =>
  document.addEventListener(ev, (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    dz.classList.add("over");
  })
);
["dragleave", "drop"].forEach((ev) => document.addEventListener(ev, () => dz.classList.remove("over")));
document.addEventListener("drop", (e) => {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  if (!canControl()) return toast("Only bosses can add tracks in this session", { kind: "error" });
  selectTab("queue");
  [...e.dataTransfer.files].forEach(uploadFile);
});

// ── Start ──────────────────────────────────────────────────────────

async function join() {
  if (engine) return;
  engine = new AudioEngine(); // must be created inside the user gesture on iOS
  try {
    await engine.unlock();
  } catch {
    /* some browsers resolve later; playback still schedules */
  }
  $("join-overlay").remove();
  connect();
  renderAll();
  requestAnimationFrame(frame);
  slowTick();
  setInterval(slowTick, 500);
}

// Read-only handle for debugging sync from the devtools console.
window.tg = { state, sync, get engine() { return engine; } };

$("join-btn").addEventListener("click", join);
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !engine) join();
});
$("name-btn").textContent = getUsername();
document.addEventListener("visibilitychange", () => {
  // Mobile browsers suspend audio in the background; wake it on return.
  if (document.visibilityState === "visible" && engine?.ctx.state === "suspended") engine.ctx.resume();
});
