import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { epochNow, scheduleDelayMs } from "./time.js";
import { circlePositions, clampToGrid, gainFromDistance, GRID, orbitPosition } from "./spatial.js";

// Protagonist and crew colours from the GTA V palette.
const COLORS = ["#65b4d4", "#abedab", "#ffa357", "#f0c850", "#e07a7a", "#c49be8", "#ff8fc8", "#5ee0c9", "#93b5ff", "#e8e8e8"];
const SPATIAL_TICK_MS = 100;
const MIN_LOW_PASS = 20;
const MAX_LOW_PASS = 20_000;

export class Room {
  constructor(id, { onEmpty } = {}) {
    this.id = id;
    this.createdAt = Date.now();
    this.onEmpty = onEmpty;
    this.clients = new Map();
    this.tracks = [];
    this.playback = { trackId: null, isPlaying: false, trackTime: 0, serverTime: epochNow() };
    this.permissions = "EVERYONE";
    this.volume = 1;
    this.lowPassFreq = MAX_LOW_PASS;
    this.spatial = { enabled: false, mode: "orbit", source: { x: GRID.CENTER, y: GRID.CENTER }, timer: null, startedAt: 0 };
    this.chat = [];
    this.nextChatId = 1;
    this.pendingPlay = null;
    this.endTimer = null;
    this.cleanupTimer = null;
    this.colorIndex = 0;
  }

  // ── Membership ───────────────────────────────────────────────────

  addClient(ws, { clientId, username }) {
    clearTimeout(this.cleanupTimer);
    this.cleanupTimer = null;

    const existing = this.clients.get(clientId);
    if (existing) {
      // Same browser tab reconnecting: keep identity, swap the socket.
      if (existing.ws !== ws) existing.ws.close(4000, "Replaced by a newer connection");
      existing.ws = ws;
      existing.username = username || existing.username;
    } else {
      const isFirst = this.clients.size === 0;
      this.clients.set(clientId, {
        clientId,
        username,
        ws,
        rtt: 0,
        compensationMs: 0,
        position: { x: GRID.CENTER, y: GRID.CENTER },
        isAdmin: isFirst,
        color: COLORS[this.colorIndex++ % COLORS.length],
        joinedAt: Date.now(),
      });
      this.layoutClients();
    }

    this.send(clientId, { type: "WELCOME", clientId, serverTime: epochNow(), room: this.snapshot() });
    this.broadcastClients();
    if (this.spatial.enabled) this.broadcastSpatial();
  }

