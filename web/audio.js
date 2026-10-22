(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AsterAudioPlayer = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  class AsterAudioPlayer {
    constructor(options) {
      this.send = options.send; this.status = options.status || (() => {});
      this.stats = options.stats || (() => {}); this.musicStarts = 0; this.effectPlays = 0;
      this.error = options.error || (() => {});
      this.createContext = options.createContext || (() => new AudioContext());
      this.context = null; this.music = null; this.pending = null;
      this.generation = 0; this.effects = new Map(); this.playSerial = new Map();
      this.activeEffects = new Map(); this.controls = []; this.effectsPaused = false;
    }
    async enable() {
      if (!this.context) {
        this.context = this.createContext(); this.gain = this.context.createGain();
        this.gain.connect(this.context.destination);
      }
      await this.context.resume();
      await Promise.all([...this.effects.values()].map(entry => this.decodeEffect(entry)));
      this.status('声音已启用');
      const pending = this.pending, controls = this.controls;
      this.pending = null; this.controls = [];
      if (pending) await this.handle(pending);
      for (const control of controls) await this.handle(control);
    }
    async decode(data) {
      const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
      return this.context.decodeAudioData(bytes.buffer);
    }
    decodeEffect(entry) {
      if (!this.context) return Promise.resolve(null);
      if (!entry.decoded) entry.decoded = this.decode(entry.data);
      return entry.decoded;
    }
    stopMusic() {
      this.generation++;
      const old = this.music; this.music = null;
      if (old?.source) { old.source.onended = null; try { old.source.stop(); } catch {} }
    }
    stopEffect(handle) {
      const source = this.activeEffects.get(handle); this.activeEffects.delete(handle);
      if (source) { clearTimeout(source.effect?.timer); source.onended = null; try { source.stop(); } catch {} source.disconnect?.(); source.effect?.node.disconnect?.(); }
    }
    effectValues(source) {
      const v = source.effect;
      if (!v.ramp || this.effectsPaused) return { pitch: v.pitch, gain: v.gain, remaining: v.ramp?.ms || 0 };
      const elapsed = Math.min(v.ramp.ms, Math.max(0, (this.context.currentTime - v.ramp.at) * 1000));
      const t = elapsed / v.ramp.ms;
      return { pitch: v.pitch + (v.ramp.pitch - v.pitch) * t,
        gain: v.gain + (v.ramp.gain - v.gain) * t, remaining: v.ramp.ms - elapsed };
    }
    effectParams(source, p, stopping = false) {
      if (!source?.effect) return;
      const v = source.effect, current = this.effectValues(source), now = this.context.currentTime;
      clearTimeout(v.timer); v.pitch = current.pitch; v.gain = current.gain;
      v.ramp = p.ms ? { pitch: p.pitch, gain: p.gain, ms: p.ms, at: now } : null;
      v.stopping = stopping;
      if (!p.ms) { v.pitch = p.pitch; v.gain = p.gain; }
      for (const [param, value, target] of [[source.playbackRate, v.pitch / 65536, p.pitch / 65536],
          [v.node.gain, v.gain / 65536, p.gain / 65536]]) {
        param.cancelScheduledValues(now); param.setValueAtTime(value, now);
        if (p.ms && !this.effectsPaused) param.linearRampToValueAtTime(target, now + p.ms / 1000);
      }
      if (this.effectsPaused) source.playbackRate.setValueAtTime(0, now);
      if (stopping && !this.effectsPaused) v.timer = setTimeout(() => {
        if (this.activeEffects.get(v.handle) === source) this.stopEffect(v.handle);
      }, p.ms);
    }
    suspendEffects(paused) {
      if (paused === this.effectsPaused) return;
      const states = [...this.activeEffects.values()].map(source => ({ source,
        values: this.effectValues(source), ramp: source.effect?.ramp, stopping: source.effect?.stopping }));
      this.effectsPaused = paused;
      for (const { source, values, ramp, stopping } of states) {
        if (!source.effect) continue;
        source.effect.pitch = values.pitch; source.effect.gain = values.gain; source.effect.ramp = null;
        this.effectParams(source, { pitch: ramp ? ramp.pitch : values.pitch,
          gain: ramp ? ramp.gain : values.gain, ms: ramp ? values.remaining : 0 }, stopping);
      }
    }
    loopBuffer(buffer, d, info) {
      if (!d?.fade) return buffer;
      const rate = buffer.sampleRate, sourceRate = info.rate;
      const end = Math.round((d.end || info.frames) * rate / sourceRate);
      const start = Math.round(d.start * rate / sourceRate), fade = Math.round(d.fade * rate / sourceRate);
      const result = this.context.createBuffer(buffer.numberOfChannels, end, rate);
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        const input = buffer.getChannelData(c), out = result.getChannelData(c); out.set(input.subarray(0, end));
        for (let i = 0; i < fade; i++) out[end - fade + i] = input[end - fade + i] * (1 - i / fade) + input[start + i] * (i / fade);
      }
      return result;
    }
    playMusic(buffer, session, offset = 0) {
      const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.gain);
      offset = Math.max(0, Math.min(offset, buffer.duration));
      this.music = { source, buffer, session, offset, started: this.context.currentTime };
      source.onended = () => {
        if (this.music?.source !== source) return;
        this.music = null;
        this.send({ type: 'audio-feedback', session, event: 'ended', durationMs: Math.round(buffer.duration * 1000) });
        this.status('背景音乐播放结束');
      };
      source.start(0, offset);
      this.musicStarts++; this.stats({ musicStarts: this.musicStarts, effectPlays: this.effectPlays });
      this.send({ type: 'audio-feedback', session, event: 'started',
        durationMs: Math.round(buffer.duration * 1000), positionMs: Math.round(offset * 1000) });
      this.status('背景音乐播放中');
    }
    async handle(msg) {
      try {
        if (msg.op === 'effect-load') {
          const entry = { data: msg.data, info: msg.info }; this.effects.set(msg.handle, entry);
          if (this.context) await this.decodeEffect(entry); return;
        }
        if (msg.op === 'effect-unload') {
          this.stopEffect(msg.handle); this.effects.delete(msg.handle); this.playSerial.delete(msg.handle);
          this.controls = this.controls.filter(m => m.handle !== msg.handle); return;
        }
        if (msg.op === 'effect-suspend') { this.suspendEffects(msg.paused); return; }
        if (msg.op === 'effect-stop') {
          this.playSerial.set(msg.handle, (this.playSerial.get(msg.handle) || 0) + 1);
          this.controls = this.controls.filter(m => m.handle !== msg.handle);
          const source = this.activeEffects.get(msg.handle);
          if (!msg.ms) this.stopEffect(msg.handle);
          else if (source?.effect) this.effectParams(source, { pitch: this.effectValues(source).pitch, gain: 0, ms: msg.ms }, true);
          return;
        }
        if (msg.op === 'effect-params') {
          const source = this.activeEffects.get(msg.handle);
          if (source?.effect && !source.effect.stopping) this.effectParams(source, msg.params);
          else if (this.effects.has(msg.handle)) {
            if (!this.context) this.controls.push(msg);
            else this.effects.get(msg.handle).pendingParams = msg.params;
          }
          return;
        }
        if (msg.op === 'stop') {
          this.pending = null; this.controls = []; this.stopMusic();
          for (const handle of this.activeEffects.keys()) this.stopEffect(handle);
          for (const [handle, serial] of this.playSerial) this.playSerial.set(handle, serial + 1);
          this.status('音频已停止'); return;
        }
        if (!this.context || this.context.state !== 'running') {
          if (msg.op === 'start') { this.pending = msg; this.controls = []; }
          else if (['pause', 'resume', 'seek', 'volume', 'effect'].includes(msg.op)) this.controls.push(msg);
          return;
        }
        if (msg.volume !== undefined) this.gain.gain.value = msg.volume / 100;
        if (msg.op === 'start') {
          this.stopMusic(); const generation = this.generation, buffer = await this.decode(msg.data);
          if (generation === this.generation) this.playMusic(buffer, msg.session);
        } else if (msg.op === 'effect') {
          const entry = this.effects.get(msg.handle); if (!entry) throw Error('Missing effect ' + msg.handle);
          entry.pendingParams = null;
          const serial = (this.playSerial.get(msg.handle) || 0) + 1; this.playSerial.set(msg.handle, serial);
          const buffer = await this.decodeEffect(entry);
          if (this.effects.get(msg.handle) !== entry || this.playSerial.get(msg.handle) !== serial) return;
          this.stopEffect(msg.handle);
          const source = this.context.createBufferSource(), d = msg.desc;
          source.buffer = this.loopBuffer(buffer, d, entry.info);
          const node = this.context.createGain(); node.connect(this.gain); source.connect(node);
          source.effect = { handle: msg.handle, node, pitch: d?.pitch ?? 65536,
            gain: d?.ms ? 0 : (d?.gain ?? 65536), ramp: null };
          if (d?.flags & 1) {
            source.loop = true; source.loopStart = (d.start + d.fade) / entry.info.rate;
            source.loopEnd = (d.end || entry.info.frames) / entry.info.rate;
          }
          this.activeEffects.set(msg.handle, source);
          this.effectParams(source, d || { pitch: 65536, gain: 65536, ms: 0 });
          if (entry.pendingParams) { this.effectParams(source, entry.pendingParams); entry.pendingParams = null; }
          source.onended = () => {
            clearTimeout(source.effect.timer);source.disconnect?.();source.effect.node.disconnect?.();
            if (this.activeEffects.get(msg.handle) === source) this.activeEffects.delete(msg.handle);
          };
          source.start(); this.effectPlays++; this.stats({ musicStarts: this.musicStarts, effectPlays: this.effectPlays }); this.status('音效已播放');
        } else if (msg.op === 'pause' && this.music?.source) {
          const old = this.music, offset = old.offset + this.context.currentTime - old.started;
          this.stopMusic(); this.music = { buffer: old.buffer, session: old.session, offset, source: null };
          this.status('背景音乐已暂停');
        } else if (msg.op === 'resume' && this.music && !this.music.source) {
          const old = this.music; this.playMusic(old.buffer, old.session, old.offset);
        } else if (msg.op === 'seek' && this.music) {
          const old = this.music, paused = !old.source; this.stopMusic();
          if (paused) this.music = { buffer: old.buffer, session: old.session, offset: msg.ms / 1000, source: null };
          else this.playMusic(old.buffer, old.session, msg.ms / 1000);
        }
      } catch (error) {
        this.error('音频播放失败：' + error.message);
        if (msg.op === 'start') this.send({ type: 'audio-feedback', session: msg.session, event: 'error' });
      }
    }
  }
  return AsterAudioPlayer;
});
