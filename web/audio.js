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
      this.activeEffects = new Map(); this.controls = [];
    }
    async enable() {
      if (!this.context) {
        this.context = this.createContext(); this.gain = this.context.createGain();
        this.gain.connect(this.context.destination);
      }
      await this.context.resume();
      await Promise.all([...this.effects.values()].map(entry => this.decodeEffect(entry)));
      this.status('声音已启用');
      if (this.pending) {
        const pending = this.pending, controls = this.controls;
        this.pending = null; this.controls = [];
        await this.handle(pending);
        for (const control of controls) await this.handle(control);
      }
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
      if (source) { source.onended = null; try { source.stop(); } catch {} }
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
          const entry = { data: msg.data }; this.effects.set(msg.handle, entry);
          if (this.context) await this.decodeEffect(entry); return;
        }
        if (msg.op === 'effect-unload') {
          this.stopEffect(msg.handle); this.effects.delete(msg.handle); this.playSerial.delete(msg.handle); return;
        }
        if (msg.op === 'stop') {
          this.pending = null; this.controls = []; this.stopMusic();
          for (const handle of this.activeEffects.keys()) this.stopEffect(handle);
          for (const [handle, serial] of this.playSerial) this.playSerial.set(handle, serial + 1);
          this.status('音频已停止'); return;
        }
        if (!this.context || this.context.state !== 'running') {
          if (msg.op === 'start') { this.pending = msg; this.controls = []; }
          else if (['pause', 'resume', 'seek', 'volume'].includes(msg.op)) this.controls.push(msg);
          return;
        }
        if (msg.volume !== undefined) this.gain.gain.value = msg.volume / 100;
        if (msg.op === 'start') {
          this.stopMusic(); const generation = this.generation, buffer = await this.decode(msg.data);
          if (generation === this.generation) this.playMusic(buffer, msg.session);
        } else if (msg.op === 'effect') {
          const entry = this.effects.get(msg.handle); if (!entry) throw Error('Missing effect ' + msg.handle);
          const serial = (this.playSerial.get(msg.handle) || 0) + 1; this.playSerial.set(msg.handle, serial);
          const buffer = await this.decodeEffect(entry);
          if (this.effects.get(msg.handle) !== entry || this.playSerial.get(msg.handle) !== serial) return;
          this.stopEffect(msg.handle);
          const source = this.context.createBufferSource(); source.buffer = buffer;
          source.connect(this.gain); this.activeEffects.set(msg.handle, source);
          source.onended = () => { if (this.activeEffects.get(msg.handle) === source) this.activeEffects.delete(msg.handle); };
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
