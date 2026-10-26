// Synthesizes a few small, royalty-free demo tracks as WAV files so a fresh
// install has something to play. Runs automatically on server start if the
// files are missing; `npm run demo-tracks` regenerates them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SAMPLE_RATE = 22_050;

const beatsToSeconds = (bpm, beats) => (60 / bpm) * beats;

export const DEMO_TRACKS = [
  { id: "neon-pulse", name: "Neon Pulse", file: "neon-pulse.wav", bpm: 124, bars: 16, render: renderNeonPulse },
  { id: "midnight-drift", name: "Midnight Drift", file: "midnight-drift.wav", bpm: 84, bars: 12, render: renderMidnightDrift },
  { id: "sync-check", name: "Sync Check (click track)", file: "sync-check.wav", bpm: 120, bars: 16, render: renderClickTrack },
].map((t) => ({ ...t, duration: beatsToSeconds(t.bpm, t.bars * 4) }));

export function ensureDemoTracks(dir, { force = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  for (const track of DEMO_TRACKS) {
    const file = path.join(dir, track.file);
    if (!force && fs.existsSync(file)) continue;
    const samples = track.render(track);
    fs.writeFileSync(file, encodeWav(samples));
    console.log(`  generated demo track: ${track.file}`);
  }
}

// ── Synthesis helpers ──────────────────────────────────────────────

function buffer(seconds) {
  return new Float32Array(Math.ceil(seconds * SAMPLE_RATE));
}

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const midiToHz = (n) => 440 * 2 ** ((n - 69) / 12);

/** Add a voice to `out` starting at `start` seconds. `fn(t)` returns a sample. */
function addVoice(out, start, length, fn, gain = 1) {
  const s0 = Math.floor(start * SAMPLE_RATE);
  const n = Math.floor(length * SAMPLE_RATE);
  for (let i = 0; i < n && s0 + i < out.length; i++) out[s0 + i] += fn(i / SAMPLE_RATE) * gain;
}

const kick = (t) => Math.sin(2 * Math.PI * (50 * t + 90 * (1 - Math.exp(-t * 30)) / 30)) * Math.exp(-t * 7);

function noiseHit(rand, decay, tone = 0.5) {
  let prev = 0;
  return (t) => {
    const white = rand() * 2 - 1;
    const hp = white - prev * tone; // crude high-pass for brightness
    prev = white;
    return hp * Math.exp(-t * decay);
  };
}

function saw(freq, t) {
  const p = (freq * t) % 1;
  return 2 * p - 1;
}

/** One-pole low-pass over a voice to tame harsh waveforms. */
function lowpassed(fn, cutoff) {
  const a = Math.exp((-2 * Math.PI * cutoff) / SAMPLE_RATE);
  let y = 0;
  return (t) => (y = (1 - a) * fn(t) + a * y);
}

function envelope(t, length, attack = 0.01, release = 0.08) {
  if (t < attack) return t / attack;
  if (t > length - release) return Math.max(0, (length - t) / release);
  return 1;
}

function normalize(out, peak = 0.89) {
  let max = 0;
  for (const v of out) max = Math.max(max, Math.abs(v));
  if (max === 0) return out;
  const k = peak / max;
  for (let i = 0; i < out.length; i++) out[i] = Math.tanh(out[i] * k * 1.1) / Math.tanh(1.1);
  // Short fade in/out so loops and track changes never click.
  const fade = Math.floor(0.02 * SAMPLE_RATE);
  for (let i = 0; i < fade; i++) {
    out[i] *= i / fade;
    out[out.length - 1 - i] *= i / fade;
  }
  return out;
}

// ── Tracks ─────────────────────────────────────────────────────────

function renderNeonPulse({ bpm, bars, duration }) {
  const out = buffer(duration);
  const beat = 60 / bpm;
  const rand = mulberry32(7);
  const chords = [
    [57, 60, 64], // Am
    [53, 57, 60], // F
    [48, 52, 55], // C
    [55, 59, 62], // G
  ];
  const bassRoots = [45, 41, 48, 43];

  for (let b = 0; b < bars * 4; b++) {
    const t = b * beat;
    const bar = Math.floor(b / 4);
    addVoice(out, t, beat, kick, 0.9);
    addVoice(out, t + beat / 2, 0.08, noiseHit(rand, 60), 0.18); // off-beat hat
    if (b % 4 === 1 || b % 4 === 3) addVoice(out, t, 0.25, noiseHit(rand, 18, 0.2), 0.3); // clap

    if (bar >= 2) {
      // Rolling eighth-note bass, ducked under the kick.
      const root = midiToHz(bassRoots[bar % 4]);
      for (const half of [0, 1]) {
        const len = beat / 2;
        addVoice(out, t + half * len, len, lowpassed((x) => saw(root * (half ? 2 : 1), x) * envelope(x, len, 0.005, 0.05), 400), half ? 0.22 : 0.16);
      }
    }
    if (bar >= 4 && b % 4 === 0) {
      // Saw-pad chord, one per bar.
      const len = beat * 4;
      for (const note of chords[bar % 4]) {
        const f = midiToHz(note + 12);
        addVoice(out, t, len, lowpassed((x) => (saw(f, x) + saw(f * 1.005, x)) * 0.5 * envelope(x, len, 0.3, 0.6), 1800), 0.07);
      }
    }
    if (bar >= 8 && b % 2 === 0) {
      // Arpeggio pluck.
      const notes = chords[bar % 4];
      const f = midiToHz(notes[(b / 2) % 3] + 24);
      addVoice(out, t + beat * 0.75, 0.3, (x) => Math.sin(2 * Math.PI * f * x) * Math.exp(-x * 9), 0.12);
    }
  }
  return normalize(out);
}

function renderMidnightDrift({ bpm, bars, duration }) {
  const out = buffer(duration);
  const beat = 60 / bpm;
  const rand = mulberry32(42);
  const chords = [
    [62, 65, 69, 72], // Dm7
    [55, 59, 62, 65], // G7
    [60, 64, 67, 71], // Cmaj7
    [57, 60, 64, 67], // Am7
  ];

  // Vinyl crackle bed.
  for (let i = 0; i < out.length; i++) {
    out[i] += (rand() * 2 - 1) * 0.006;
    if (rand() < 0.0004) out[i] += (rand() * 2 - 1) * 0.25;
  }

  for (let b = 0; b < bars * 4; b++) {
    const t = b * beat;
    const bar = Math.floor(b / 4);
    const swing = b % 2 === 1 ? beat * 0.08 : 0;
    if (b % 4 === 0) addVoice(out, t, beat, (x) => kick(x * 0.8), 0.7);
    if (b % 4 === 2) addVoice(out, t + beat * 0.5, beat, (x) => kick(x * 0.8), 0.45);
    if (b % 4 === 1 || b % 4 === 3) addVoice(out, t + swing, 0.3, noiseHit(rand, 14, 0.1), 0.25); // snare
    addVoice(out, t + swing, 0.05, noiseHit(rand, 80), 0.07);
    addVoice(out, t + beat / 2 + swing, 0.05, noiseHit(rand, 80), 0.05);

    if (b % 4 === 0) {
      // Electric-piano chord with gentle tremolo.
      const len = beat * 4;
      for (const note of chords[bar % 4]) {
        const f = midiToHz(note);
        addVoice(out, t, len, (x) => {
          const trem = 0.85 + 0.15 * Math.sin(2 * Math.PI * 4 * x);
          const tone = Math.sin(2 * Math.PI * f * x) + 0.3 * Math.sin(4 * Math.PI * f * x) * Math.exp(-x * 3);
          return tone * trem * Math.exp(-x * 0.6) * envelope(x, len, 0.01, 0.3);
        }, 0.06);
      }
      const root = midiToHz(chords[bar % 4][0] - 24);
      addVoice(out, t, beat * 2.5, (x) => Math.sin(2 * Math.PI * root * x) * envelope(x, beat * 2.5, 0.02, 0.3), 0.3);
    }
  }
  return normalize(out, 0.8);
}

function renderClickTrack({ bpm, bars, duration }) {
  const out = buffer(duration);
  const beat = 60 / bpm;
  for (let b = 0; b < bars * 4; b++) {
    const accent = b % 4 === 0;
    const f = accent ? 1760 : 880;
    addVoice(out, b * beat, 0.06, (x) => Math.sin(2 * Math.PI * f * x) * Math.exp(-x * 60), accent ? 1 : 0.6);
  }
  return normalize(out, 0.8);
}

// ── WAV encoding (16-bit PCM mono) ─────────────────────────────────

function encodeWav(samples) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  }
  return buf;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "demo");
  ensureDemoTracks(dir, { force: true });
}
