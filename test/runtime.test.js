'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Host } = require('../src/host');
const { loadPackage, validRelative } = require('../src/package');
const { parse } = require('../src/cli');
const { wasmFixture, packageFixture } = require('./fixtures');
function setup(t, permissions = ['fs', 'kv', 'sd', 'wifi', 'appmgr']) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'aster-sim-test-'));
  const pkg = { manifest: { id: 'test.app', permissions }, assets: new Map([['nested/test.txt', Buffer.from('asset')]]) };
  const h = new Host(pkg, { state, wifi: true }); h.memory = new WebAssembly.Memory({ initial: 4, maximum: 32 }); h.heap = 16384;
  t.after(() => { h.stop(); fs.rmSync(state, { recursive: true, force: true }); });
  const api = h.imports();
  const str = text => { const b = Buffer.from(text); const p = h.alloc(b.length + 1); h.bytes(p, b.length + 1).fill(0); h.bytes(p, b.length).set(b); return [p, b.length]; };
  const st = (size, version = 1) => { const p = h.alloc(size); h.u32(p, size); h.u32(p + 4, version); return p; };
  return { h, api, str, st, state };
}
test('resolution parsing rejects invalid values and respects headless frame limit', () => {
  const o = parse(['demo.ast', '--resolution', '480x800', '--scale', '1', '--headless']);
  assert.equal(o.width, 480); assert.equal(o.height, 800); assert.equal(o.frames, 120);
  assert.throws(() => parse(['demo.ast', '--resolution', '0x320']));
  assert.throws(() => parse(['demo.ast', '--frames', 'NaN']));
  assert.throws(() => parse(['demo.ast', '--unknown']));
});
test('ASTP truncation, malicious paths and ABI mismatch fail before instantiation', t => {
  
  for (const s of ['../a', 'a/../b', 'a\\b', '/abs', 'C:ads', 'a/.. /b', 'a/NUL.txt', 'a./b']) assert.equal(validRelative(s), false, s);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aster-pkg-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = packageFixture(), corrupt = path.join(root, 'bad.ast');
  fs.writeFileSync(corrupt, original); const pkg = loadPackage(corrupt); assert.equal(pkg.manifest.abi.min, '3.6'); assert.equal(pkg.hasAot, false);
  fs.writeFileSync(corrupt, original.subarray(0, original.length - 100)); assert.throws(() => loadPackage(corrupt), /bounds/);
  const bad = Buffer.from(original); const mo = bad.readUInt32LE(12), ml = bad.readUInt32LE(16); const text = bad.toString('utf8', mo, mo + ml).replace('"3.6"', '"4.6"'); bad.write(text, mo);
  fs.writeFileSync(corrupt, bad); assert.throws(() => loadPackage(corrupt), /ABI/);
});
test('all public ABI 3.6 aster imports have an explicit handler', t => {
  const { api } = setup(t), names = require('./abi-3.6-imports.json');
  assert.equal(names.length, 70);
  for (const name of names) assert.equal(typeof api[name], 'function', name);
});
test('memory bounds and struct version checks reject corrupt APP pointers', t => {
  const { h, api, st } = setup(t);
  assert.equal(api.aster_display_get_info(0, h.memory.buffer.byteLength - 8, 56), -1);
  const bad = st(56, 2); assert.equal(api.aster_display_get_info(0, bad, 56), -1);
  const p = st(56); assert.equal(api.aster_display_get_info(0, p, 56), 0); assert.equal(h.u32(p + 44), 240); assert.equal(h.u32(p + 48), 320);
});
test('file seek/read/EOF, readonly assets, dirs and sandbox escape prevention', t => {
  const { h, api, str, st, state } = setup(t); const out = h.alloc(4), dst = h.alloc(32), p = str('/data/test.bin'), text = str('abcdefgh');
  assert.equal(api.aster_fs_open(...p, 0x33, out), 0); const file = h.u32(out);
  assert.equal(api.aster_fs_write(file, ...text), 8);
  assert.equal(api.aster_fs_seek(file, -3, 2), 0); assert.equal(api.aster_fs_read(file, dst, 32), 3); assert.equal(h.string(dst, 3), 'fgh');
  assert.equal(api.aster_fs_read(file, dst, 32), 0); assert.equal(api.aster_fs_close(file), 0); assert.equal(api.aster_fs_read(file, dst, 1), -10);
  assert.equal(api.aster_fs_open(...str('/data/../escape'), 1, out), -4);
  assert.equal(api.aster_fs_open(...str('/assets/nested/test.txt'), 2, out), -4);
  assert.equal(api.aster_fs_open(...str('/assets/nested/test.txt'), 1, out), 0); assert.equal(api.aster_fs_read(h.u32(out), dst, 32), 5); assert.equal(h.string(dst, 5), 'asset');
  assert.equal(api.aster_fs_opendir(...str('/assets'), out), 0); const dir = h.u32(out), isdir = h.alloc(4); assert.equal(api.aster_fs_dir_next(dir, dst, 32, isdir), 6); assert.equal(h.u32(isdir), 1);
  const outside = path.join(state, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'private'), 'secret');
  fs.symlinkSync(outside, path.join(h.root, 'data/link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(api.aster_fs_open(...str('/data/link/private'), 1, out), -4);
  const stat = st(24); assert.equal(api.aster_fs_stat(...p, stat, 24), 0); assert.equal(h.bytes(stat + 8, 8).readBigUInt64LE(), 8n);
});
test('permissions and KV isolation enforce APP manifest', t => {
  const { h, api, str } = setup(t, []); const dst = h.alloc(32);
  assert.equal(api.aster_kv_set(...str('x'), dst, 4), -4);
  assert.equal(api.aster_fs_open(...str('/data/a'), 0x12, dst), -4);
  assert.equal(api.aster_wifi_scan_start(), -4);
});
test('normal RGB565 surface preserves acquired pixels, flush clipping and destruction', t => {
  const { h, api, st } = setup(t); const desc = st(24), out = h.alloc(4), buf = st(32);
  h.u32(desc + 8, 4); h.u32(desc + 12, 4); h.u32(desc + 16, 0x1002);
  assert.equal(api.aster_surface_create(desc, 24, out), 0); const surface = h.u32(out);
  assert.equal(api.aster_surface_acquire(surface, buf, 32), 0); const ptr = h.u32(buf + 8); h.bytes(ptr, 2).writeUInt16LE(0xf800);
  assert.equal(api.aster_surface_present(surface), 0);
  assert.equal(h.screen.getContext('2d').getImageData(0, 0, 1, 1).data[0], 255);
  assert.equal(api.aster_surface_flush(surface, ptr, 3, 3, 2, 2, 2), -1);
  assert.equal(api.aster_surface_destroy(surface), 0); assert.equal(api.aster_surface_present(surface), -10);
});
test('virtual Wi-Fi exposes completed station state without host network calls', t => {
  const { h, api, str, st } = setup(t); const ap = h.alloc(56), status = st(84);
  assert.equal(api.aster_wifi_scan_start(), 0); assert.equal(api.aster_wifi_scan_results(ap, 1), 1); assert.equal(h.u32(ap), 56);
  assert.equal(api.aster_wifi_connect(...str('demo'), ...str('password')), 0); assert.equal(api.aster_wifi_status(status, 84), 0); assert.equal(h.u32(status + 8), 9); assert.equal(h.cstring(status + 65), '192.0.2.2');
  assert.equal(api.aster_wifi_disconnect(), 0); assert.equal(api.aster_wifi_status(status, 84), 0); assert.equal(h.u32(status + 8), 0);
});
test('images decode to RGB565 and virtual camera/audio report explicit unavailable states', t => {
  const { h, api, str, st } = setup(t); const { createCanvas } = require('../src/graphics');
  const image = createCanvas(8, 4); image.getContext('2d').fillStyle = 'red'; image.getContext('2d').fillRect(0, 0, 8, 4); h.pkg.assets.set('red.png', image.toBuffer('image/png'));
  const info = st(88), args = st(40), out = h.alloc(64); h.u32(args + 8, out); h.u32(args + 12, 64); h.u32(args + 16, 4); h.u32(args + 20, 4);
  assert.equal(api.aster_img_probe(...str('/assets/red.png'), info, 88), 0); assert.equal(h.u32(info + 12), 8);
  assert.equal(api.aster_img_render(...str('/assets/red.png'), args, 40), 0); assert.equal(h.u32(args + 24), 4); assert.equal(h.u32(args + 28), 2); assert.equal(h.bytes(out, 2).readUInt16LE(), 0xf800);
  assert.equal(api.aster_cam_info(out, out + 4), -16); assert.equal(api.aster_audio_record(out, 4), -16);
  assert.equal(api.aster_audio_set_volume(101), -1); assert.equal(api.aster_audio_set_volume(45), 0); assert.equal(api.aster_audio_get_volume(), 45);
  assert.equal(api.aster_audio_get_state(st(32, 2), 32), 0);
  const { decodeImage, to565 } = require('../src/graphics');
  const raw = Buffer.alloc(8 * 4 * 4); for (let i = 0; i < raw.length; i += 4) { raw[i] = 255; raw[i + 3] = 255; }
  const jpg = require('jpeg-js').encode({ width: 8, height: 4, data: raw }, 100).data;
  assert.ok((to565(decodeImage(jpg, 4, 4).canvas).readUInt16LE() & 0xf800) >= 0xf000);
  const bitmap = require('bmp-js').encode({ width: 8, height: 4, data: raw }).data;
  assert.equal(to565(decodeImage(bitmap, 4, 4).canvas).readUInt16LE(), 0xf800);
});
test('WAV background, pause/resume/seek, effects and PCM recording fixtures', t => {
  const { h, api, str, st } = setup(t), pcm = Buffer.alloc(1764), wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(44100, 24); wav.writeUInt32LE(176400, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  h.pkg.assets.set('sound.wav', wav); const p = str('/assets/sound.wav'), state = st(32, 2);
  assert.equal(api.aster_audio_start_file(...p), 0); assert.equal(api.aster_audio_pause(), 0); assert.equal(api.aster_audio_get_state(state, 32), 0); assert.equal(h.u32(state + 8), 2); assert.equal(h.u32(state + 28), 10);
  assert.equal(api.aster_audio_seek(2), 0); assert.equal(api.aster_audio_resume(), 0); const effect = api.aster_audio_effect_load(...p); assert.ok(effect > 0); assert.equal(api.aster_audio_effect_play(effect), 0); assert.equal(api.aster_audio_effect_unload(effect), 0); assert.equal(api.aster_audio_stop(), 0);
  h.pcmInput = Buffer.from([1, 2, 3, 4]); const out = h.alloc(4); assert.equal(api.aster_audio_record(out, 4), 4); assert.equal(h.bytes(out, 4).toString('hex'), '01020304');
});
test('appmgr catalogs, switches and only virtually removes other APPs', t => {
  const { h, api, str, st } = setup(t); const other = { manifest: { id: 'test.other', name: 'Other', version: '1.0' }, hasAot: true }; h.options.catalog = [h.pkg, other];
  assert.equal(api.aster_appmgr_count(), 2); const info = st(168, 2); assert.equal(api.aster_appmgr_list(1, info, 168), 0); assert.equal(h.cstring(info + 8), 'test.other'); assert.equal(h.u32(info + 140), 1);
  assert.equal(api.aster_appmgr_uninstall(...str('test.app')), -5); assert.equal(api.aster_appmgr_start(...str('test.other')), 0); assert.equal(h.switchTo, 'test.other');
  assert.equal(api.aster_appmgr_uninstall(...str('test.other')), 0); assert.equal(api.aster_appmgr_count(), 1);
});
test('WASM lifecycle dispatches frame, input, timers and pause without bundled APPs', async t => {
  const h = new Host({manifest:{id:'test.lifecycle', permissions:[]},wasm:wasmFixture(),assets:new Map()}).start();
  t.after(()=>h.stop());
  const original = h.call.bind(h), events = [];
  h.call = (name,...args) => { if(name==='aster_app_event') events.push([h.u32(args[0]+8),h.u32(args[0]+24)]); return original(name,...args); };
  h.tick(); assert.equal(h.frame,1); assert.ok(events.some(e=>e[0]===1));
  h.input({type:'touch',x:20,y:30,action:1}); h.input({type:'key',code:28,pressed:1});
  assert.ok(events.some(e=>e[0]===2)); assert.ok(events.some(e=>e[0]===4&&e[1]===28));
  const timer = h.add('timer',{due:0,repeat:false,period:1,user:99});
  h.tick(); assert.ok(events.some(e=>e[0]===3&&e[1]===timer));
  h.setPaused(true); const frame=h.frame; h.tick(); assert.equal(h.frame,frame);
  h.setPaused(false); h.tick(); assert.equal(h.frame,frame+1);
});

test('native panel canvas resolves to RGB565 and uses display dimensions', t => {
  const { h, api, st } = setup(t); const desc = st(24), out = h.alloc(4), buf = st(32);
  h.u32(desc + 16, 0xffff); h.u32(desc + 20, 1);
  assert.equal(api.aster_surface_create(desc, 24, out), 0);
  assert.equal(api.aster_surface_acquire(h.u32(out), buf, 32), 0);
  assert.equal(h.u32(buf + 8), 0);
  assert.equal(h.u32(buf + 12), 240); assert.equal(h.u32(buf + 16), 320);
  assert.equal(h.u32(buf + 24), 0x1002); assert.equal(h.u32(buf + 28), 1);
});