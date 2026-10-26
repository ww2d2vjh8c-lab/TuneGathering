// Canvas view of the room's spatial-audio grid: each device is a speaker on a
// 100×100 plane, and the glowing orb is the virtual listening source. Drag the
// orb to move the sound around the room; drag your own dot to say where you are.
import { initials } from "./common.js";

const GRID_SIZE = 100;
const HIT_RADIUS = 9;

export class SpatialGrid {
  constructor(canvas, { onMoveSource, onMoveClient, canDragSource, canDragClient }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onMoveSource = onMoveSource;
    this.onMoveClient = onMoveClient;
    this.canDragSource = canDragSource;
    this.canDragClient = canDragClient;
    this.clients = [];
    this.myId = null;
    this.gains = {};
    this.source = { x: 50, y: 50 };
    this.enabled = false;
    this.drag = null;

    canvas.addEventListener("pointerdown", (e) => this.pointerDown(e));
    canvas.addEventListener("pointermove", (e) => this.pointerMove(e));
    canvas.addEventListener("pointerup", (e) => this.pointerUp(e));
    canvas.addEventListener("pointercancel", (e) => this.pointerUp(e));
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    const loop = () => {
      this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  update({ clients, myId, gains, source, enabled }) {
    if (clients) this.clients = clients;
    if (myId) this.myId = myId;
    if (gains) this.gains = gains;
    if (source && this.drag?.kind !== "source") this.source = source;
    if (enabled !== undefined) this.enabled = enabled;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const { width } = this.canvas.getBoundingClientRect();
    this.size = width;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(width * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  toGrid(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: Math.min(GRID_SIZE, Math.max(0, ((e.clientX - rect.left) / rect.width) * GRID_SIZE)),
      y: Math.min(GRID_SIZE, Math.max(0, ((e.clientY - rect.top) / rect.height) * GRID_SIZE)),
    };
  }

  pointerDown(e) {
    const p = this.toGrid(e);
    const near = (q) => Math.hypot(q.x - p.x, q.y - p.y) < HIT_RADIUS;
    if (this.canDragSource() && near(this.source)) {
      this.drag = { kind: "source" };
    } else {
      const hit = [...this.clients].reverse().find((c) => near(c.position) && this.canDragClient(c.clientId));
      if (hit) this.drag = { kind: "client", clientId: hit.clientId };
      else if (this.canDragSource()) {
        this.drag = { kind: "source" }; // tap anywhere to teleport the sound
        this.moveDrag(p);
      }
    }
    if (this.drag) this.canvas.setPointerCapture(e.pointerId);
  }

  pointerMove(e) {
    if (!this.drag) {
      const p = this.toGrid(e);
      const overSource = Math.hypot(this.source.x - p.x, this.source.y - p.y) < HIT_RADIUS && this.canDragSource();
      const overClient = this.clients.some((c) => Math.hypot(c.position.x - p.x, c.position.y - p.y) < HIT_RADIUS && this.canDragClient(c.clientId));
      this.canvas.style.cursor = overSource || overClient ? "grab" : this.canDragSource() ? "crosshair" : "default";
      return;
    }
    this.moveDrag(this.toGrid(e));
  }

  moveDrag(p) {
    if (this.drag.kind === "source") {
      this.source = p;
      this.onMoveSource(p);
    } else {
      const client = this.clients.find((c) => c.clientId === this.drag.clientId);
      if (client) client.position = p;
      this.onMoveClient(this.drag.clientId, p);
    }
  }

  pointerUp(e) {
    if (this.drag && this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this.drag = null;
  }

  draw() {
    const { ctx, size } = this;
    if (!size) return;
    const scale = size / GRID_SIZE;
    const css = getComputedStyle(document.documentElement);
    const line = css.getPropertyValue("--grid-line").trim() || "rgba(255,255,255,0.06)";
    const text = css.getPropertyValue("--text").trim() || "#fff";
    const accent = css.getPropertyValue("--mission").trim() || "#f0c850";

    ctx.clearRect(0, 0, size, size);

    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    for (let i = 1; i < 10; i++) {
      const v = Math.round(i * 10 * scale) + 0.5;
      ctx.beginPath();
      ctx.moveTo(v, 0);
      ctx.lineTo(v, size);
      ctx.moveTo(0, v);
      ctx.lineTo(size, v);
      ctx.stroke();
    }

    const sx = this.source.x * scale;
    const sy = this.source.y * scale;
    if (this.enabled) {
      // Falloff halo around the listening source.
      const halo = ctx.createRadialGradient(sx, sy, 0, sx, sy, 32 * scale);
      halo.addColorStop(0, hexA(accent, 0.38));
      halo.addColorStop(1, hexA(accent, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(sx, sy, 32 * scale, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const c of this.clients) {
      const x = c.position.x * scale;
      const y = c.position.y * scale;
      const gain = this.enabled ? this.gains[c.clientId] ?? 1 : 1;
      const r = 5.5 * scale;

      if (this.enabled) {
        ctx.strokeStyle = hexA(c.color, 0.35 + gain * 0.5);
        ctx.lineWidth = 1 + gain * 3;
        ctx.beginPath();
        ctx.arc(x, y, r + 3 + gain * 4, 0, Math.PI * 2 * gain);
        ctx.stroke();
      }
      ctx.fillStyle = c.color;
      ctx.globalAlpha = this.enabled ? 0.35 + gain * 0.65 : 1;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (c.clientId === this.myId) {
        ctx.strokeStyle = text;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.fillStyle = "#0b0b10";
      ctx.font = `600 ${Math.max(9, 4 * scale)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(initials(c.username), x, y + 0.5);
    }

    if (this.enabled) {
      ctx.fillStyle = accent;
      ctx.shadowColor = accent;
      ctx.shadowBlur = 18;
      ctx.beginPath();
      ctx.arc(sx, sy, 3.6 * scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(sx, sy, 1.4 * scale, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function hexA(hex, alpha) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim());
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}
