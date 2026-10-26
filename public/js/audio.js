// Web Audio playback engine. Sample-accurate starts come from
// AudioBufferSourceNode.start(when, offset), scheduled on the AudioContext's
// own clock rather than with setTimeout.
//
// Signal chain: source → lowpass → spatial gain → room volume → analyser → speakers

const MAX_CACHED_BUFFERS = 4;

export class AudioEngine {
  constructor() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: "playback" });
    this.lowpass = this.ctx.createBiquadFilter();
    this.lowpass.type = "lowpass";
    this.lowpass.frequency.value = 20_000;
    this.spatialGain = this.ctx.createGain();
    this.volumeGain = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.78;
    this.lowpass.connect(this.spatialGain).connect(this.volumeGain).connect(this.analyser).connect(this.ctx.destination);

    this.buffers = new Map(); // trackId → Promise<AudioBuffer>
    this.source = null;
    this.current = null; // { trackId, startCtxTime, offset }
  }

  async unlock() {
    if (this.ctx.state !== "running") await this.ctx.resume();
    // iOS needs a sound started inside the gesture to fully wake the output.
    const silent = this.ctx.createBufferSource();
    silent.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
    silent.connect(this.ctx.destination);
    silent.start();
  }

  /** Device output latency in ms — the gap between scheduling a sample and hearing it. */
  outputLatencyMs() {
    const l = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    return Number.isFinite(l) ? l * 1000 : 0;
  }

  /**
   * The AudioContext time whose sample will come out of the speaker at
   * `epochMs` (wall-clock milliseconds, same base as performance.timeOrigin).
   *
   * getOutputTimestamp() pairs the frame currently leaving the speaker with
   * the performance clock, so it maps the two clocks precisely *and* already
   * includes output latency. ctx.currentTime alone moves in render-quantum
   * steps and says nothing about latency, so it's only the fallback.
   */
  ctxTimeAtEpoch(epochMs) {
    const ts = this.ctx.getOutputTimestamp?.();
    if (ts && ts.performanceTime > 0 && ts.contextTime > 0) {
      return ts.contextTime + (epochMs - (performance.timeOrigin + ts.performanceTime)) / 1000;
    }
    const now = performance.timeOrigin + performance.now();
    return this.ctx.currentTime + (epochMs - now - this.outputLatencyMs()) / 1000;
  }

  /** Inverse of ctxTimeAtEpoch. */
  epochAtCtxTime(ctxTime) {
    const ts = this.ctx.getOutputTimestamp?.();
    if (ts && ts.performanceTime > 0 && ts.contextTime > 0) {
      return performance.timeOrigin + ts.performanceTime + (ctxTime - ts.contextTime) * 1000;
    }
    return performance.timeOrigin + performance.now() + (ctxTime - this.ctx.currentTime) * 1000 + this.outputLatencyMs();
  }

  load(track) {
    if (this.buffers.has(track.id)) {
      const cached = this.buffers.get(track.id);
      this.buffers.delete(track.id); // refresh LRU order
      this.buffers.set(track.id, cached);
      return cached;
    }
    const promise = fetch(track.url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((data) => new Promise((resolve, reject) => this.ctx.decodeAudioData(data, resolve, reject)));
    promise.catch(() => this.buffers.delete(track.id));
    this.buffers.set(track.id, promise);
    while (this.buffers.size > MAX_CACHED_BUFFERS) {
      const oldest = this.buffers.keys().next().value;
      if (oldest === this.current?.trackId) break;
      this.buffers.delete(oldest);
    }
    return promise;
  }

  hasLoaded(trackId) {
    return this.buffers.has(trackId);
  }

  /**
   * Start `buffer` at `ctxTime` (AudioContext seconds) from `offset` seconds
   * into the track. If `ctxTime` is already in the past we jump ahead by the
   * difference, so a slow device joins the music where everyone else is.
   */
  playAt(trackId, buffer, ctxTime, offset) {
    this.stopNow();
    const now = this.ctx.currentTime;
    if (ctxTime < now) {
      offset += now - ctxTime;
      ctxTime = now;
    }
    if (offset >= buffer.duration) return;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.lowpass);
    source.start(ctxTime, Math.max(0, offset));
    source.onended = () => {
      if (this.source === source) {
        this.source = null;
        this.current = null;
      }
    };
    this.source = source;
    this.current = { trackId, startCtxTime: ctxTime, offset };
  }

  stopAt(ctxTime) {
    if (!this.source) return;
    const source = this.source;
    source.stop(Math.max(this.ctx.currentTime, ctxTime));
    this.source = null;
    this.current = null;
  }

  stopNow() {
    this.stopAt(0);
  }

  isPlaying() {
    return !!this.current;
  }

  /** Schedule a smooth parameter change at an AudioContext time. */
  ramp(param, value, ctxTime, rampSeconds) {
    const at = Math.max(this.ctx.currentTime, ctxTime);
    param.cancelScheduledValues(at);
    param.setValueAtTime(param.value, at);
    param.linearRampToValueAtTime(value, at + Math.max(0.01, rampSeconds));
  }

  setVolume(volume, ctxTime = 0, ramp = 0.1) {
    this.ramp(this.volumeGain.gain, volume, ctxTime, ramp);
  }

  setSpatialGain(gain, ctxTime = 0, ramp = 0.12) {
    this.ramp(this.spatialGain.gain, gain, ctxTime, ramp);
  }

  setLowPass(freq, ctxTime = 0, ramp = 0.1) {
    const at = Math.max(this.ctx.currentTime, ctxTime);
    const param = this.lowpass.frequency;
    param.cancelScheduledValues(at);
    param.setValueAtTime(param.value, at);
    // Frequency is perceived logarithmically, so ramp exponentially.
    param.exponentialRampToValueAtTime(Math.max(20, freq), at + Math.max(0.01, ramp));
  }
}
