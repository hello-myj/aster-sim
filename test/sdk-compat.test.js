'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const snapshot = require('../src/sdk-compat.json');
const { parse } = require('../src/cli');
const { checkSdk } = require('../scripts/check-sdk');
test('board presets use SDK dimensions and explicit sizes win in either argument order', () => {
  for (const [id, board] of Object.entries(snapshot.boards)) {
    const opts = parse(['demo.ast', '--board', id]);
    assert.equal(opts.width, board.width); assert.equal(opts.height, board.height);
    for (const args of [['--resolution', '480x800', '--board', id], ['--board', id, '--resolution', '480x800']]) {
      const override = parse(['demo.ast', ...args]); assert.equal(override.width, 480); assert.equal(override.height, 800);
    }
  }
  assert.throws(() => parse(['demo.ast', '--board', 'unknown']), /Unknown board/);
  assert.deepEqual(parse(['--version']), { version: true });
});
test('SDK compatibility check rejects same-ABI public structure changes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aster-sdk-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'contract'));
  const hashes = { ...snapshot.contractHashes, 'include/aster/imu.h': 'changed' };
  fs.writeFileSync(path.join(root, 'contract/lock.json'), JSON.stringify({ abi: snapshot.abi, sha256: hashes }));
  fs.writeFileSync(path.join(root, 'contract/api.json'), JSON.stringify({ abi: snapshot.abi, imports: { env: snapshot.imports } }));
  assert.throws(() => checkSdk(root), /public contract changed/);
});
function wasmWithMemory(initialPages, maxPages) {
  const bytes = [0, 97, 115, 109, 1, 0, 0, 0], section = (id, data) => bytes.push(id, data.length, ...data);
  section(1, [2, 0x60, 0, 1, 0x7f, 0x60, 1, 0x7f, 0]); section(3, [2, 0, 1]);
  section(5, [1, 1, initialPages, maxPages]); section(6, [1, 0x7f, 0, 0x41, 0x80, 0x08, 0x0b]);
  const exports = [4];
  for (const [name, kind, index] of [['memory', 2, 0], ['__heap_base', 3, 0], ['aster_app_init', 0, 0], ['aster_app_event', 0, 1]]) exports.push(name.length, ...Buffer.from(name), kind, index);
  section(7, exports); section(10, [2, 4, 0, 0x41, 0, 0x0b, 2, 0, 0x0b]); return Buffer.from(bytes);
}
test('WASM linear memory ceiling follows the selected board', t => {
  const { Host } = require('../src/host');
  const pkg = manifest => ({ manifest, assets: new Map(), wasm: wasmWithMemory(1, 127) });
  const base = { id: 'test.memlimit', permissions: [] };
  const open = board => {
    const h = new Host(pkg(base), board ? { board } : {});
    h.memory = new WebAssembly.Memory({ initial: 1, maximum: 127 }); h.heap = 65536;
    t.after(() => h.stop());
    return h;
  };
  const fallback = open(); const lckfb = open('lckfb-s3'); const waveshare = open('waveshare-35b');
  assert.equal(fallback.maxLinear, snapshot.boards['lckfb-s3'].maxLinear);
  assert.equal(lckfb.maxLinear, 2097152);
  assert.equal(waveshare.maxLinear, snapshot.boards['waveshare-35b'].maxLinear);
  assert.equal(waveshare.maxLinear, 7864320);
  assert.equal(fallback.alloc(2097153), 0);
  assert.equal(lckfb.alloc(2097153), 0);
  assert.ok(waveshare.alloc(3 * 1024 * 1024) > 0);
  assert.equal(waveshare.alloc(7864321), 0);
  const overDefault = new Host({ ...pkg(base), wasm: wasmWithMemory(33, 127) }, {});
  t.after(() => overDefault.stop());
  assert.throws(() => overDefault.start(), /APP initial memory exceeds device 2 MiB limit/);
  const overWaveshare = new Host({ ...pkg(base), wasm: wasmWithMemory(121, 127) }, { board: 'waveshare-35b' });
  t.after(() => overWaveshare.stop());
  assert.throws(() => overWaveshare.start(), /APP initial memory exceeds device 7\.5 MiB limit/);
  const fitWaveshare = new Host({ ...pkg(base), wasm: wasmWithMemory(120, 127) }, { board: 'waveshare-35b' });
  t.after(() => fitWaveshare.stop());
  assert.doesNotThrow(() => fitWaveshare.start());
});
test('full-panel 320x480 canvas uses platform memory; ordinary and partial surfaces use APP heap', t => {
  const { Host } = require('../src/host');
  const h = new Host({ manifest: { id: 'test.largecanvas', permissions: [], memory: { heap: 262144 } }, assets: new Map() }, { width: 320, height: 480 });
  h.memory = new WebAssembly.Memory({ initial: 8 }); h.heap = 4096;
  t.after(() => h.stop());
  const api = h.imports(), desc = h.alloc(24), out = h.alloc(4), buf = h.alloc(32);
  h.u32(desc, 24); h.u32(desc + 4, 1); h.u32(desc + 8, 320); h.u32(desc + 12, 480); h.u32(desc + 16, 0x1002); h.u32(desc + 20, 1);
  assert.equal(api.aster_surface_create(desc, 24, out), 0);
  h.u32(buf, 32); h.u32(buf + 4, 1);
  assert.equal(api.aster_surface_acquire(h.u32(out), buf, 32), 0);
  assert.equal(h.u32(buf + 8), 0); assert.equal(h.u32(buf + 28), 1);
  h.u32(desc + 20, 0);
  assert.equal(api.aster_surface_create(desc, 24, out), -2);
  h.u32(desc + 20, 1); h.u32(desc + 8, 100); h.u32(desc + 12, 100);
  assert.equal(api.aster_surface_create(desc, 24, out), 0);
  assert.equal(api.aster_surface_acquire(h.u32(out), buf, 32), 0);
  assert.ok(h.u32(buf + 8) > 0); assert.equal(h.u32(buf + 28), 0);
});
