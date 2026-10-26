import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const config = {
  port: Number(process.env.PORT ?? 3000), // PORT=0 picks a free port (used by tests)
  host: process.env.HOST || "0.0.0.0",
  rootDir: root,
  publicDir: path.join(root, "public"),
  uploadDir: process.env.UPLOAD_DIR || path.join(root, "data", "uploads"),
  demoDir: path.join(root, "data", "demo"),
  maxUploadBytes: 60 * 1024 * 1024,
  // Delete a room (and its uploads) this long after the last person leaves.
  emptyRoomTtlMs: 60_000,
  // How long the server waits for every client to decode a track before
  // scheduling playback anyway.
  audioLoadTimeoutMs: 3_000,
  // Heartbeat: protocol-level ws pings (browsers answer them automatically,
  // even in throttled background tabs).
  heartbeatIntervalMs: 15_000,
  maxChatMessages: 200,
  maxChatLength: 2_000,
};

export const AUDIO_EXTENSIONS = new Map([
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".ogg", "audio/ogg"],
  [".oga", "audio/ogg"],
  [".opus", "audio/ogg"],
  [".m4a", "audio/mp4"],
  [".aac", "audio/aac"],
  [".flac", "audio/flac"],
  [".webm", "audio/webm"],
]);
