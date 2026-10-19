'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkManifest } = require('../src/package');
test('3.x packages are rejected before execution', () => {
  assert.throws(() => checkManifest({ id: 'old.app', abi: { min: '3.13.0' } }), /unsupported ABI/);
  checkManifest({ id: 'new.app', abi: { min: '4.0.0' } });
});
