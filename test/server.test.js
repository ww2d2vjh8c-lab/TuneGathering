import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tg-test-"));

const { server, rooms } = await import("../server/index.js");
let base;

before(async () => {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  base = `127.0.0.1:${server.address().port}`;
});

after(() => {
  for (const room of rooms.values()) room.destroy();
  server.closeAllConnections?.();
  server.close();
  fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });
  setTimeout(() => process.exit(0), 50).unref();
});

/** A scripted client that records every message it receives. */
async function client(roomId, name = "Tester") {
  const clientId = `${name}-${Math.random().toString(36).slice(2)}`;
  const ws = new WebSocket(`ws://${base}/ws?roomId=${roomId}&clientId=${clientId}&username=${encodeURIComponent(name)}`);
  const inbox = [];
  const waiters = [];
  ws.on("message", (d) => {
    const msg = JSON.parse(d.toString());
    inbox.push(msg);
    for (const w of [...waiters]) if (w.match(msg)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(msg));
  });
  await new Promise((r) => ws.once("open", r));
  const c = {
    clientId,
    ws,
    inbox,
    send: (m) => ws.send(JSON.stringify(m)),
    next(match, timeout = 4000) {
      const found = inbox.find(match);
      if (found) {
        inbox.splice(inbox.indexOf(found), 1);
        return Promise.resolve(found);
      }
      return new Promise((resolve, reject) => {
        const w = { match, resolve: (m) => (inbox.splice(inbox.indexOf(m), 1), resolve(m)) };
        waiters.push(w);
        setTimeout(() => reject(new Error("timed out waiting for message")), timeout);
      });
    },
    close: () => ws.close(),
  };
  await c.next((m) => m.type === "WELCOME");
  return c;
}

const isAction = (type) => (m) => m.type === "SCHEDULED_ACTION" && m.action.type === type;
const isEvent = (type) => (m) => m.type === "ROOM_EVENT" && m.event.type === type;

test("NTP exchange returns ordered server timestamps", async () => {
  const a = await client("100001");
  const t0 = performance.timeOrigin + performance.now();
  a.send({ type: "NTP_REQUEST", t0, rtt: 12 });
  const res = await a.next((m) => m.type === "NTP_RESPONSE");
  assert.equal(res.t0, t0);
  assert.ok(res.t2 >= res.t1, "server send time is after receive time");
  // Same machine, same clock: the computed offset should be ~0.
  const t3 = performance.timeOrigin + performance.now();
  const offset = (res.t1 - t0 + (res.t2 - t3)) / 2;
  assert.ok(Math.abs(offset) < 20, `offset ${offset}ms should be near zero`);
  a.close();
});

test("play waits for every client to load, then schedules one future start for all", async () => {
  const a = await client("100002", "Alpha");
  const b = await client("100002", "Bravo");
  a.send({ type: "ADD_DEMO_TRACKS" });
  const { event } = await b.next(isEvent("TRACKS"));
  const track = event.tracks[0];

  a.send({ type: "PLAY", trackId: track.id, trackTimeSeconds: 0 });
  await a.next(isEvent("LOAD_TRACK"));
  await b.next(isEvent("LOAD_TRACK"));

  a.send({ type: "AUDIO_LOADED", trackId: track.id, duration: track.duration });
  // Only one client has loaded: nothing may be scheduled yet.
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!a.inbox.some(isAction("PLAY")), "play must wait for the slower client");

  const sentAt = performance.timeOrigin + performance.now();
  b.send({ type: "AUDIO_LOADED", trackId: track.id, duration: track.duration });
  const [pa, pb] = await Promise.all([a.next(isAction("PLAY")), b.next(isAction("PLAY"))]);
  assert.equal(pa.serverTimeToExecute, pb.serverTimeToExecute, "both clients get the same start instant");
  assert.ok(pa.serverTimeToExecute > sentAt + 300, "start is scheduled in the future");
  assert.equal(pa.action.trackId, track.id);

  // Pause: the position handed out is where the room clock says we are.
  await new Promise((r) => setTimeout(r, pa.serverTimeToExecute - sentAt + 200));
  a.send({ type: "PAUSE" });
  const pause = await b.next(isAction("PAUSE"));
  assert.ok(pause.action.trackTimeSeconds > 0.2 && pause.action.trackTimeSeconds < 2, `paused at ${pause.action.trackTimeSeconds}s`);
  a.close();
  b.close();
});

