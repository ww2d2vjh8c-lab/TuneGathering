# TuneGathering

**Every device. One sound.** TuneGathering turns the phones and laptops in a room into one speaker system. Everyone joins a 6-digit session in the browser. When someone presses play, every device starts the track on the same instant, typically within a millisecond on a local network.

The interface is styled after the GTA V pause menu and HUD. It uses original artwork and open-licensed fonts, and no Rockstar assets.

## Quick start

```bash
npm install
npm start
```

Open **http://localhost:3000**. The server also prints a `Network:` address. Open that address on other devices on the same Wi-Fi, join the same session code, and press play.

**Or run it in GitHub Codespaces:** open the repo, then **Code → Codespaces → Create codespace**. Dependencies install, the server starts, and port 3000 opens in your browser automatically. To let phones join, set port 3000's visibility to **Public** in the Ports tab and share that URL.

Three demo tracks are synthesized on first start, so there's music immediately. One of them is a click track, which makes it easy to hear whether devices line up.

| Command | What it does |
| --- | --- |
| `npm start` | Run the server on port 3000 (`PORT=8080 npm start` to change) |
| `npm run dev` | Same, restarting on server file changes |
| `npm test` | Integration tests: sync protocol, coordinated play, permissions, uploads |
| `npm run demo-tracks` | Regenerate the demo WAVs in `data/demo/` |

> Browsers only give full audio and clipboard access to `localhost` or HTTPS. Other devices on your LAN open the `http://<ip>:3000` address, which works for playback in Chrome and Safari. If a browser refuses, put the server behind HTTPS (e.g. a tunnel such as `cloudflared` or `ngrok`).

## Features

- **Millisecond sync**: NTP-style clock sync over the WebSocket, with sample-accurate starts scheduled on each device's Web Audio clock
- **Coordinated play**: the server waits until every device has downloaded and decoded the track, then schedules one shared start time
- **Late joiners** drop into the song at the right position
- **Spatial audio**: devices sit on a radar grid, and a sound source orbits or is dragged around. Each device's volume follows its distance from the source
- **Shared controls**: queue, reorder, seek, skip, room volume, a low-pass "muffle" filter, uploads (MP3/WAV/OGG/M4A/FLAC, up to 60 MB), chat
- **Bosses (admins)**: lock controls to admins only, promote others. If the last admin leaves, the role passes on automatically
- **Per-device timing nudge** for Bluetooth speakers, plus live sync diagnostics

## How the sync works

1. **Clock offset.** Each client sends bursts of `NTP_REQUEST {t0}`. The server stamps receive (`t1`) and send (`t2`) times, and the client notes arrival (`t3`):
   `offset = ((t1 − t0) + (t2 − t3)) / 2`, `rtt = (t3 − t0) − (t2 − t1)`.
   Queuing can only make a round trip longer, so the client trusts the offset from its **lowest-RTT** sample (`public/js/sync.js`).
2. **Load, then schedule.** On play, the server broadcasts `LOAD_TRACK`. Clients fetch and decode the track and answer `AUDIO_LOADED`. Once every client has answered, or after 3 s, the server broadcasts `SCHEDULED_ACTION {serverTimeToExecute}`. That start time sits far enough ahead for the slowest client's RTT to cover (`server/room.js`).
3. **Hit the speaker on time.** Each client converts the server timestamp into AudioContext time with `getOutputTimestamp()`. That call maps the audio clock to the wall clock and already includes the device's output latency. The track then starts with `AudioBufferSourceNode.start(when, offset)` (`public/js/audio.js`). A device that is late skips ahead by the amount it missed, so it stays in step instead of trailing behind.

## Project layout

```
server/
  index.js        HTTP routes, uploads, WebSocket message handlers
  room.js         Room state: clients, queue, playback clock, scheduling, spatial audio, chat
  spatial.js      Grid layout + distance → gain falloff
  time.js         High-resolution clock and schedule-delay heuristic
scripts/
  generate-demo-tracks.js   Synthesizes the demo WAVs
public/
  index.html, js/landing.js         Loading-screen landing page
  room.html,  js/room.js            Pause-menu room UI
  js/sync.js, js/audio.js           Clock sync and Web Audio engine
  js/spatial-grid.js                Radar canvas
  css/app.css                       Design system
  fonts/, img/                      OFL fonts and original artwork
test/server.test.js                 Integration tests (node:test + real WebSocket clients)
```

State is in memory. A room and its uploads (`data/uploads/<room>`) are deleted 60 s after the last person leaves.

## Credits & references

- The sync architecture was studied from [freeman-jiang/beatsync](https://github.com/freeman-jiang/beatsync) (MIT), the open-source project behind beatsync.gg. TuneGathering is an independent, simplified implementation in plain Node and browser JavaScript.
- UI conventions (pause-menu tabs, notification feed, loading screens) were studied from FiveM community projects such as [project-error/pe-basicloading](https://github.com/project-error/pe-basicloading) and [F5-Studio-FiveM/GTA-VI-HUD-FIVEM](https://github.com/F5-Studio-FiveM/GTA-VI-HUD-FIVEM). No code or assets were copied.
- Fonts: Anton, Barlow, Barlow Condensed (SIL OFL) and Yellowtail (Apache 2.0) from [google/fonts](https://github.com/google/fonts). See `public/fonts/README.md` for how to use Pricedown if you have it.

GTA and Grand Theft Auto are trademarks of Take-Two Interactive. This is a fan-styled project, not affiliated with or endorsed by Rockstar Games.

## License

MIT
