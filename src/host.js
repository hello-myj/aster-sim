'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { FEATURES } = require('./replay');
const { Network } = require('./network');
const { Http } = require('./http');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createCanvas, textFont, decodeImage, to565, from565, execGraphics } = require('./graphics');
const { MemoryFS } = require('./memory-fs');
const { validRelative } = require('./package');
const E = { INVALID: -1, MEMORY: -2, UNSUPPORTED: -3, PERMISSION: -4, BUSY: -5, MISSING: -6, IO: -7, EXISTS: -9, HANDLE: -10, SPACE: -11, STATE: -12, AGAIN: -15, DEVICE: -16 };
function declaredMax(manifest) {
  const max = Number(manifest.memory?.max);
  return Number.isFinite(max) && max > 0 ? max : 0x100000000;
}
function fitBox(bw, bh, gw, gh) {
  let dw, dh;
  if (gw * bh <= gh * bw) { dw = gw; dh = Math.floor((bh * gw) / bw); }
  else { dh = gh; dw = Math.floor((bw * gh) / bh); }
  dw = Math.max(1, Math.min(gw, dw || 1));
  dh = Math.max(1, Math.min(gh, dh || 1));
  return { bw, bh, dw, dh, mx: Math.floor((gw - dw) / 2), my: Math.floor((gh - dh) / 2) };
}
function errno(e) { return ({ ENOENT: -6, EEXIST: -9, EACCES: -4, EPERM: -4, ENOSPC: -11, EBADF: -10, ENOTDIR: -1, EISDIR: -1 })[e.code] || -7; }
class Host {
  constructor(pkg, options = {}) {
    this.pkg = pkg; this.options = options; this.manifest = pkg.manifest;
    this.width = options.width || 240; this.height = options.height || 320;
    if (this.manifest.orientation === 'landscape' && this.width < this.height || this.manifest.orientation === 'portrait' && this.width > this.height) [this.width, this.height] = [this.height, this.width];
    this.metrics={abiCalls:{},allocationAttempts:0,guestPeakBytes:0,hostAllocationPeakBytes:0,handlePeak:0,frameMs:[],frameSamples:0,frameTotalMs:0,frameMaxMs:0}; this.phase='load';
    this.handles = new Map(); this.nextHandle = 1; this.freeBlocks = []; this.allocations = new Map();
    this.permissions = new Set(this.manifest.permissions || []);
    this.fps = 30; this.frame = 0; this.boot = performance.now(); this.exitCode = null; this.paused = false; this.stopped = false;
    this.keys = new Set(); this.touch = null; this.logs = [];
    this.accel = options.accel || [0, 0, 9.80665]; this.gyro = options.gyro || [0, 0, 0];
    this.imuSample = null; this.imuSequence = 0;
    this.features = new Set([0, 1, 2, 3, 9, 10, 11, 12, 14]);
    if (options.wifi) this.features.add(7);
    if (options.network && options.clock) throw Error("Real networking is unavailable in deterministic replay");
    if (options.network) for (const bit of [15,16,17]) this.features.add(bit);
    this.network = new Network(this);
    this.http = new Http(this);
    if (options.camera) { this.camera = decodeImage(fs.readFileSync(options.camera), 320, 240).canvas; this.features.add(4); }
    if (options.pcmInput) { this.pcmInput = fs.readFileSync(options.pcmInput); this.features.add(5); }
    if (!options.noAudio) this.features.add(6);
    for(const name of options.missingFeatures||[])this.features.delete(FEATURES[name]);
    this.volume = 70; this.audio = { state: 0, total: 0, bytes: 0, position: 0, started: this.now() };
    this.wifi = { ssid: '', state: 0, last: 0, saved: '' };
    this.storageFs = options.state ? fs : (options.memoryStorage || new MemoryFS(options.storageBytes));
    this.root = path.resolve(options.state || path.join(__dirname, '../memory-session'), this.manifest.id);
    for (const x of ['data', 'cache', 'kv']) this.storageFs.mkdirSync(path.join(this.root, x), { recursive: true });
    this.shared = path.resolve(options.state || path.join(__dirname, '../memory-session'), 'shared');
    for (const x of ['sd', 'music']) this.storageFs.mkdirSync(path.join(this.shared, x), { recursive: true });
    this.maxLinear = declaredMax(this.manifest);
    this.fit = null;
    this.screen = createCanvas(this.width, this.height); this.presentCount = 0;
    this.send = options.send || (() => {});
    const names = { display: 0, touch: 1, mouse: 2, keyboard: 3, camera: 4, 'audio-in': 5, 'audio-out': 6, wifi: 7, bluetooth: 8, accelerometer: 9, gyroscope: 10, filesystem: 11, rtc: 12, psram: 13, framebuffer: 14, network: 15, http:16, tls:17, 'audio-stream':18 };
    for (const feature of this.manifest.requires || []) if (!this.features.has(FEATURES[feature])) throw Error(`Required capability unavailable: ${feature}`);
  }
  now() { return this.options.clock ? this.options.clock() : Math.floor(performance.now() - this.boot); }
  buffer() { return Buffer.from(this.memory.buffer); }
  range(p, n) { return Number.isInteger(p) && Number.isInteger(n) && (p >>> 0) + (n >>> 0) <= this.memory.buffer.byteLength && n >= 0; }
  bytes(p, n) { if (!this.range(p, n)) throw Object.assign(Error('WASM memory bounds'), { code: 'EINVAL' }); return this.buffer().subarray(p >>> 0, (p >>> 0) + n); }
  u32(p, v) { if (v === undefined) return this.bytes(p, 4).readUInt32LE(); this.bytes(p, 4).writeUInt32LE(v >>> 0); }
  string(p, n) { return this.bytes(p, n).toString('utf8'); }
  cstring(p) { const b = this.buffer(); p >>>= 0; if (p >= b.length) throw Error('Invalid string'); const end = b.indexOf(0, p); if (end < 0) throw Error('Unterminated string'); return b.toString('utf8', p, end); }
  output(p, text, cap, nul = false) { const b = Buffer.from(text); if (b.length + (nul ? 1 : 0) > cap) return -11; this.bytes(p, cap); b.copy(this.buffer(), p); if (nul) this.buffer()[p + b.length] = 0; return b.length; }
  struct(p, cap, size, version = 1) { if (cap < size || !this.range(p, size) || this.u32(p) < size || this.u32(p + 4) !== version) return false; this.bytes(p, size).fill(0); this.u32(p, size); this.u32(p + 4, version); return true; }
  add(kind, value, type = 0) { const h = (type | this.nextHandle++) >>> 0; this.handles.set(h, { kind, ...value }); this.metrics.handlePeak=Math.max(this.metrics.handlePeak,this.handles.size); return h; }
  get(h, kind) { const v = this.handles.get(h >>> 0); if (!v || v.kind !== kind) throw Object.assign(Error('Bad handle'), { code: 'EBADF' }); return v; }
  alloc(n) {
    if (++this.metrics.allocationAttempts===this.options.allocationFailAt) return 0;
    if (n < 0 || n > this.maxLinear) return 0;
    n = Math.ceil(Math.max(n, 1) / 16) * 16;
    const i = this.freeBlocks.findIndex(x => x.n >= n);
    if (i >= 0) { const block = this.freeBlocks.splice(i, 1)[0]; if (block.n > n) this.freeBlocks.push({ p: block.p + n, n: block.n - n }); this.allocations.set(block.p, n); this.trackMemory(); return block.p; }
    const p = this.heap, end = p + n;
    if (end > Math.min(this.manifest.memory?.max || this.maxLinear, this.maxLinear)) return 0;
    if (end > this.memory.buffer.byteLength) { try { this.memory.grow(Math.ceil((end - this.memory.buffer.byteLength) / 65536)); } catch { return 0; } }
    this.heap = end; this.allocations.set(p, n); this.trackMemory(); return p;
  }
  free(p) { const n = this.allocations.get(p); if (n) { this.allocations.delete(p); this.freeBlocks.push({ p, n }); this.freeBlocks.sort((a, b) => a.p - b.p); for (let i = 0; i < this.freeBlocks.length - 1;) { const a = this.freeBlocks[i], b = this.freeBlocks[i + 1]; if (a.p + a.n === b.p) { a.n += b.n; this.freeBlocks.splice(i + 1, 1); } else i++; } } }
  permission(p) { if (!this.permissions.has(p)) throw Object.assign(Error('Permission denied'), { code: 'EPERM' }); }
  virtual(p, n, write = false) {
    this.permission('fs'); const v = this.string(p, n);
    const match = /^\/(assets|data|cache|music|sd)(?:\/(.*))?$/.exec(v);
    if (!match || (match[2] && !validRelative(match[2]))) throw Object.assign(Error('Invalid sandbox path'), { code: 'EPERM' });
    const [, area, rel = ''] = match;
    if (area === 'sd') this.permission('sd');
    if (area === 'assets') { if (write) throw Object.assign(Error('Read only assets'), { code: 'EPERM' }); return { area, rel }; }
    if (area === 'music' && write) throw Object.assign(Error('Read only music'), { code: 'EPERM' });
    const base = path.join(['music', 'sd'].includes(area) ? this.shared : this.root, area), target = path.resolve(base, rel);
    let parent = target;
    while (!this.storageFs.existsSync(parent)) parent = path.dirname(parent);
    const realBase = this.storageFs.realpathSync(base), realParent = this.storageFs.realpathSync(parent);
    if (realParent !== realBase && !realParent.startsWith(realBase + path.sep)) throw Object.assign(Error('Sandbox symlink escape'), { code: 'EPERM' });
    return { area, rel, path: target };
  }
  readVirtual(p, n) { const v = this.virtual(p, n); if (v.area === 'assets') { const b = this.pkg.assets.get(v.rel); if (!b) throw Object.assign(Error('Missing asset'), { code: 'ENOENT' }); return b; } return this.storageFs.readFileSync(v.path); }
  syncIn(s) { if (s.ptr) from565(s.canvas, this.bytes(s.ptr, s.w * s.h * 2)); }
  syncOut(s) { if (s.ptr) to565(s.canvas).copy(this.buffer(), s.ptr); }
  present(s) {
    this.syncIn(s); const c = this.screen.getContext('2d');
    c.fillStyle = '#000'; c.fillRect(0, 0, this.width, this.height);
    if (s.flags & 2) {
      const fit = fitBox(s.w, s.h, this.width, this.height);
      c.drawImage(s.canvas, fit.mx, fit.my, fit.dw, fit.dh);
      this.fit = fit;
    } else { c.drawImage(s.canvas, 0, 0); this.fit = null; }
    this.presentCount++; this.send({ type: 'frame', data: this.screen.toBuffer('image/png') }); return 0;
  }
  mapTouch(x, y) {
    x = Math.max(0, Math.min(this.width - 1, Math.floor(x)));
    y = Math.max(0, Math.min(this.height - 1, Math.floor(y)));
    if (!this.fit) return { x, y };
    let rx = x - this.fit.mx, ry = y - this.fit.my;
    if (rx < 0) rx = 0; if (ry < 0) ry = 0;
    if (rx >= this.fit.dw) rx = this.fit.dw - 1; if (ry >= this.fit.dh) ry = this.fit.dh - 1;
    return { x: Math.min(this.fit.bw - 1, Math.floor(rx * this.fit.bw / this.fit.dw)), y: Math.min(this.fit.bh - 1, Math.floor(ry * this.fit.bh / this.fit.dh)) };
  }
  log(level, message) { const item = { level, message, ms: this.now() }; this.logs.push(item); if (this.logs.length > 200) this.logs.shift(); this.options.log?.(item); this.send({ type: 'log', ...item }); }
  imports() {
    const a = {
      aster_system_get_abi_version: () => 0x30a00,
      aster_system_has_feature: bit => this.features.has(bit) ? 1 : 0,
      aster_app_exit: code => { this.exitCode = code; },
      aster_app_set_framerate: fps => { this.fps = Math.min(fps >>> 0 || 30, 60); return 0; },
      aster_time_now_ms: () => this.now() >>> 0,
      aster_log: (level, p, n) => this.log(level, this.string(p, n)),
      aster_display_count: () => this.features.has(0) ? 1 : 0,
      aster_display_get_info: (i, p, n) => {
        if (i) return -6; if (!this.struct(p, n, 56)) return -1;
        [this.width, this.height, 9600, 0x1002].forEach((v, j) => this.u32(p + 8 + j * 4, v));
        this.bytes(p + 24, 8).writeBigUInt64LE(1n << 2n);
        this.u32(p + 32, 60); this.u32(p + 36, this.width > this.height ? 1 : 0); this.u32(p + 44, this.width); this.u32(p + 48, this.height); return 0;
      },
      aster_input_get_info: (p, n) => { if (!this.struct(p, n, 20)) return -1; this.u32(p + 8, 3); this.u32(p + 12, 1); return 0; },
      aster_input_touch: (p, n) => { if (!n || !this.touch) return 0; this.bytes(p, 12); [this.touch.x, this.touch.y, this.touch.action].forEach((v, i) => this.u32(p + i * 4, v)); return 1; },
      aster_input_keys_state: (p, n) => { const keys = [...this.keys].slice(0, n >>> 0); this.bytes(p, keys.length * 4); keys.forEach((v, i) => this.u32(p + i * 4, v)); return keys.length; },
      aster_timer_create: (period, repeat, user, out) => { if (period <= 0) return -1; this.bytes(out, 4); this.u32(out, this.add('timer', { period, repeat, user, due: this.now() + period }, 0x06000000)); return 0; },
      aster_timer_destroy: h => { this.get(h, 'timer'); this.handles.delete(h); return 0; },
      aster_surface_create: (p, n, out) => {
        if (n < 24 || this.u32(p) < 24 || this.u32(p + 4) !== 1) return -1;
        const flags = this.u32(p + 20), fmt = this.u32(p + 16);
        if ((flags & 1) && (flags & 2)) return -1;
        let w = this.u32(p + 8), h = this.u32(p + 12);
        if (flags & 2) { if (!w || !h) return -1; }
        else { w = w || this.width; h = h || this.height; }
        if (fmt !== 0x1002 && fmt !== 0xffff) return -3; if (!w || !h || w > 4096 || h > 4096 || flags & ~3) return -1;
        this.bytes(out, 4);
        // Full-panel canvases live in platform memory, as in firmware.
        // Partial canvases fall back to an ordinary APP-owned surface.
        const canvasFlags = (flags & 1) && w === this.width && h === this.height ? 1 : 0;
        const granted = canvasFlags | ((flags & 2) ? 2 : 0);
        const used = [...this.handles.values()].filter(v => v.kind === 'surface' && !(v.flags & 1)).reduce((n, s) => n + s.w * s.h * 2, 0);
        if (used + (canvasFlags ? 0 : w * h * 2) > (this.manifest.memory?.heap || 262144)) return -2;
        this.u32(out, this.add('surface', { w, h, flags: granted, ptr: 0, canvas: createCanvas(w, h) }, 0x02000000)); return 0;
      },
      aster_surface_destroy: h => { const s = this.get(h, 'surface'); if(this.gfxFrame?.s===s) this.gfxFrame=null; if (s.ptr) this.free(s.ptr); this.handles.delete(h); return 0; },
      aster_surface_acquire: (h, p, n) => {
        const s = this.get(h, 'surface'); if (!this.struct(p, n, 32)) return -1;
        if (!(s.flags & 1) && !s.ptr) { s.ptr = this.alloc(s.w * s.h * 2); if (!s.ptr) return -2; this.syncOut(s); }
        [s.ptr, s.w, s.h, s.w * 2, 0x1002, s.flags].forEach((v, i) => this.u32(p + 8 + i * 4, v)); return 0;
      },
      aster_surface_present: h => {if(this.gfxFrame){this.gfxFrame.error ||= -5;return this.gfxFrame.error;}return this.present(this.get(h, 'surface'));},
      aster_surface_flush: (h, p, x, y, w, hh, pitch) => {
        if(this.gfxFrame){this.gfxFrame.error ||= -5;return this.gfxFrame.error;}
        const s = this.get(h, 'surface'); if (!w || !hh || x < 0 || y < 0 || x + w > s.w || y + hh > s.h || pitch < w) return -1;
        this.bytes(p, ((hh - 1) * pitch + w) * 2); this.syncIn(s);
        const temp = createCanvas(w, hh), b = Buffer.alloc(w * hh * 2);
        for (let i = 0; i < hh; i++) this.bytes(p + i * pitch * 2, w * 2).copy(b, i * w * 2);
        from565(temp, b); s.canvas.getContext('2d').drawImage(temp, x, y); this.syncOut(s); return this.present(s);
      },
      aster_gfx_exec: (h, ...args) => execGraphics(this, this.get(h, 'surface'), ...args),
      aster_gfx_fonts_pending: () => 0,
      aster_gfx_text_w: (px, p, n) => { const c = this.screen.getContext('2d'); textFont(c, px); return Math.ceil(c.measureText(this.string(p, n)).width); },
      aster_gfx_bmp_load: (p, n, w, h, out, ow, oh) => {
        this.bytes(out, 4); this.bytes(ow, 4); this.bytes(oh, 4);
        const img = decodeImage(this.readVirtual(p, n), w, h), c = img.canvas.getContext('2d'), pixels = c.getImageData(0, 0, img.canvas.width, img.canvas.height);
        for (let i = 0; i < pixels.data.length; i += 4) { if ((pixels.data[i] >> 3) === 0 && (pixels.data[i + 1] >> 2) === 0 && (pixels.data[i + 2] >> 3) === 0) pixels.data[i + 3] = 0; else pixels.data[i + 3] = 255; }
        c.putImageData(pixels, 0, 0); this.u32(out, this.add('bitmap', { canvas: img.canvas })); this.u32(ow, img.canvas.width); this.u32(oh, img.canvas.height); return 0;
      },
      aster_gfx_bmp_free: h => { this.get(h, 'bitmap'); this.handles.delete(h); return 0; },
      aster_img_probe: (p, n, out, size) => {
        if (!this.struct(out, size, 88)) return -1;
        const bytes = this.readVirtual(p, n), im = decodeImage(bytes, 0, 0), fmt = bytes[0] === 0x89 ? 3 : bytes[0] === 0xff ? 2 : 1;
        [fmt, im.width, im.height, bytes.length, im.width, im.height].forEach((v, i) => this.u32(out + 8 + i * 4, v)); return 0;
      },
      aster_img_render: (p, n, out, size) => {
        if (size < 40 || this.u32(out) < 40 || this.u32(out + 4) !== 1) return -1;
        const im = decodeImage(this.readVirtual(p, n), this.u32(out + 16), this.u32(out + 20)), b = to565(im.canvas);
        if (b.length > this.u32(out + 12)) return -11; this.bytes(this.u32(out + 8), b.length).set(b); this.u32(out + 24, im.canvas.width); this.u32(out + 28, im.canvas.height); return 0;
      },
      aster_imu_get_info: (p, n) => this.imuRead(p, n, true),
      aster_imu_read: (p, n) => this.imuRead(p, n, false),
      aster_accel_read: (p, n) => this.sensor(p, n, this.accel),
      aster_gyro_read: (p, n) => this.sensor(p, n, this.gyro),
      aster_cam_info: (w, h) => { if (!this.camera) return -16; this.bytes(w, 4); this.bytes(h, 4); this.u32(w, this.camera.width); this.u32(h, this.camera.height); return 0; },
      aster_cam_read: (p, n) => { if (!this.camera) return -16; const b = to565(this.camera); if (n < b.length) return -11; this.bytes(p, b.length).set(b); return 0; },
      aster_time_get: (p, n) => {
        if (!this.struct(p, n, 56)) return -1;
        const d = new Date(this.options.clock ? (this.options.epochMs ?? 1767225600000) + this.now() : Date.now()); this.bytes(p + 8, 8).writeBigUInt64LE(BigInt(d.getTime())); this.u32(p + 16, 1);
        (this.options.clock ? [d.getUTCFullYear(), d.getUTCMonth()+1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCDay()] : [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getDay()]).forEach((v, i) => this.u32(p + 20 + i * 4, v)); return 0;
      },
    };
    Object.assign(a, this.storageImports(), this.audioImports(), this.wifiImports(), this.network.imports(), this.http.imports(), this.libcImports());
    a.aster_appmgr_count = () => { this.permission('appmgr'); return (this.options.catalog || [this.pkg]).length; };
    a.aster_appmgr_list = (i, p, n) => {
      this.permission('appmgr'); const app = (this.options.catalog || [this.pkg])[i]; if (!app) return -6;
      if (!this.struct(p, n, 168, 2)) return -1;
      this.output(p + 8, app.manifest.id, 64, true); this.output(p + 72, app.manifest.name || app.manifest.id, 40, true); this.output(p + 112, app.manifest.version || '0.0.0', 24, true);
      this.u32(p + 136, app.manifest.id === this.manifest.id ? (this.paused ? 2 : 1) : 0); this.u32(p + 140, app.hasAot ? 1 : 0); this.output(p + 148, app.manifest.category || '', 16, true); return 0;
    };
    a.aster_appmgr_start = (p, n) => { this.permission('appmgr'); const id = this.string(p, n); if (id === this.manifest.id) return -5; if (!(this.options.catalog || []).some(a => a.manifest.id === id)) return -6; this.switchTo = id; this.exitCode = 0; return 0; };
    a.aster_appmgr_uninstall = (p, n) => { this.permission('appmgr'); const id = this.string(p, n); if (id === this.manifest.id) return -5; const list = this.options.catalog || [], i = list.findIndex(a => a.manifest.id === id); if (i < 0) return -6; list.splice(i, 1); return 0; };
    this.apiNames = Object.keys(a).filter(x => x.startsWith('aster_'));
    const wrapped = {};
    for (const [name, fn] of Object.entries(a)) wrapped[name] = (...args) => { this.metrics.abiCalls[name]=(this.metrics.abiCalls[name]||0)+1; const bit=name.startsWith('aster_gfx_')||name.startsWith('aster_surface_')||name==='aster_display_get_info'?0:name==='aster_input_touch'?1:name==='aster_input_keys_state'?3:name.startsWith('aster_cam_')?4:name==='aster_accel_read'?9:name==='aster_gyro_read'?10:name.startsWith('aster_fs_')||name.startsWith('aster_kv_')?11:name==='aster_time_get'?12:null; if(bit!==null&&!this.features.has(bit))return -16; try { return fn(...args); } catch (e) { if (e instanceof WebAssembly.RuntimeError) throw e; if (e.code === 'EINVAL' || e instanceof RangeError) return -1; this.log(2, `${name}: ${e.message}`); return errno(e); } };
    return wrapped;
  }
  imuRead(p, n, info) {
    const size = info ? 16 : 48;
    // Unlike struct(), validate everything before touching the caller's output.
    if (!p || !Number.isInteger(n) || n < size || !this.range(p, size) ||
        this.u32(p) < size || this.u32(p + 4) !== 1) return -1;
    if (!this.features.has(9) || !this.features.has(10)) return -16;
    let sample;
    if (!info) {
      const now = this.now();
      if (!this.imuSample || now - this.imuSample.timestamp >= 10) {
        if (![...this.accel, ...this.gyro].every(v => Number.isFinite(v) && Number.isFinite(Math.fround(v)))) return -7;
        this.imuSequence = (this.imuSequence + 1) >>> 0;
        this.imuSample = { timestamp: now, sequence: this.imuSequence, accel: [...this.accel], gyro: [...this.gyro] };
      }
      sample = this.imuSample;
    }
    this.bytes(p, size).fill(0); this.u32(p, size); this.u32(p + 4, 1);
    if (info) { this.u32(p + 8, 3); this.u32(p + 12, 10); }
    else {
      this.bytes(p + 8, 8).writeBigUInt64LE(BigInt(sample.timestamp));
      this.u32(p + 16, sample.sequence); this.u32(p + 20, 3);
      [...sample.accel, ...sample.gyro].forEach((v, i) => this.bytes(p + 24 + i * 4, 4).writeFloatLE(v));
    }
    return 0;
  }
  sensor(p, n, values) { if (n < 12) return -1; values.forEach((v, i) => this.bytes(p + i * 4, 4).writeFloatLE(v)); return 0; }
  start() {
    const module = new WebAssembly.Module(this.pkg.wasm), imports = this.imports();
    for (const i of WebAssembly.Module.imports(module)) if (i.module !== 'env' || i.kind !== 'function' || !imports[i.name]) throw Error(`Unsupported import ${i.module}.${i.name}`);
    this.instance = new WebAssembly.Instance(module, { env: imports }); this.memory = this.instance.exports.memory;
    for (const name of ['aster_app_init', 'aster_app_event']) if (typeof this.instance.exports[name] !== 'function') throw Error(`Missing lifecycle export: ${name}`);
    if (!(this.memory instanceof WebAssembly.Memory) || !this.instance.exports.__heap_base) throw Error('APP must export memory and __heap_base (use SDK build)');
    if (this.memory.buffer.byteLength > this.maxLinear) throw Error('APP initial memory exceeds the package maximum');
    this.heap = Math.ceil(Number(this.instance.exports.__heap_base.value) / 16) * 16;
    this.eventPtr = this.alloc(56); if (!this.eventPtr) throw Error('No event buffer memory');
    const rc = this.call('aster_app_init'); if (rc < 0) { this.stop(); throw Error(`aster_app_init failed: ${rc}`); }
    if (this.exitCode === null) this.call('aster_app_start'); return this;
  }
  trackMemory(){this.metrics.guestPeakBytes=Math.max(this.metrics.guestPeakBytes,this.memory?.buffer.byteLength||0);this.metrics.hostAllocationPeakBytes=Math.max(this.metrics.hostAllocationPeakBytes,[...this.allocations.values()].reduce((a,b)=>a+b,0));}
  diagnostics(){
    this.trackMemory();const sorted=[...this.metrics.frameMs].sort((a,b)=>a-b),kinds={};for(const h of this.handles.values())kinds[h.kind]=(kinds[h.kind]||0)+1;
    return {appId:this.manifest.id,appVersion:this.manifest.version,abiTarget:this.manifest.abi?.target,phase:this.phase,trap:this.lastTrap||null,frame:this.frame,paused:this.paused,virtualMs:this.now(),presents:this.presentCount,guestBytes:this.memory?.buffer.byteLength||0,guestPeakBytes:this.metrics.guestPeakBytes,hostAllocatedBytes:[...this.allocations.values()].reduce((a,b)=>a+b,0),hostAllocationPeakBytes:this.metrics.hostAllocationPeakBytes,handles:kinds,handlePeak:this.metrics.handlePeak,abiCalls:{...this.metrics.abiCalls},frameTiming:{samples:this.metrics.frameSamples,meanMs:this.metrics.frameSamples?this.metrics.frameTotalMs/this.metrics.frameSamples:0,maxMs:this.metrics.frameMaxMs,p95RecentMs:sorted.length?sorted[Math.ceil(sorted.length*.95)-1]:0,recentSamples:sorted.length}};
  }
  stateDigest(){
    const storage=this.storageFs instanceof MemoryFS?[...this.storageFs.nodes].filter(([,n])=>!n.dir).map(([p,n])=>[path.relative(path.dirname(this.shared),p),crypto.createHash('sha256').update(n.data).digest('hex')]).sort((a,b)=>a[0]<b[0]?-1:1):null;
    return {memorySha256:this.memory?crypto.createHash('sha256').update(this.buffer()).digest('hex'):null,pixelSha256:crypto.createHash('sha256').update(this.screen.toBuffer('image/png')).digest('hex'),storage,frame:this.frame,presents:this.presentCount,exitCode:this.exitCode,paused:this.paused,virtualMs:this.now()};
  }
  call(name, ...args) {
    this.phase=name;this.send({type:'phase',diagnostics:{appId:this.manifest.id,phase:name,frame:this.frame,guestBytes:this.memory?.buffer.byteLength||0}});
    try{return this.instance?.exports[name]?.(...args);}catch(e){this.lastTrap={phase:name,message:e.message};throw e;}finally{this.trackMemory();}
  }
  event(type, payload = []) {
    if (this.exitCode !== null || this.paused) return;
    const p = this.eventPtr; this.bytes(p, 56).fill(0); this.u32(p, 56); this.u32(p + 4, 1); this.u32(p + 8, type); this.bytes(p + 16, 8).writeBigUInt64LE(BigInt(this.now())); payload.forEach((v, i) => this.u32(p + 24 + i * 4, v)); this.call('aster_app_event', p);
  }
  tick() {
    if (this.paused || this.exitCode !== null) return;
    for (const [id, t] of [...this.handles]) if (t.kind === 'timer' && this.now() >= t.due) {
      if (t.repeat) t.due = this.now() + t.period; else this.handles.delete(id);
      this.event(3, [id, t.user]); if (this.exitCode !== null) return;
    }
    const started=performance.now();
    try{this.event(1, [this.frame++]);}finally{const ms=performance.now()-started;this.metrics.frameSamples++;this.metrics.frameTotalMs+=ms;this.metrics.frameMaxMs=Math.max(this.metrics.frameMaxMs,ms);this.metrics.frameMs.push(ms);if(this.metrics.frameMs.length>512)this.metrics.frameMs.shift();}
  }
  input(msg) {
    if (msg.type === 'audio-feedback') { this.audioFeedback(msg); return; }
    if (msg.type === 'touch') { if (![1, 2, 3].includes(msg.action)) return; const m = this.mapTouch(msg.x, msg.y); this.touch = msg.action === 3 ? null : { x: m.x, y: m.y, action: msg.action }; this.event(2, [m.x, m.y, msg.action, 0]); }
    if (msg.type === 'key' && Number.isInteger(msg.code) && msg.code > 0 && msg.code < 768) { if (msg.pressed) this.keys.add(msg.code); else this.keys.delete(msg.code); this.event(4, [msg.code, msg.pressed ? 1 : 0]); }
    if (msg.type === 'sensor') { for (const name of ['accel', 'gyro']) if (Array.isArray(msg[name]) && msg[name].length === 3 && msg[name].every(Number.isFinite)) this[name] = msg[name]; }
    if (msg.type === 'pause') { this.setPaused(!this.paused); }
  }
  setPaused(pause) { if (this.exitCode !== null || pause === this.paused) return; if (pause) { this.gfxFrame=null;this.call('aster_app_pause'); this.paused = true; this.pauseAt = this.now(); } else { const elapsed = this.now() - this.pauseAt; for (const t of this.handles.values()) if (t.kind === 'timer') t.due += elapsed; this.paused = false; this.call('aster_app_resume'); } this.keys.clear(); this.touch = null; }
  stop() { if (this.stopped) return; this.stopped = true;this.gfxFrame=null; try { this.call('aster_app_stop'); } finally { try { this.call('aster_app_destroy'); } finally { this.http.stop(); this.network.stop(); for (const h of this.handles.values()) if (h.kind === 'file' && h.fd !== undefined) this.storageFs.closeSync(h.fd); this.handles.clear(); this.send({ type: 'audio', op: 'stop' }); } } }
}
Object.assign(Host.prototype, require('./storage'), require('./libc'), require('./peripherals'));
module.exports = { Host, E, errno };