  removeClient(clientId, ws) {
    const client = this.clients.get(clientId);
    if (!client || client.ws !== ws) return; // a newer socket already took over
    this.clients.delete(clientId);

    if (this.pendingPlay) {
      this.pendingPlay.waiting.delete(clientId);
      if (this.pendingPlay.waiting.size === 0) this.executePendingPlay();
    }

    if (this.clients.size === 0) {
      this.scheduleCleanup();
      return;
    }
    if (client.isAdmin && ![...this.clients.values()].some((c) => c.isAdmin)) {
      // Never leave a room without an admin: promote the longest-standing member.
      const next = [...this.clients.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
      next.isAdmin = true;
    }
    this.layoutClients();
    this.broadcastClients();
    if (this.spatial.enabled) this.broadcastSpatial();
  }

  scheduleCleanup() {
    clearTimeout(this.cleanupTimer);
    this.cleanupTimer = setTimeout(() => {
      if (this.clients.size === 0) this.destroy();
    }, config.emptyRoomTtlMs);
  }

  destroy() {
    clearTimeout(this.endTimer);
    clearTimeout(this.cleanupTimer);
    clearTimeout(this.clientsTimer);
    clearInterval(this.spatial.timer);
    if (this.pendingPlay) clearTimeout(this.pendingPlay.timer);
    fs.rm(this.uploadDir(), { recursive: true, force: true }, () => {});
    this.onEmpty?.(this);
  }

  layoutClients() {
    const clients = [...this.clients.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    circlePositions(clients.length).forEach((pos, i) => (clients[i].position = pos));
  }

  // ── Messaging ────────────────────────────────────────────────────

  send(clientId, message) {
    const ws = this.clients.get(clientId)?.ws;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(message));
  }

  broadcast(message) {
    const data = JSON.stringify(message);
    for (const { ws } of this.clients.values()) if (ws.readyState === 1) ws.send(data);
  }

  broadcastEvent(event) {
    this.broadcast({ type: "ROOM_EVENT", event });
  }

  broadcastClients() {
    clearTimeout(this.clientsTimer);
    this.clientsTimer = null;
    this.broadcastEvent({ type: "CLIENTS", clients: this.publicClients() });
  }

  /** Record a client's latest sync stats; others see them on a slow cadence. */
  updateClientStats(clientId, { rtt, compensationMs }) {
    const client = this.clients.get(clientId);
    if (!client) return;
    const before = client.rtt;
    if (Number.isFinite(rtt)) client.rtt = Math.max(0, rtt);
    if (Number.isFinite(compensationMs)) client.compensationMs = Math.max(0, compensationMs);
    const changed = (before === 0) !== (client.rtt === 0) || Math.abs(client.rtt - before) > 2;
    if (changed && !this.clientsTimer) {
      this.clientsTimer = setTimeout(() => this.broadcastClients(), 1500);
    }
  }

  broadcastTracks() {
    this.broadcastEvent({ type: "TRACKS", tracks: this.tracks });
  }

  /** Broadcast an action that every client executes at the same instant. */
  scheduleAction(action, { extraDelayMs = 0 } = {}) {
    const serverTimeToExecute = epochNow() + this.scheduleDelay() + extraDelayMs;
    this.broadcast({ type: "SCHEDULED_ACTION", serverTimeToExecute, action });
    return serverTimeToExecute;
  }

  scheduleDelay() {
    let maxRtt = 0;
    let maxComp = 0;
    for (const c of this.clients.values()) {
      maxRtt = Math.max(maxRtt, c.rtt);
      maxComp = Math.max(maxComp, c.compensationMs);
    }
    return scheduleDelayMs(maxRtt, maxComp);
  }

  publicClients() {
    return [...this.clients.values()].map(({ ws, ...rest }) => rest);
  }

  snapshot() {
    return {
      id: this.id,
      clients: this.publicClients(),
      tracks: this.tracks,
      playback: { ...this.playback, position: this.currentPosition() },
      permissions: this.permissions,
      volume: this.volume,
      lowPassFreq: this.lowPassFreq,
      spatial: { enabled: this.spatial.enabled, mode: this.spatial.mode, source: this.spatial.source },
      chat: this.chat,
    };
  }

  summary() {
    const track = this.tracks.find((t) => t.id === this.playback.trackId);
    return {
      id: this.id,
      listeners: this.clients.size,
      isPlaying: this.playback.isPlaying,
      nowPlaying: track?.name ?? null,
      createdAt: this.createdAt,
    };
  }

  // ── Playback clock ───────────────────────────────────────────────

  /** Track position (seconds) at a given server time, per the room's clock. */
  currentPosition(atServerTime = epochNow()) {
    const { isPlaying, trackTime, serverTime } = this.playback;
    if (!isPlaying) return trackTime;
    return Math.max(0, trackTime + (atServerTime - serverTime) / 1000);
  }

  canControl(clientId) {
    const client = this.clients.get(clientId);
    return !!client && (this.permissions === "EVERYONE" || client.isAdmin);
  }

  isAdmin(clientId) {
    return !!this.clients.get(clientId)?.isAdmin;
  }

  /**
   * Step 1 of play: tell everyone to fetch and decode the track, then wait for
   * every client to confirm (or a timeout) before scheduling the start. This is
   * what keeps a slow phone from starting half a second late.
   */
  requestPlay(trackId, trackTimeSeconds = 0) {
    if (!this.tracks.some((t) => t.id === trackId)) return;
    if (this.pendingPlay) clearTimeout(this.pendingPlay.timer);

    this.pendingPlay = {
      trackId,
      trackTime: Math.max(0, Number(trackTimeSeconds) || 0),
      waiting: new Set(this.clients.keys()),
      timer: setTimeout(() => this.executePendingPlay(), config.audioLoadTimeoutMs),
    };
    this.broadcastEvent({ type: "LOAD_TRACK", trackId });
  }

  onAudioLoaded(clientId, { trackId, duration }) {
    const track = this.tracks.find((t) => t.id === trackId);
    if (track && Number.isFinite(duration) && duration > 0 && !track.duration) {
      track.duration = duration;
      this.broadcastTracks();
    }
    if (!this.pendingPlay || this.pendingPlay.trackId !== trackId) return;
    this.pendingPlay.waiting.delete(clientId);
    if (this.pendingPlay.waiting.size === 0) this.executePendingPlay();
  }

  executePendingPlay() {
    const pending = this.pendingPlay;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingPlay = null;

    const at = this.scheduleAction({ type: "PLAY", trackId: pending.trackId, trackTimeSeconds: pending.trackTime });
    this.playback = { trackId: pending.trackId, isPlaying: true, trackTime: pending.trackTime, serverTime: at };
    this.armEndTimer();
  }

  pause() {
    if (this.pendingPlay) {
      clearTimeout(this.pendingPlay.timer);
      this.pendingPlay = null;
    }
    if (!this.playback.isPlaying) return;
    const delay = this.scheduleDelay();
    const at = epochNow() + delay;
    const trackTime = this.currentPosition(at);
    this.broadcast({
      type: "SCHEDULED_ACTION",
      serverTimeToExecute: at,
      action: { type: "PAUSE", trackId: this.playback.trackId, trackTimeSeconds: trackTime },
    });
    this.playback = { trackId: this.playback.trackId, isPlaying: false, trackTime, serverTime: at };
    clearTimeout(this.endTimer);
  }

  stop() {
    if (this.playback.isPlaying) this.pause();
    this.playback = { trackId: null, isPlaying: false, trackTime: 0, serverTime: epochNow() };
    this.broadcastEvent({ type: "PLAYBACK_RESET" });
  }

  skip(direction) {
    if (this.tracks.length === 0) return;
    const index = this.tracks.findIndex((t) => t.id === this.playback.trackId);
    if (direction < 0 && index >= 0 && this.currentPosition() > 3) {
      this.requestPlay(this.tracks[index].id, 0); // "previous" restarts the song first
      return;
    }
    const next = index === -1 ? 0 : index + direction;
    if (next < 0 || next >= this.tracks.length) {
      if (direction > 0) this.stop();
      else this.requestPlay(this.tracks[0].id, 0);
      return;
    }
    this.requestPlay(this.tracks[next].id, 0);
  }

  armEndTimer() {
    clearTimeout(this.endTimer);
    const track = this.tracks.find((t) => t.id === this.playback.trackId);
    if (!track?.duration) return;
    const endsAt = this.playback.serverTime + (track.duration - this.playback.trackTime) * 1000;
    this.endTimer = setTimeout(() => {
      if (this.playback.isPlaying && this.playback.trackId === track.id) this.skip(1);
    }, Math.max(0, endsAt - epochNow()) + 250);
  }

  /** A late joiner has synced its clock and wants to drop into the music. */
  syncLateJoiner(clientId) {
    if (!this.playback.isPlaying) return;
    const at = epochNow() + this.scheduleDelay();
    this.send(clientId, {
      type: "SCHEDULED_ACTION",
      serverTimeToExecute: at,
      action: { type: "PLAY", trackId: this.playback.trackId, trackTimeSeconds: this.currentPosition(at) },
    });
  }

  // ── Queue ────────────────────────────────────────────────────────

  addTrack(track) {
    this.tracks.push(track);
    this.broadcastTracks();
  }

  deleteTrack(trackId) {
    const index = this.tracks.findIndex((t) => t.id === trackId);
    if (index === -1) return;
    const [track] = this.tracks.splice(index, 1);
    if (this.playback.trackId === trackId) this.stop();
    if (track.file) fs.rm(path.join(this.uploadDir(), track.file), { force: true }, () => {});
    this.broadcastTracks();
  }

  moveTrack(trackId, direction) {
    const from = this.tracks.findIndex((t) => t.id === trackId);
    const to = from + Math.sign(direction);
    if (from === -1 || to < 0 || to >= this.tracks.length) return;
    [this.tracks[from], this.tracks[to]] = [this.tracks[to], this.tracks[from]];
    this.broadcastTracks();
  }

  uploadDir() {
    return path.join(config.uploadDir, this.id);
  }

  // ── Room-wide audio settings ─────────────────────────────────────

  setVolume(volume) {
    this.volume = Math.min(1, Math.max(0, Number(volume) || 0));
    this.scheduleAction({ type: "VOLUME", volume: this.volume, rampTime: 0.1 });
  }

  setLowPass(freq) {
    this.lowPassFreq = Math.min(MAX_LOW_PASS, Math.max(MIN_LOW_PASS, Number(freq) || MAX_LOW_PASS));
    this.scheduleAction({ type: "LOW_PASS", freq: this.lowPassFreq, rampTime: 0.1 });
  }

  // ── Spatial audio ────────────────────────────────────────────────

  startSpatial() {
    this.spatial.enabled = true;
    this.setSpatialMode("orbit");
  }

  stopSpatial() {
    this.spatial.enabled = false;
    clearInterval(this.spatial.timer);
    this.spatial.timer = null;
    this.scheduleAction({ type: "SPATIAL_OFF" });
  }

  setSpatialMode(mode) {
    clearInterval(this.spatial.timer);
    this.spatial.timer = null;
    this.spatial.mode = mode;
    if (mode === "orbit") {
      this.spatial.startedAt = epochNow();
      this.spatial.timer = setInterval(() => {
        this.spatial.source = orbitPosition(epochNow() - this.spatial.startedAt);
        this.broadcastSpatial();
      }, SPATIAL_TICK_MS);
    }
    this.broadcastSpatial();
  }

  setListeningSource(x, y) {
    if (!this.spatial.enabled) this.spatial.enabled = true;
    if (this.spatial.mode !== "manual") this.setSpatialMode("manual");
    this.spatial.source = { x: clampToGrid(x), y: clampToGrid(y) };
    this.broadcastSpatial();
  }

  moveClient(clientId, x, y) {
    const client = this.clients.get(clientId);
    if (!client) return;
    client.position = { x: clampToGrid(x), y: clampToGrid(y) };
    this.broadcastClients();
    if (this.spatial.enabled) this.broadcastSpatial();
  }

  broadcastSpatial() {
    if (!this.spatial.enabled) return;
    const gains = {};
    for (const c of this.clients.values()) {
      gains[c.clientId] = gainFromDistance(c.position, this.spatial.source);
    }
    // Gain changes are smoothed with a ramp, so they apply on arrival rather
    // than waiting out the full playback scheduling delay.
    this.broadcast({
      type: "SCHEDULED_ACTION",
      serverTimeToExecute: epochNow(),
      action: { type: "SPATIAL_CONFIG", gains, source: this.spatial.source, mode: this.spatial.mode, rampTime: 0.12 },
    });
  }

  // ── Chat ─────────────────────────────────────────────────────────

  addChatMessage(clientId, text) {
    const client = this.clients.get(clientId);
    const trimmed = String(text ?? "").trim().slice(0, config.maxChatLength);
    if (!client || !trimmed) return;
    const message = {
      id: this.nextChatId++,
      clientId,
      username: client.username,
      color: client.color,
      text: trimmed,
      at: Date.now(),
    };
    this.chat.push(message);
    if (this.chat.length > config.maxChatMessages) this.chat.shift();
    this.broadcastEvent({ type: "CHAT", message });
  }
}
