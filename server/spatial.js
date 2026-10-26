// Spatial audio: every client is a speaker on a 100×100 grid. A virtual
// "listening source" moves around the grid and each speaker's volume falls
// off with its distance from the source.

export const GRID = { SIZE: 100, CENTER: 50, CLIENT_RADIUS: 30 };

export function gainFromDistance(client, source, { falloff = 0.0011, minGain = 0.12, maxGain = 1 } = {}) {
  const dx = client.x - source.x;
  const dy = client.y - source.y;
  const gain = maxGain - falloff * (dx * dx + dy * dy);
  return Math.min(maxGain, Math.max(minGain, gain));
}

/** Spread `count` speakers evenly on a circle around the centre of the grid. */
export function circlePositions(count) {
  if (count === 1) return [{ x: GRID.CENTER, y: GRID.CENTER - GRID.CLIENT_RADIUS }];
  return Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * 2 * Math.PI - Math.PI / 2;
    return {
      x: round(GRID.CENTER + GRID.CLIENT_RADIUS * Math.cos(angle)),
      y: round(GRID.CENTER + GRID.CLIENT_RADIUS * Math.sin(angle)),
    };
  });
}

/** Position of the orbiting listening source at a given time. */
export function orbitPosition(elapsedMs, periodMs = 8_000, radius = 32) {
  const angle = (elapsedMs / periodMs) * 2 * Math.PI - Math.PI / 2;
  return {
    x: round(GRID.CENTER + radius * Math.cos(angle)),
    y: round(GRID.CENTER + radius * Math.sin(angle)),
  };
}

export const clampToGrid = (v) => Math.min(GRID.SIZE, Math.max(0, Number(v) || 0));

const round = (v) => Math.round(v * 100) / 100;
