'use strict';
const fs = require('node:fs');
let nextAudioSession = 1;
function wavInfo(b) {
  if (b.length < 12 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return { duration: 0, size: b.length, wav: false };
  let rate = 0, size = 0, native = false;
  for (let p = 12; p + 8 <= b.length;) {
    const name = b.toString('ascii', p, p + 4), n = b.readUInt32LE(p + 4); if (p + 8 + n > b.length) throw Error('Truncated WAV');
    if (name === 'fmt ' && n >= 16) { rate = b.readUInt32LE(p + 16); native = b.readUInt16LE(p + 8) === 1 && b.readUInt16LE(p + 10) === 2 && b.readUInt32LE(p + 12) >= 8000 && b.readUInt32LE(p + 12) <= 192000 && b.readUInt16LE(p + 22) === 16; }
    if (name === 'data') size += n; p += 8 + n + (n & 1);
  }
  return { duration: rate ? Math.floor(size * 1000 / rate) : 0, size, wav: true, native };
}
module.exports = {
  audioFeedback(msg) {
    const a = this.audio;
    if (!a.session || msg.session !== a.session) return;
    if (msg.event === 'started' && a.state === 1 && Number.isFinite(msg.durationMs) &&
        msg.durationMs > 0 && msg.durationMs <= 86400000) {
      a.total = Math.round(msg.durationMs);
      a.position = Math.max(0, Math.min(a.total, Number(msg.positionMs) || 0));
      a.started = performance.now();
    } else if (msg.event === 'ended' && a.state === 1) {
      a.state = 0; a.position = a.total;
    } else if (msg.event === 'error') {
      a.state = 0; this.log(3, 'Audio output could not decode the background stream');
    }
  },
  audioPosition() { const a = this.audio; const pos = a.position + (a.state === 1 ? performance.now() - a.started : 0); if (a.total && pos >= a.total) { a.state = 0; a.position = a.total; return a.total; } return Math.floor(pos); },
  audioImports() {
    const enabled = () => this.features.has(6);
    const control = op => { if (!enabled()) return -16; const a = this.audio; a.position = this.audioPosition(); a.started = performance.now(); if (op === 'pause') { if (a.state !== 1) return -12; a.state = 2; } if (op === 'resume') { if (a.state !== 2) return -12; a.state = 1; } if (op === 'stop') { a.state = 0; a.position = 0; } this.send({ type: 'audio', op }); return 0; };
    return {
      aster_audio_get_info: (p, n) => { if (!enabled() && !this.pcmInput) return -16; if (!this.struct(p, n, 24)) return -1; [44100, 2, 16, 0].forEach((v, i) => this.u32(p + 8 + i * 4, v)); return 0; },
      aster_audio_set_volume: volume => { if (!enabled()) return -16; if (volume < 0 || volume > 100) return -1; this.volume = volume; this.send({ type: 'audio', op: 'volume', volume }); return 0; },
      aster_audio_get_volume: () => enabled() ? this.volume : -16,
      aster_audio_start_file: (p, n) => {
        if (!enabled()) return -16; const data = this.readVirtual(p, n), info = wavInfo(data);
        if (!info.wav && !(data[0] === 0xff || data.toString('ascii', 0, 3) === 'ID3')) return -3;
        this.audio = { session: nextAudioSession++, state: 1, total: info.duration, bytes: info.size, position: 0, started: performance.now() };
        this.send({ type: 'audio', op: 'start', session: this.audio.session, data, volume: this.volume }); return 0;
      },
      aster_audio_pause: () => control('pause'), aster_audio_resume: () => control('resume'), aster_audio_stop: () => control('stop'),
      aster_audio_seek: ms => { if (!enabled()) return -16; if (!this.audio.state) return -12; if (this.audio.total && ms > this.audio.total) return -1; this.audio.position = ms >>> 0; this.audio.started = performance.now(); this.send({ type: 'audio', op: 'seek', ms }); return 0; },
      aster_audio_get_state: (p, n) => {
        if (!enabled()) return -16; if (!this.struct(p, n, 32, 2)) return -1; const ms = this.audioPosition(), a = this.audio;
        [a.state, a.bytes, a.total ? Math.floor(a.bytes * ms / a.total) : 0, this.volume, ms, a.total].forEach((v, i) => this.u32(p + 8 + i * 4, v)); return 0;
      },
      aster_audio_get_lyrics: () => enabled() ? 0 : -16,
      aster_audio_effect_load: (p, n) => { if (!enabled()) return -16; const data = this.readVirtual(p, n), info = wavInfo(data); if (!info.native || info.size > 65536) return -3; if ([...this.handles.values()].filter(x => x.kind === 'effect').length >= 4) return -11; const handle = this.add('effect', { data }); this.send({ type: 'audio', op: 'effect-load', handle, data }); return handle; },
      aster_audio_effect_play: h => { if (!enabled()) return -16; this.get(h, 'effect'); this.send({ type: 'audio', op: 'effect', handle: h, volume: this.volume }); return 0; },
      aster_audio_effect_unload: h => { this.get(h, 'effect'); this.handles.delete(h); this.send({ type: 'audio', op: 'effect-unload', handle: h }); return 0; },
      aster_audio_record: (p, n) => { if (!this.pcmInput) return -16; if (n > this.pcmInput.length) return -11; this.bytes(p, n).set(this.pcmInput.subarray(0, n)); return n; },
    };
  },
  wifiImports() {
    const allowed = () => { this.permission('wifi'); return this.features.has(7); };
    const operation = (op, fn) => { if (!allowed()) return -16; this.wifi.last = op; fn(); return 0; };
    return {
      aster_wifi_scan_start: () => operation(1, () => {}),
      aster_wifi_scan_results: (p, cap) => {
        if (!allowed()) return -16; if (!cap) return 0; this.bytes(p, 56).fill(0); this.u32(p, 56); this.u32(p + 4, 1); this.output(p + 8, 'Aster Simulator', 33, true); this.u32(p + 44, -42); this.u32(p + 48, 6); this.u32(p + 52, 1); return 1;
      },
      aster_wifi_connect: (p, n, password, pn) => {
        if (!n || n > 32 || pn > 63) return -1; this.bytes(password, pn); const ssid = this.string(p, n);
        return operation(2, () => { this.wifi.ssid = this.wifi.saved = ssid; this.wifi.state = 9; });
      },
      aster_wifi_disconnect: () => operation(3, () => { this.wifi.state = 0; this.wifi.ssid = ''; }),
      aster_wifi_reconnect: () => { if (!this.wifi.saved) return -6; return operation(4, () => { this.wifi.state = 9; this.wifi.ssid = this.wifi.saved; }); },
      aster_wifi_forget: () => operation(5, () => { this.wifi.saved = ''; this.wifi.ssid = ''; this.wifi.state = 0; }),
      aster_wifi_status: (p, n) => {
        if (!allowed()) return -16; if (!this.struct(p, n, 84)) return -1;
        [this.wifi.state, 0, this.wifi.last, 0, this.wifi.state === 9 ? -42 : 0, 1].forEach((v, i) => this.u32(p + 8 + i * 4, v));
        this.output(p + 32, this.wifi.ssid, 33, true); this.output(p + 65, this.wifi.state === 9 ? '192.0.2.2' : '', 16, true); return 0;
      },
      aster_wifi_get_saved_ssid: (p, n) => { if (!allowed()) return -16; return this.wifi.saved ? this.output(p, this.wifi.saved, n, true) : -6; },
    };
  },
};
