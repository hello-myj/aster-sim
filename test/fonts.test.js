'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fontFace, snap, textFont, execGraphics } = require('../src/graphics');
const faces = require('../src/sdk-compat.json').fontFaces;

test('native font sizes, default and ties match the reviewed SDK contract', () => {
  assert.deepEqual(faces.map(f => f.px).sort((a,b) => a-b), [12,14,16,18,20,24,28,32,40,48]);
  assert.equal(snap(0), 20); assert.equal(snap(13), 12); assert.equal(snap(19), 20);
  assert.equal(snap(30), 28); assert.equal(snap(64), 48);
  for (const face of faces) {
    assert.equal(snap(face.px), face.px);
    const ctx = {}; textFont(ctx, face.px);
    assert.ok(ctx.font.startsWith(`${face.px}px `)); assert.equal(ctx.textBaseline, 'alphabetic');
  }
});

test('text background uses actual native ascent and line height at every size', () => {
  for (const face of faces) {
    const calls = [];
    const context = { measureText: () => ({ width: 11 }), fillRect: (...args) => calls.push(args), fillText: (...args) => calls.push(args) };
    const command = [7, (90 << 16) | 2, (0xffff << 16) | face.px, 0, 1, 0x10000];
    const host = { range: () => true, syncIn: () => {}, syncOut: () => {}, u32: p => command[p/4], string: () => 'A' };
    const surface = { canvas: { getContext: () => context } };
    assert.equal(execGraphics(host, surface, 0, 1, 0, 1, 0, 0, 0, 0), 1);
    assert.deepEqual(calls, [[2, 90-face.asc, 11, face.line_h], ['A', 2, 90]]);
  }
});
