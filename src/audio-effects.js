'use strict';
// Deterministic source-frame timeline; independent of APP frame callbacks.
function wavEffect(data) {
  const invalid = () => { const e = Error('Invalid PCM16 effect WAV'); e.code = 'EINVAL'; throw e; };
  if (data.length < 12 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') invalid();
  const end = 8 + data.readUInt32LE(4); if (end < 12 || end > data.length) invalid();
  let fmt, pcm;
  for (let pos = 12; pos < end;) {
    if (pos + 8 > end) invalid();
    const n = data.readUInt32LE(pos + 4), next = pos + 8 + n + (n & 1), tag = data.toString('ascii', pos, pos + 4);
    if (next > end) invalid();
    const p = pos + 8;
    if (tag === 'fmt ') {
      if (fmt || n < 16) invalid();
      const channels = data.readUInt16LE(p + 2), rate = data.readUInt32LE(p + 4);
      if (data.readUInt16LE(p) !== 1 || ![1, 2].includes(channels) || rate < 8000 || rate > 48000 ||
          data.readUInt16LE(p + 14) !== 16 || data.readUInt16LE(p + 12) !== channels * 2 || data.readUInt32LE(p + 8) !== rate * channels * 2) invalid();
      fmt = { rate, channels };
    } else if (tag === 'data') {
      if (pcm || !n || n > 65536) invalid();
      pcm = { offset: p, bytes: n };
    }
    pos = next;
  }
  if (!fmt || !pcm || pcm.bytes % (fmt.channels * 2)) invalid();
  return { ...fmt, ...pcm, frames: pcm.bytes / (fmt.channels * 2) };
}
function validParams(p) { return p.pitch >= 32768 && p.pitch <= 131072 && p.gain <= 65536 && p.ms <= 1000; }
class EffectVoice {
  constructor(info) { this.info = info; this.playing = false; this.paused = false; this.phase = 0; this.pitch = this.gain = 65536; }
  sync(now) {
    let dt = Math.max(0, now - this.at); this.at = now;
    if (!this.playing || this.paused) return;
    let integral = 0;
    if (this.ramp) {
      const r = this.ramp, t = Math.min(dt, r.ms - r.elapsed), before = r.elapsed / r.ms, after = (r.elapsed + t) / r.ms;
      integral += t * (r.pitch0 + (r.pitch1 - r.pitch0) * (before + after) / 2);
      r.elapsed += t; dt -= t;
      this.pitch = r.pitch0 + (r.pitch1 - r.pitch0) * after;
      this.gain = r.gain0 + (r.gain1 - r.gain0) * after;
      if (r.elapsed >= r.ms) { this.ramp = null; if (this.stopping) { this.playing = false; this.stopping = false; dt = 0; } }
    }
    integral += dt * this.pitch;
    this.phase += integral * this.info.rate / (1000 * 65536);
    if (this.phase >= this.end) {
      if (this.loop) { const start = this.start + this.fade; this.phase = start + (this.phase - this.end) % (this.end - start); }
      else { this.phase = this.end; this.playing = false; }
    }
  }
  play(d, now) {
    const end = d.end || this.info.frames;
    if (!validParams(d) || (d.flags & ~1) || (d.flags & 1 ? d.start >= end || end > this.info.frames || d.fade > Math.floor((end - d.start) / 2) : d.start || d.end || d.fade)) return -1;
    Object.assign(this, { phase: 0, at: now, loop: !!(d.flags & 1), start: d.start, end, fade: d.fade,
      pitch: d.pitch, gain: d.ms ? 0 : d.gain, playing: true, stopping: false, ramp: null });
    this.change(d, now); return 0;
  }
  change(p, now) {
    if (!validParams(p)) return -1;
    this.sync(now); if (this.stopping) return -12;
    this.ramp = p.ms ? { pitch0: this.pitch, pitch1: p.pitch, gain0: this.gain, gain1: p.gain, elapsed: 0, ms: p.ms } : null;
    if (!p.ms) { this.pitch = p.pitch; this.gain = p.gain; }
    return 0;
  }
  stop(ms, now) {
    if (ms > 1000) return -1;
    this.sync(now); if (!this.playing) return 0;
    if (!ms) { this.playing = false; this.stopping = false; this.ramp = null; return 0; }
    // Repeating stop replaces its ramp, matching the native service.
    this.stopping = false; this.change({ pitch: Math.round(this.pitch), gain: 0, ms }, now); this.stopping = true; return 0;
  }
  suspend(paused, now) { this.sync(now); this.paused = paused; }
}
module.exports = { wavEffect, EffectVoice };
