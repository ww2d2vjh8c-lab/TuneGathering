import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { AUDIO_EXTENSIONS, config } from "./config.js";
import { Room } from "./room.js";
import { epochNow } from "./time.js";
import { ensureDemoTracks, DEMO_TRACKS } from "../scripts/generate-demo-tracks.js";

const rooms = new Map();
const ROOM_ID = /^\d{6}$/;

function getOrCreateRoom(id) {
  let room = rooms.get(id);
  if (!room) {
    room = new Room(id, { onEmpty: (r) => rooms.delete(r.id) });
    rooms.set(id, room);
  }
  return room;
}

// ── WebSocket message handlers ─────────────────────────────────────
// Each handler receives (room, clientId, message). Handlers that change what
// everyone hears are gated by the room's playback permissions.

const control = (fn) => (room, clientId, msg) => {
  if (room.canControl(clientId)) fn(room, clientId, msg);
};
const adminOnly = (fn) => (room, clientId, msg) => {
  if (room.isAdmin(clientId)) fn(room, clientId, msg);
};

const handlers = {
  NTP_REQUEST(room, clientId, msg, receivedAt) {
    room.send(clientId, { type: "NTP_RESPONSE", t0: msg.t0, t1: receivedAt, t2: epochNow() });
    room.updateClientStats(clientId, msg);
  },
  SYNC: (room, clientId) => room.syncLateJoiner(clientId),
  AUDIO_LOADED: (room, clientId, msg) => room.onAudioLoaded(clientId, msg),

  PLAY: control((room, _id, msg) => room.requestPlay(msg.trackId, msg.trackTimeSeconds)),
  PAUSE: control((room) => room.pause()),
  NEXT: control((room) => room.skip(1)),
  PREVIOUS: control((room) => room.skip(-1)),
  SET_VOLUME: control((room, _id, msg) => room.setVolume(msg.volume)),
  SET_LOW_PASS: control((room, _id, msg) => room.setLowPass(msg.freq)),
  DELETE_TRACK: control((room, _id, msg) => room.deleteTrack(msg.trackId)),
  MOVE_TRACK: control((room, _id, msg) => room.moveTrack(msg.trackId, msg.direction)),
  ADD_DEMO_TRACKS: control((room) => {
    for (const demo of DEMO_TRACKS) {
      if (room.tracks.some((t) => t.demoId === demo.id)) continue;
      room.tracks.push({
        id: crypto.randomUUID(),
        demoId: demo.id,
        name: demo.name,
        artist: "TuneGathering demo",
        url: `/demo/${demo.file}`,
        duration: demo.duration,
        addedBy: "TuneGathering",
      });
    }
    room.broadcastTracks();
  }),

  START_SPATIAL: control((room) => room.startSpatial()),
  STOP_SPATIAL: control((room) => room.stopSpatial()),
  SET_SPATIAL_MODE: control((room, _id, msg) => {
    if (room.spatial.enabled && (msg.mode === "orbit" || msg.mode === "manual")) room.setSpatialMode(msg.mode);
  }),
  SET_LISTENING_SOURCE: control((room, _id, msg) => room.setListeningSource(msg.x, msg.y)),
  MOVE_CLIENT(room, clientId, msg) {
    // Anyone can move their own speaker; controllers can arrange everyone.
    if (msg.clientId === clientId || room.canControl(clientId)) room.moveClient(msg.clientId, msg.x, msg.y);
  },

  CHAT: (room, clientId, msg) => room.addChatMessage(clientId, msg.text),
  SET_USERNAME(room, clientId, msg) {
    const name = String(msg.username ?? "").trim().slice(0, 32);
    if (!name) return;
    room.clients.get(clientId).username = name;
    room.broadcastClients();
  },
  SET_PERMISSIONS: adminOnly((room, _id, msg) => {
    if (msg.permissions !== "EVERYONE" && msg.permissions !== "ADMIN_ONLY") return;
    room.permissions = msg.permissions;
    room.broadcastEvent({ type: "PERMISSIONS", permissions: room.permissions });
  }),
  SET_ADMIN: adminOnly((room, clientId, msg) => {
    const target = room.clients.get(msg.clientId);
    if (!target || msg.clientId === clientId) return; // can't demote yourself into an admin-less room
    target.isAdmin = !!msg.isAdmin;
    room.broadcastClients();
  }),
};

// ── HTTP ───────────────────────────────────────────────────────────

const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Serve a file from `baseDir`, refusing anything that escapes it. */
function serveFile(req, res, baseDir, relPath, contentType) {
  const filePath = path.resolve(baseDir, "." + path.sep + relPath);
  if (!filePath.startsWith(path.resolve(baseDir) + path.sep)) return sendJson(res, 403, { error: "Forbidden" });

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return sendJson(res, 404, { error: "Not found" });
    const type = contentType || STATIC_TYPES[path.extname(filePath)] || AUDIO_EXTENSIONS.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
    const headers = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" };

    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
      if (start > end || start >= stat.size) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": end - start + 1 });
      return req.method === "HEAD" ? res.end() : fs.createReadStream(filePath, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, "Content-Length": stat.size });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