test("a late joiner gets a play scheduled at the room's current position", async () => {
  const a = await client("100003", "Host");
  a.send({ type: "ADD_DEMO_TRACKS" });
  const { event } = await a.next(isEvent("TRACKS"));
  a.send({ type: "PLAY", trackId: event.tracks[0].id, trackTimeSeconds: 5 });
  await a.next(isEvent("LOAD_TRACK"));
  a.send({ type: "AUDIO_LOADED", trackId: event.tracks[0].id, duration: event.tracks[0].duration });
  await a.next(isAction("PLAY"));

  await new Promise((r) => setTimeout(r, 900));
  const late = await client("100003", "Late");
  late.send({ type: "SYNC" });
  const play = await late.next(isAction("PLAY"));
  assert.ok(play.action.trackTimeSeconds > 5.3, `late joiner starts ahead of 5s (got ${play.action.trackTimeSeconds})`);
  a.close();
  late.close();
});

test("admin-only mode blocks other listeners from controlling playback", async () => {
  const boss = await client("100004", "Boss");
  const guest = await client("100004", "Guest");
  boss.send({ type: "SET_PERMISSIONS", permissions: "ADMIN_ONLY" });
  await guest.next(isEvent("PERMISSIONS"));

  guest.send({ type: "ADD_DEMO_TRACKS" });
  guest.send({ type: "SET_VOLUME", volume: 0.1 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(rooms.get("100004").tracks.length, 0);
  assert.equal(rooms.get("100004").volume, 1);

  // Guests can't promote themselves either.
  guest.send({ type: "SET_PERMISSIONS", permissions: "EVERYONE" });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(rooms.get("100004").permissions, "ADMIN_ONLY");
  boss.close();
  guest.close();
});

test("admin role passes on when the last admin leaves", async () => {
  const first = await client("100005", "First");
  const second = await client("100005", "Second");
  first.close();
  const { event } = await second.next((m) => isEvent("CLIENTS")(m) && m.event.clients.length === 1);
  assert.equal(event.clients[0].isAdmin, true);
  second.close();
});

test("uploads are stored, served back, and path traversal is refused", async () => {
  const a = await client("100006");
  const body = fs.readFileSync(new URL("../data/demo/sync-check.wav", import.meta.url));
  const res = await fetch(`http://${base}/api/rooms/100006/upload`, {
    method: "PUT",
    headers: { "X-Filename": encodeURIComponent("../../evil name.wav"), "X-Client-Id": a.clientId },
    body,
  });
  assert.equal(res.status, 201);
  const { track } = await res.json();
  assert.ok(!track.file.includes("/") && !track.file.includes(".."), "stored file name is sanitised");

  const audio = await fetch(`http://${base}${track.url}`);
  assert.equal(audio.status, 200);
  assert.equal(Number(audio.headers.get("content-length")), body.length);

  const ranged = await fetch(`http://${base}${track.url}`, { headers: { Range: "bytes=0-99" } });
  assert.equal(ranged.status, 206);
  assert.equal((await ranged.arrayBuffer()).byteLength, 100);

  const escape = await fetch(`http://${base}/audio/100006/..%2F..%2Fpackage.json`);
  assert.notEqual(escape.status, 200);

  const bad = await fetch(`http://${base}/api/rooms/100006/upload`, {
    method: "PUT",
    headers: { "X-Filename": "notes.txt", "X-Client-Id": a.clientId },
    body: "hello",
  });
  assert.equal(bad.status, 415);
  a.close();
});

test("static pages are served", async () => {
  for (const p of ["/", "/room/123456", "/css/app.css", "/js/room.js", "/fonts/Anton-Regular.ttf", "/img/los-santos.svg"]) {
    const res = await fetch(`http://${base}${p}`);
    assert.equal(res.status, 200, p);
  }
  assert.equal((await fetch(`http://${base}/../server/index.js`)).status, 404);
});
