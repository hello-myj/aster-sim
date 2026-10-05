#!/usr/bin/env node
'use strict';
// Check the real SDK contract, rather than merely comparing ABI version strings.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const snapshot = require('../src/sdk-compat.json');
const { Host } = require('../src/host');
function checkSdk(root) {
  const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const lock = read('contract/lock.json'), api = read('contract/api.json');
  assert.equal(lock.abi, snapshot.abi, 'SDK ABI changed; review runtime implementations before updating the snapshot');
  assert.equal(api.abi, snapshot.abi, 'API ABI does not match supported contract');
  const hashes = Object.fromEntries(Object.entries(lock.sha256).filter(([name]) => name.startsWith('contract/') || name.startsWith('include/')));
  assert.deepEqual(hashes, snapshot.contractHashes, 'SDK public contract changed; review signatures, structures and constants, even if ABI is unchanged');
  for (const [name, expected] of Object.entries(lock.sha256)) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex');
    assert.equal(actual, expected, `SDK contract lock mismatch: ${name}`);
  }
  assert.deepEqual([...api.imports.env].sort(), [...snapshot.imports].sort(), 'SDK import contract changed');
  const host = new Host({ manifest: { id: 'test.sdkcompat', permissions: [] }, assets: new Map() });
  try {
    const handlers = host.imports();
    for (const name of api.imports.env.filter(name => name.startsWith('aster_'))) {
      assert.equal(typeof handlers[name], 'function', `Missing APP API implementation: ${name}`);
    }
  } finally { host.stop(); }
  const boards = {};
  for (const name of fs.readdirSync(path.join(root, 'targets')).filter(name => name.endsWith('.json')).sort()) {
    const target = read(`targets/${name}`);
    boards[target.id] = { width: target.display.width, height: target.display.height, format: target.display.format, maxLinear: target.memory.max_linear };
  }
  assert.deepEqual(boards, snapshot.boards, 'SDK board display or memory profiles changed');
  return { abi: snapshot.abi, publicImports: api.imports.env.filter(name => name.startsWith('aster_')).length, boards: Object.keys(boards) };
}
if (require.main === module) {
  try { console.log(JSON.stringify(checkSdk(path.resolve(process.argv[2] || path.join(__dirname, '../../aster-sdk'))), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { checkSdk };
