'use strict';
require('../scripts/integration-inputs').requireIntegrationInputs();
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const AsterAudioPlayer = require('../web/audio');
const { Host } = require('../src/host'), { loadPackage } = require('../src/package');
class FakeContext {
  constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; this.sources = []; this.decodes = 0; }
  parameter(value = 1) { return { value, cancelScheduledValues() {}, setValueAtTime(v) { this.value = v; }, linearRampToValueAtTime(v, t) { this.target = v; this.targetTime = t; } }; }
  createGain() { return { gain: this.parameter(), connect() {} }; }
  createBuffer(channels,length,rate) {
    const data=Array.from({length:channels},()=>new Float32Array(length));
    return {numberOfChannels:channels,length,sampleRate:rate,duration:length/rate,getChannelData:c=>data[c]};
  }
  async resume() { this.state = 'running'; }
  async decodeAudioData() { this.decodes++; return { duration: 16 }; }
  createBufferSource() {
    const source = { playbackRate: this.parameter(), connect() {}, start(...args) { this.started = args; }, stop() { this.stopped = true; this.onended?.(); }, finish() { this.onended?.(); } };
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

const { wavEffect, EffectVoice } = require('../src/audio-effects');
function wav() {
 const b=Buffer.alloc(44+3200); b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);
 b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);
 b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(3200,40);return b;
}
test('continuous effect timeline advances without frames, wraps intro and freezes when paused', () => {
 const info=wavEffect(wav()), v=new EffectVoice(info);
 const d={flags:1,start:100,end:1500,fade:100,pitch:65536,gain:65536,ms:0};
 assert.equal(v.play(d,0),0);v.sync(100);assert.equal(v.phase,300);
 v.suspend(true,100);v.sync(600100);assert.equal(v.phase,300);
 v.suspend(false,600100);v.sync(600150);assert.equal(v.phase,1100);
 const phase=v.phase;assert.equal(v.change({pitch:131072,gain:0,ms:0},600150),0);assert.equal(v.phase,phase);
 v.sync(600175);assert.equal(v.phase,600);assert.equal(v.playing,true);
 assert.equal(v.stop(100,600175),0);v.suspend(true,600225);v.sync(610225);assert.equal(v.playing,true);
 v.suspend(false,610225);v.sync(610275);assert.equal(v.playing,false);assert.equal(v.stop(0,610275),0);
 assert.equal(v.play({...d,fade:701},610275),-1);assert.equal(v.play({...d,flags:0},610275),-1);
});
test('effect RIFF rejects malformed sizes, alignment and unsupported PCM', () => {
 const b=wav();assert.equal(wavEffect(b).frames,1600);
 for(let i=0;i<b.length;i+=17)assert.throws(()=>wavEffect(b.subarray(0,i)),/Invalid PCM16/);
 const bad=Buffer.from(b);bad.writeUInt16LE(4,32);assert.throws(()=>wavEffect(bad));
});
test('versioned effect imports validate descriptors and retain phase during parameter updates', () => {
 const h=new Host({manifest:{id:'test.effect',permissions:['fs']},assets:new Map()});
 try {
  h.memory=new WebAssembly.Memory({initial:1});h.readVirtual=()=>wav();const a=h.imports();
  const id=a.aster_audio_effect_load(0,0);assert.ok(id>0);assert.equal(a.aster_system_has_feature(21),1);
  [36,1,1,0,0,0,65536,32768,50].forEach((v,i)=>h.u32(128+4*i,v));
  assert.equal(a.aster_audio_effect_play_ex(id,128,36),0);
  assert.equal(a.aster_audio_pause(),0);assert.equal(h.get(id,'effect').voice.paused,true);
  assert.equal(a.aster_audio_resume(),0);assert.equal(h.get(id,'effect').voice.paused,false);
  assert.equal(a.aster_audio_effect_play_ex(id,65530,36),-1);
  assert.equal(a.aster_audio_effect_play_ex(id,128,35),-1);
  h.u32(132,2);assert.equal(a.aster_audio_effect_play_ex(id,128,36),-1);
  [20,1,98304,65536,100].forEach((v,i)=>h.u32(256+4*i,v));
  assert.equal(a.aster_audio_effect_set_params(id,256,20),0);
  assert.equal(a.aster_audio_effect_stop(id,1001),-1);
  assert.equal(a.aster_audio_effect_stop(id,0),0);
  assert.equal(a.aster_audio_effect_unload(id),0);
 } finally {h.stop();}
});
test('browser looping source keeps its source on parameter changes and stops independently', async () => {
 const {output,context,errors}=player();await output.enable();
 await output.handle({op:'effect-load',handle:2,data,info:{rate:16000,frames:1600}});
 await output.handle({op:'effect',handle:2,desc:{flags:1,start:100,end:1500,fade:0,pitch:65536,gain:32768,ms:20}});
 const source=output.activeEffects.get(2);assert.equal(source.loop,true);assert.equal(source.loopStart,100/16000);
 await output.handle({op:'effect-params',handle:2,params:{pitch:98304,gain:65536,ms:100}});
 assert.equal(output.activeEffects.get(2),source);assert.equal(source.playbackRate.target,1.5);
 await output.handle({op:'effect-suspend',paused:true});assert.equal(source.playbackRate.value,0);
 await output.handle({op:'effect-suspend',paused:false});assert.equal(output.activeEffects.get(2),source);
 await output.handle({op:'effect-stop',handle:2,ms:0});assert.equal(source.stopped,true);
 assert.equal(output.effects.has(2),true);assert.deepEqual(errors,[]);
});
test('effect-only commands queued before browser unlock are started once enabled', async () => {
 const {output}=player();await output.handle({op:'effect-load',handle:3,data});
 await output.handle({op:'effect',handle:3});await output.enable();assert.equal(output.activeEffects.size,1);
 await output.handle({op:'stop'});
});

