'use strict';
require('../scripts/integration-inputs').requireIntegrationInputs();
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const AsterAudioPlayer = require('../web/audio');
const { Host } = require('../src/host'), { loadPackage } = require('../src/package');
class FakeContext {
  constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; this.sources = []; this.decodes = 0; }
  createGain() { return { gain: { value: 1 }, connect() {} }; }
  async resume() { this.state = 'running'; }
  async decodeAudioData() { this.decodes++; return { duration: 16 }; }
  createBufferSource() {
    const source = { connect() {}, start(...args) { this.started = args; }, stop() { this.stopped = true; this.onended?.(); }, finish() { this.onended?.(); } };
    this.sources.push(source); return source;
  }
}
function player() {
  const context = new FakeContext(), messages = [], errors = [];
  const output = new AsterAudioPlayer({ createContext: () => context, send: m => messages.push(m), error: e => errors.push(e) });
  return { output, context, messages, errors };
}
const data = Buffer.from('test-audio').toString('base64');

test('stop cancels a pending effect decode but keeps its cache for later playback', async () => {
  const { output, context } = player(); await output.enable();
  let resolve; context.decodeAudioData = () => new Promise(r => { resolve = r; });
  const loading = output.handle({ op: 'effect-load', handle: 21, data });
  const pending = output.handle({ op: 'effect', handle: 21 });
  await output.handle({ op: 'stop' }); resolve({ duration: .1 }); await loading; await pending;
  assert.equal(context.sources.length, 0);
  await output.handle({ op: 'effect', handle: 21 });
  assert.equal(context.sources.length, 1);
});

test('natural BGM completion reports IDLE feedback and a new session can play again', async () => {
  const { output, context, messages, errors } = player();
  await output.handle({ op: 'start', session: 1, data }); await output.enable();
  assert.equal(messages[0].event, 'started'); assert.equal(messages[0].durationMs, 16000);
  context.sources[0].finish(); assert.equal(messages[1].event, 'ended'); assert.equal(messages[1].session, 1);
  await output.handle({ op: 'start', session: 2, data }); assert.equal(messages[2].session, 2);
  assert.equal(context.sources.length, 2); assert.equal(errors.length, 0);
});
test('effects mix with BGM, are decoded once, and same handle restarts without stacking', async () => {
  const { output, context, messages, errors } = player();
  await output.handle({ op: 'effect-load', handle: 21, data });
  await output.handle({ op: 'effect-load', handle: 22, data });
  await output.handle({ op: 'start', session: 1, data }); await output.enable();
  const bgm = output.music.source, decoded = context.decodes;
  await output.handle({ op: 'effect', handle: 21 }); const first = output.activeEffects.get(21);
  await output.handle({ op: 'effect', handle: 22 });
  assert.equal(output.activeEffects.size, 2); assert.equal(bgm.stopped, undefined);
  await output.handle({ op: 'effect', handle: 21 });
  assert.equal(first.stopped, true); assert.notEqual(output.activeEffects.get(21), first);
  assert.equal(context.decodes, decoded); assert.equal(messages.filter(m => m.event === 'ended').length, 0);
  await output.handle({ op: 'effect-unload', handle: 21 }); assert.equal(output.effects.has(21), false);
  assert.equal(errors.length, 0);
});
test('pause, seek and stop never send a false natural completion', async () => {
  const { output, context, messages } = player();
  await output.enable(); await output.handle({ op: 'start', session: 1, data });
  context.currentTime = 3; await output.handle({ op: 'pause' });
  assert.equal(output.music.offset, 3); await output.handle({ op: 'seek', ms: 5000 });
  assert.equal(output.music.source, null); await output.handle({ op: 'resume' });
  assert.equal(output.music.source.started[1], 5); await output.handle({ op: 'stop' });
  assert.equal(messages.filter(m => m.event === 'ended').length, 0);
});
test('stop while background decode is pending cannot start a stale stream', async () => {
  const { output, context, messages } = player(); await output.enable();
  let resolve; context.decodeAudioData = () => new Promise(r => { resolve = r; });
  const pending = output.handle({ op: 'start', session: 1, data });
  await output.handle({ op: 'stop' }); resolve({ duration: 16 }); await pending;
  assert.equal(context.sources.length, 0); assert.equal(messages.length, 0);
});
test('queued pre-unlock pause is preserved after enabling sound', async () => {
  const { output, messages } = player();
  await output.handle({ op: 'start', session: 1, data }); await output.handle({ op: 'pause' }); await output.enable();
  assert.equal(output.music.source, null); assert.equal(messages.filter(m => m.event === 'ended').length, 0);
});
test('external SDK 2048 loads 16 kHz effects and loops BGM', { skip: !process.env.ASTER_SIM_2048_AST }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aster-2048-audio-')), sent = [];
  const pkg = loadPackage(process.env.ASTER_SIM_2048_AST);
  const host = new Host(pkg, { state: root, send: m => sent.push(m) }).start();
  t.after(() => { host.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal([...host.handles.values()].filter(h => h.kind === 'effect').length, 4);
  assert.equal(sent.filter(m => m.op === 'effect-load').length, 4);
  const first = sent.find(m => m.op === 'start');
  host.input({ type: 'audio-feedback', session: first.session, event: 'started', durationMs: 16000 });
  assert.equal(host.audio.total, 16000);
  for (const [x, y] of [[200, 100], [50, 200], [200, 300]]) {
    host.input({ type: 'touch', x: 120, y: 200, action: 1 });
    host.input({ type: 'touch', x, y, action: 3 }); host.tick();
  }
  assert.ok(sent.some(m => m.op === 'effect' && m.handle > 0));
  host.input({ type: 'audio-feedback', session: first.session, event: 'ended' });
  assert.equal(host.audio.state, 0); host.tick();
  const starts = sent.filter(m => m.op === 'start');
  assert.equal(starts.length, 2); assert.notEqual(starts[1].session, first.session);
  host.input({ type: 'audio-feedback', session: first.session, event: 'ended' });
  assert.equal(host.audio.state, 1);
  host.input({ type: 'audio-feedback', session: starts[1].session, event: 'ended' }); host.tick();
  assert.equal(sent.filter(m => m.op === 'start').length, 3);
});

test('ABI 3.10 compressed stream capability is explicitly unavailable', () => {
  const h = new Host({manifest:{id:'test.stream',permissions:[]},assets:new Map()});
  try {
    const api=h.imports();
    assert.equal(api.aster_system_has_feature(18),0);
    for(const method of ['open','write','finish','status','close'])
      assert.equal(api['aster_audio_stream_'+method](1,0,1),-16);
  } finally { h.stop(); }
});
