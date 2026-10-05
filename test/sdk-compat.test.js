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
