'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
test('blocked WASM event is killed without freezing the CLI', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aster-watchdog-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Independent minimal module: init returns zero, event runs loop { br 0 }.
  const bytes = [0,97,115,109,1,0,0,0];
  const section = (id, data) => { bytes.push(id, data.length, ...data); };
  section(1, [2, 0x60,0,1,0x7f, 0x60,1,0x7f,0]);
  section(3, [2,0,1]); section(5, [1,1,1,32]); section(6, [1,0x7f,0,0x41,0x80,0x08,0x0b]);
  const exports = [4];
  for (const [name, kind, index] of [['memory',2,0],['__heap_base',3,0],['aster_app_init',0,0],['aster_app_event',0,1]]) exports.push(name.length, ...Buffer.from(name), kind, index);
  section(7, exports); section(10, [2,4,0,0x41,0,0x0b,7,0,0x03,0x40,0x0c,0,0x0b,0x0b]);
  const wasm = Buffer.from(bytes); assert.equal(WebAssembly.validate(wasm), true);
  const file = path.join(root, 'blocked.wasm'); fs.writeFileSync(file, wasm);
  const run = spawnSync(process.execPath, [path.join(__dirname, '../src/cli.js'), file, '--headless', '--watchdog', '1', '--diagnostics', path.join(root,'report.json'), '--state', path.join(root, 'state')], { timeout: 6000, encoding: 'utf8' });
  assert.equal(run.status, 1, run.stderr); assert.match(run.stderr, /WASM callback blocked/);
  const report=JSON.parse(fs.readFileSync(path.join(root,'report.json')));assert.equal(report.diagnostics.phase,'aster_app_event');assert.ok(report.diagnostics.appId);assert.equal(report.code,1);
});