const { AudioReplay } = require('../src/audio-replay');
test('late browser attachment replays active loops and latest params, never expired one-shots', () => {
 const r=new AudioReplay();
 for(const handle of [1,2]) r.accept({type:'audio',op:'effect-load',handle,data});
 r.accept({type:'audio',op:'effect',handle:1,desc:{flags:1,pitch:65536,gain:65536,ms:0},volume:80});
 r.accept({type:'audio',op:'effect',handle:2});
 r.accept({type:'audio',op:'effect-params',handle:1,params:{pitch:98304,gain:32768,ms:50}});
 r.accept({type:'audio',op:'volume',volume:50});r.accept({type:'audio',op:'effect-suspend',paused:true});
 const msgs=r.messages(), plays=msgs.filter(m=>m.op==='effect');
 assert.equal(plays.length,1);assert.equal(plays[0].handle,1);assert.equal(plays[0].desc.pitch,98304);
 assert.equal(msgs.at(-1).volume,50);assert.equal(msgs.at(-2).paused,true);
 r.accept({type:'audio',op:'effect-stop',handle:1});assert.equal(r.messages().filter(m=>m.op==='effect').length,0);
 r.accept({type:'audio',op:'effect-unload',handle:1});assert.equal(r.loads.size,1);
 r.accept({type:'audio',op:'stop'});assert.equal(r.loops.size,0);
});

test('browser crossfade uses source frames, overlaps tail once and skips the consumed loop head', async () => {
 const {output,context,errors}=player();await output.enable();
 const buffer=context.createBuffer(1,8,16000);buffer.getChannelData(0).set([0,.02,.04,.06,.08,.1,.12,.14]);
 context.decodeAudioData=async()=>buffer;
 await output.handle({op:'effect-load',handle:7,data,info:{rate:16000,frames:8}});
 await output.handle({op:'effect',handle:7,desc:{flags:1,start:2,end:8,fade:2,pitch:65536,gain:65536,ms:0}});
 const source=output.activeEffects.get(7);
 assert.equal(source.loopStart,4/16000);assert.equal(source.loopEnd,8/16000);
 assert.ok(Math.abs(source.buffer.getChannelData(0)[7]-.1)<1e-6);
 assert.ok(Math.abs(buffer.getChannelData(0)[7]-.14)<1e-6); // shared decoded cache is immutable
 await output.handle({op:'stop'});assert.deepEqual(errors,[]);
});