function handleUpload(req, res, roomId) {
  const room = rooms.get(roomId);
  if (!room) return sendJson(res, 404, { error: "Room not found — join it first" });
  const clientId = String(req.headers["x-client-id"] || "");
  if (!room.canControl(clientId)) return sendJson(res, 403, { error: "Only admins can add tracks in this room" });

  const originalName = decodeURIComponent(String(req.headers["x-filename"] || "track"));
  const ext = path.extname(originalName).toLowerCase();
  if (!AUDIO_EXTENSIONS.has(ext)) return sendJson(res, 415, { error: `Unsupported file type "${ext || "none"}"` });
  const declared = Number(req.headers["content-length"]);
  if (declared > config.maxUploadBytes) return sendJson(res, 413, { error: "File is larger than 60 MB" });

  const safeBase = path.basename(originalName, ext).replace(/[^\w\- .()]+/g, "_").slice(0, 80) || "track";
  const file = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}-${safeBase}${ext}`;
  fs.mkdirSync(room.uploadDir(), { recursive: true });
  const dest = path.join(room.uploadDir(), file);
  const out = fs.createWriteStream(dest);

  let received = 0;
  let aborted = false;
  req.on("data", (chunk) => {
    received += chunk.length;
    if (received > config.maxUploadBytes && !aborted) {
      aborted = true;
      out.destroy();
      fs.rm(dest, { force: true }, () => {});
      sendJson(res, 413, { error: "File is larger than 60 MB" });
      req.destroy();
    }
  });
  req.pipe(out);
  out.on("finish", () => {
    if (aborted) return;
    if (!rooms.has(roomId)) {
      fs.rm(dest, { force: true }, () => {});
      return sendJson(res, 410, { error: "Room closed during upload" });
    }
    const track = {
      id: crypto.randomUUID(),
      name: safeBase,
      artist: null,
      url: `/audio/${roomId}/${encodeURIComponent(file)}`,
      file,
      duration: null,
      addedBy: room.clients.get(clientId)?.username ?? "someone",
    };
    room.addTrack(track);
    sendJson(res, 201, { track });
  });
  out.on("error", () => !aborted && sendJson(res, 500, { error: "Could not save file" }));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "rooms" && ROOM_ID.test(parts[2]) && parts[3] === "upload") {
    return handleUpload(req, res, parts[2]);
  }
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "Method not allowed" });

  if (url.pathname === "/api/health") return sendJson(res, 200, { ok: true, rooms: rooms.size, serverTime: epochNow() });
  if (url.pathname === "/api/features") {
    return sendJson(res, 200, { pricedownFont: fs.existsSync(path.join(config.publicDir, "fonts", "pricedown.otf")) });
  }
  if (url.pathname === "/api/rooms") {
    const active = [...rooms.values()].filter((r) => r.clients.size > 0).map((r) => r.summary());
    return sendJson(res, 200, { rooms: active.sort((a, b) => b.listeners - a.listeners).slice(0, 20) });
  }
  if (parts[0] === "audio" && ROOM_ID.test(parts[1]) && parts[2]) {
    return serveFile(req, res, path.join(config.uploadDir, parts[1]), decodeURIComponent(parts[2]));
  }
  if (parts[0] === "demo" && parts[1]) return serveFile(req, res, config.demoDir, parts[1]);
  if (parts[0] === "room" && ROOM_ID.test(parts[1] ?? "")) return serveFile(req, res, config.publicDir, "room.html");
  if (url.pathname === "/") return serveFile(req, res, config.publicDir, "index.html");
  return serveFile(req, res, config.publicDir, url.pathname.slice(1));
});

// ── WebSocket ──────────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 256 * 1024 });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const roomId = url.searchParams.get("roomId") ?? "";
  const clientId = (url.searchParams.get("clientId") || crypto.randomUUID()).slice(0, 64);
  const username = (url.searchParams.get("username") || "Listener").trim().slice(0, 32) || "Listener";
  if (!ROOM_ID.test(roomId)) return ws.close(4001, "Room codes are 6 digits");

  const room = getOrCreateRoom(roomId);
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
  room.addClient(ws, { clientId, username });

  ws.on("message", (data) => {
    const receivedAt = epochNow(); // stamp before parsing so NTP t1 is tight
    ws.isAlive = true;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const handler = handlers[msg?.type];
    if (!handler || rooms.get(roomId) !== room || !room.clients.has(clientId)) return;
    try {
      handler(room, clientId, msg, receivedAt);
    } catch (err) {
      console.error(`[room ${roomId}] ${msg.type} failed:`, err);
    }
  });
  ws.on("close", () => room.removeClient(clientId, ws));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, config.heartbeatIntervalMs);

// ── Boot ───────────────────────────────────────────────────────────

ensureDemoTracks(config.demoDir);

server.listen(config.port, config.host, () => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => `http://${i.address}:${config.port}`);
  console.log(`\n  🎶 TuneGathering is live\n`);
  console.log(`  Local:   http://localhost:${config.port}`);
  for (const addr of lan) console.log(`  Network: ${addr}`);
  console.log("");
});

function shutdown() {
  clearInterval(heartbeat);
  for (const room of rooms.values()) room.destroy();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export { server, rooms };
