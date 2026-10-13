'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {Replay,validateReplay}=require('../src/replay');
const {MemoryFS}=require('../src/memory-fs');
const {packageFixture}=require('./fixtures');
function scenario(extra={}){return {version:1,frames:5,step_ms:16,seed:42,events:[],...extra};}
function run(t,config,pkg){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aster-replay-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const app=path.join(dir,'app.ast'),input=path.join(dir,'input.json'),report=path.join(dir,'report.json');
 fs.writeFileSync(app,pkg||packageFixture());fs.writeFileSync(input,JSON.stringify(config));
 const result=spawnSync(process.execPath,[path.join(__dirname,'../src/cli.js'),app,'--replay',input,'--diagnostics',report],{encoding:'utf8',timeout:12000});
 assert.ok(fs.existsSync(report),result.stderr);return {result,report:JSON.parse(fs.readFileSync(report))};
}
test('replay repeats complete WASM state with a fixed clock, including pause',t=>{
 const config=scenario({events:[{frame:1,type:'pause',paused:true},{frame:3,type:'pause',paused:false}]});
 const a=run(t,config),b=run(t,config);assert.equal(a.result.status,0,a.result.stderr);assert.equal(b.result.status,0,b.result.stderr);
 assert.deepEqual(a.report.state,b.report.state);assert.equal(a.report.replay.steps,5);assert.equal(a.report.state.frame,3);assert.equal(a.report.state.virtualMs,64);
});
test('allocator failure has APP/phase/ABI diagnostics and nonzero exit',t=>{
 const a=run(t,scenario({faults:{allocation_fail_at:1}}));assert.equal(a.result.status,1);
 assert.equal(a.report.diagnostics.appId,'test.fixture');assert.match(a.report.error,/event buffer memory/);assert.equal(a.report.abi,'3.7.0');
});
test('hard-required missing capability is reported before initialization',t=>{
 const {Host}=require('../src/host');assert.throws(()=>new Host({manifest:{id:'test.missing',requires:['display']},assets:new Map()}, {missingFeatures:['display']}),/Required capability unavailable/);
});
test('quota failure is atomic and accounts for unlinked open files',()=>{
 const m=new MemoryFS(4);m.mkdirSync('/test',{recursive:true});m.writeFileSync('/test/a',Buffer.from('1234'));
 const fd=m.openSync('/test/a',m.constants.O_RDWR);m.unlinkSync('/test/a');assert.equal(m.usedBytes(),4);
 assert.throws(()=>m.writeFileSync('/test/b',Buffer.from('X')),e=>e.code==='ENOSPC');assert.equal(m.existsSync('/test/b'),false);
 m.closeSync(fd);m.writeFileSync('/test/b',Buffer.from('AB'));assert.throws(()=>m.writeFileSync('/test/b',Buffer.from('ABCDE')),e=>e.code==='ENOSPC');assert.equal(m.readFileSync('/test/b').toString(),'AB');
});
test('seeded sensor stimuli reproduce and malformed replay inputs fail',()=>{
 const values=seed=>{let result=[];const r=new Replay(scenario({seed,events:[{frame:0,type:'sensor-noise',amplitude:1}]}));r.step({input:e=>result.push(e),tick(){}});return result;};
 assert.deepEqual(values(123),values(123));assert.notDeepEqual(values(123),values(124));
 for(const config of [scenario({step_ms:0}),scenario({events:[{frame:6,type:'pause',paused:true}]}),scenario({faults:{missing_features:['unknown']}})])assert.throws(()=>validateReplay(config));
});
test('real SDK 2048 deterministic swipe renders identical state and pixels',{skip:!process.env.ASTER_SIM_2048_AST},t=>{
 const pkg=fs.readFileSync(process.env.ASTER_SIM_2048_AST),config=JSON.parse(fs.readFileSync(path.join(__dirname,'replays/2048-swipe.json')));
 const a=run(t,config,pkg),b=run(t,config,pkg);assert.equal(a.result.status,0,a.result.stderr);assert.equal(b.result.status,0,b.result.stderr);assert.deepEqual(a.report.state,b.report.state);assert.ok(a.report.state.presents>0);
 assert.ok(a.report.diagnostics.abiCalls.aster_gfx_exec>0);assert.ok(a.report.diagnostics.guestPeakBytes>0);
});

test('quota and optional-capability faults reach APP imports with correct errors',t=>{
 const {Host}=require('../src/host');const h=new Host({manifest:{id:'test.quota',permissions:['fs']},assets:new Map()},{storageBytes:0,missingFeatures:['accelerometer']});t.after(()=>h.stop());
 h.memory=new WebAssembly.Memory({initial:1});h.heap=4096;const api=h.imports();
 const p=h.alloc(16),out=h.alloc(4),data=h.alloc(4);h.bytes(p,8).set(Buffer.from('/data/x\0'));h.bytes(data,4).set(Buffer.from('ABCD'));
 assert.equal(api.aster_fs_open(p,7,0x12,out),0);const fd=h.u32(out);assert.equal(api.aster_fs_write(fd,data,4),-11);assert.equal(api.aster_fs_close(fd),0);
 assert.equal(api.aster_system_has_feature(9),0);assert.equal(api.aster_accel_read(data,12),-16);assert.equal(h.storageFs.usedBytes(),0);
});

test('WASM Trap report preserves APP and failing callback after cleanup',t=>{
 const {wasmFixture}=require('./fixtures');const a=run(t,scenario(),packageFixture(wasmFixture([0,0,0x0b])));
 assert.equal(a.result.status,1);assert.equal(a.report.diagnostics.appId,'test.fixture');assert.equal(a.report.diagnostics.trap.phase,'aster_app_event');assert.match(a.report.diagnostics.trap.message,/unreachable/);
});
