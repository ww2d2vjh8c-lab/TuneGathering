// NTP-style clock synchronisation over the room WebSocket.
//
//   client sends t0 ──► server stamps t1 (receive) and t2 (send) ──► client gets it at t3
//   offset = ((t1 - t0) + (t2 - t3)) / 2      round trip = (t3 - t0) - (t2 - t1)
//
// Queuing delay can only ever make a round trip *longer*, so the sample with
// the smallest round trip is the least contaminated: we use its offset
// (RFC 5905 §10 "clock filter" idea).
import { epochNow } from "./common.js";

const BURST_COUNT = 30;
const BURST_INTERVAL_MS = 40;
const STEADY_INTERVAL_MS = 2_000;
const WINDOW = 40;
export const SYNCED_AFTER = 10;

export class ClockSync {
  constructor(send, { getCompensationMs = () => 0, onUpdate = () => {} } = {}) {
    this.send = send;
    this.getCompensationMs = getCompensationMs;
    this.onUpdate = onUpdate;
    this.measurements = [];
    this.offset = 0;
    this.rtt = 0;
    this.sent = 0;
    this.timer = null;
  }

  get synced() {
    return this.measurements.length >= SYNCED_AFTER;
  }

  get progress() {
    return Math.min(1, this.measurements.length / SYNCED_AFTER);
  }

  /** Current server time as best this client can estimate it. */
  serverNow() {
    return epochNow() + this.offset;
  }

  /** Milliseconds until a server timestamp (negative if it has passed). */
  msUntil(serverTime) {
    return serverTime - this.serverNow();
  }

  start() {
    this.stop();
    this.sent = 0;
    const tick = () => {
      this.probe();
      const delay = this.sent < BURST_COUNT ? BURST_INTERVAL_MS : STEADY_INTERVAL_MS;
      this.timer = setTimeout(tick, delay);
    };
    tick();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** Forget old measurements (e.g. after a reconnect: the path may have changed). */
  reset() {
    this.measurements = [];
    this.onUpdate(this);
  }

  probe() {
    this.sent++;
    this.send({ type: "NTP_REQUEST", t0: epochNow(), rtt: this.rtt, compensationMs: this.getCompensationMs() });
  }

  handleResponse({ t0, t1, t2 }) {
    const t3 = epochNow();
    const roundTrip = t3 - t0 - (t2 - t1);
    if (!(roundTrip >= 0)) return;
    const offset = (t1 - t0 + (t2 - t3)) / 2;

    this.measurements.push({ roundTrip, offset, at: t3 });
    if (this.measurements.length > WINDOW) this.measurements.shift();

    let best = this.measurements[0];
    for (const m of this.measurements) if (m.roundTrip < best.roundTrip) best = m;
    this.offset = best.offset;

    const recent = this.measurements.slice(-10);
    this.rtt = recent.reduce((sum, m) => sum + m.roundTrip, 0) / recent.length;
    this.onUpdate(this);
  }

  /** Spread of offsets among the best samples — a rough error bar for the UI. */
  get jitter() {
    const sorted = [...this.measurements].sort((a, b) => a.roundTrip - b.roundTrip).slice(0, 5);
    if (sorted.length < 2) return 0;
    const mean = sorted.reduce((s, m) => s + m.offset, 0) / sorted.length;
    return Math.sqrt(sorted.reduce((s, m) => s + (m.offset - mean) ** 2, 0) / sorted.length);
  }
}
