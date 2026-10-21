'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { Host } = require('../src/host');
const { Replay, validateReplay } = require('../src/replay');
const { connectTouchPointers } = require('../web/touch');
function host(t) {
  const h = new Host({manifest:{id:'test.multitouch',permissions:[]},assets:new Map()});
  h.memory = new WebAssembly.Memory({initial:1}); h.heap=4096; h.eventPtr=128;
  const events=[], hooks=[];
  h.call=(name,p)=>{hooks.push(name);if(name==='aster_app_event')events.push([h.u32(p+8),...Array.from({length:4},(_,i)=>h.u32(p+24+i*4))]);return 0;};
  t.after(()=>h.stop());return {h,api:h.imports(),events,hooks};
}
test('two touches preserve slots and release independently, with a bounded 12-byte snapshot',t=>{
  const {h,api,events}=host(t), p=513;
  h.input({type:'touch',action:1,x:10,y:20});
  h.input({type:'touch',action:1,slot:1,x:100,y:200});
  h.bytes(p-1,32).fill(0xa5);
  assert.equal(api.aster_input_touch(p,2),2);
  assert.deepEqual(Array.from({length:6},(_,i)=>h.u32(p+i*4)),[10,20,1,100,200,1]);
  assert.equal(h.bytes(p-1,1)[0],0xa5);assert.equal(h.bytes(p+24,1)[0],0xa5);
  h.input({type:'touch',action:2,slot:1,x:12,y:22});
  h.input({type:'touch',action:2,slot:0,x:102,y:202});
  h.input({type:'touch',action:3,slot:0,x:102,y:202});
  assert.equal(api.aster_input_touch(p,2),1);assert.deepEqual([h.u32(p),h.u32(p+4),h.u32(p+8)],[12,22,1]);
  assert.deepEqual(events.map(e=>e[4]),[0,1,1,0,0]);
  assert.equal(api.aster_input_touch(0xffffffff,0),0);
  assert.equal(api.aster_input_touch(h.memory.buffer.byteLength-12,2),-1);
  h.bytes(p,28).fill(0xa5);assert.equal(api.aster_input_touch(p,1),1);assert.equal(h.bytes(p+12,1)[0],0xa5);
  h.input({type:'touch',action:3,slot:1,x:12,y:22});assert.equal(api.aster_input_touch(p,2),0);
  const info=768;h.u32(info,20);h.u32(info+4,1);assert.equal(api.aster_input_get_info(info,20),0);assert.equal(h.u32(info+12),2);
});
test('invalid input, stale moves, pause and stop cannot leave held touches',t=>{
  const {h,api,events}=host(t);
  for(const slot of [-1,2,NaN,1.5])h.input({type:'touch',action:1,slot,x:10,y:10});
  h.input({type:'touch',action:2,slot:1,x:10,y:10});h.input({type:'touch',action:1,x:Infinity,y:1});assert.equal(events.length,0);
  h.input({type:'touch',action:1,x:10,y:10});h.input({type:'touch',action:1,slot:1,x:20,y:20});
  h.setPaused(true);assert.equal(api.aster_input_touch(512,2),0);
  h.input({type:'touch',action:1,slot:1,x:30,y:30});h.setPaused(false);
  h.input({type:'touch',action:2,slot:1,x:31,y:31});assert.equal(api.aster_input_touch(512,2),0);
  h.input({type:'touch',action:1,slot:1,x:20,y:20});h.stop();assert.equal(h.touches.size,0);
});
test('replay accepts same-frame two-slot events and keeps old slot-zero records',t=>{
  const events=[{frame:0,type:'touch',action:1,x:10,y:20},{frame:0,type:'touch',action:1,slot:1,x:100,y:200},
    {frame:1,type:'touch',action:3,x:10,y:20},{frame:2,type:'touch',action:3,slot:1,x:100,y:200}];
  const config={version:1,frames:3,step_ms:16,seed:1,events};
  assert.throws(()=>validateReplay({...config,events:[{...events[0],slot:2}]}),/touch/);
  const {h,api}=host(t);h.tick=()=>{};const replay=new Replay(config);
  replay.step(h);assert.equal(api.aster_input_touch(512,2),2);
  replay.step(h);assert.equal(api.aster_input_touch(512,2),1);
  replay.step(h);assert.equal(api.aster_input_touch(512,2),0);
});
test('browser pointer capture maps two IDs to stable slots and releases cancel/loss/blur once',()=>{
  const sent=[],canvas={width:240,height:320,focus(){},setPointerCapture(){},getBoundingClientRect(){return {left:0,top:0,width:240,height:320};}};
  const pointers=connectTouchPointers(canvas,msg=>sent.push(msg));
  const e=(pointerId,x=20,y=30)=>({pointerId,clientX:x,clientY:y,button:0});
  canvas.onpointerdown(e(40));canvas.onpointerdown(e(90,100,200));canvas.onpointerdown(e(99));
  assert.deepEqual(sent.map(p=>p.slot),[0,1]);canvas.onpointermove(e(90,2,3));assert.equal(sent.at(-1).slot,1);
  canvas.onpointerup({...e(40,300,400),type:"pointerup"});assert.deepEqual([sent.at(-1).x,sent.at(-1).y],[239,319]);canvas.onlostpointercapture(e(40));assert.equal(sent.length,4);
  canvas.onpointerdown(e(71));assert.equal(sent.at(-1).slot,0);
  canvas.onpointercancel(e(90));assert.deepEqual([sent.at(-1).action,sent.at(-1).slot],[3,1]);
  pointers.release();pointers.release();assert.deepEqual([sent.at(-1).action,sent.at(-1).slot],[3,0]);assert.equal(sent.length,7);
});
