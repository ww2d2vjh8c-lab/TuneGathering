import { performance } from "node:perf_hooks";

// Sub-millisecond wall clock. Clients use the same formula in the browser so
// both sides speak "epoch milliseconds" with fractional precision.
export const epochNow = () => performance.timeOrigin + performance.now();

/**
 * How far in the future to schedule a synchronized action. The slowest
 * client must receive the broadcast (≈ RTT/2) before the moment arrives, so
 * we give it its full RTT plus headroom, and add room for the largest local
 * output-latency compensation any client applies.
 */
export function scheduleDelayMs(maxRttMs, maxCompensationMs = 0) {
  const base = Math.min(3000, Math.max(400, maxRttMs * 1.5 + 250));
  return Math.max(base, maxCompensationMs + 200);
}
