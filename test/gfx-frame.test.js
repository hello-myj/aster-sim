'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Host}=require('../src/host');const {createCanvas}=require('../src/graphics');
const MAGIC=0x47465231;
function fixture(flags=0){
 let now=0;const host=new Host({manifest:{id:'test.frame',permissions:[],memory:{heap:262144}},assets:new Map()},{width:4,height:4,clock:()=>now});
 host.memory=new WebAssembly.Memory({initial:2});host.heap=16384;
 const h=host.add('surface',{w:4,h:4,ptr:flags?0:8192,flags,canvas:createCanvas(4,4)},0x02000000),s=host.get(h,'surface');
 s.canvas.getContext('2d').fillStyle='red';s.canvas.getContext('2d').fillRect(0,0,4,4);host.syncOut(s);host.present(s);
 const api=host.imports();
 function control(action,id=0){[24,1,action,id,0,0].forEach((v,i)=>host.u32(128+i*4,v));return api.aster_gfx_exec(h,0,-1,128,24,MAGIC,1,0,0);}
 function begin(){assert.equal(control(0),0);assert.equal(host.u32(144)&1,1);assert.equal(control(1),0);return host.u32(140);}
 function draw(id,op=0){[op,0x07e0,0,0,0,0].forEach((v,i)=>host.u32(256+i*4,v));return api.aster_gfx_exec(h,256,1,0,0,id,MAGIC,0,0);}
 return {host,api,h,s,control,begin,draw,time:t=>now=t,pixel:()=>host.screen.getContext('2d').getImageData(0,0,1,1).data.slice(0,3)};
}
test('many private batches publish exactly once and commit Guest pixels',()=>{
 const f=fixture(),id=f.begin();for(let i=0;i<6;i++)assert.equal(f.draw(id),1);
 assert.equal(f.host.presentCount,1);assert.deepEqual([...f.pixel()],[255,0,0]);assert.equal(f.host.bytes(8192,2).readUInt16LE(),0xf800);
 assert.equal(f.control(2,id),0);assert.equal(f.host.presentCount,2);assert.deepEqual([...f.pixel()],[0,255,0]);assert.equal(f.host.bytes(8192,2).readUInt16LE(),0x07e0);
});
test('cancel, stale batch/token, timeout and recovery never publish a draft',()=>{
 const f=fixture(),id=f.begin();f.draw(id);assert.equal(f.control(3,id),0);
 assert.equal(f.draw(id),-12);const next=f.begin();assert.notEqual(id,next);assert.equal(f.control(2,id),-12);
 f.time(1000);assert.equal(f.draw(next),-8);assert.equal(f.control(2,next),-8);assert.equal(f.host.presentCount,1);
 f.time(2000);const recovered=f.begin();f.draw(recovered);assert.equal(f.control(2,recovered),0);assert.equal(f.host.presentCount,2);
});
test('bad resources poison the whole frame and preserve committed Guest pixels',()=>{
 const f=fixture(),id=f.begin();f.draw(id);
 [9,0,999,0,0,0].forEach((v,i)=>f.host.u32(256+i*4,v));
 assert.equal(f.api.aster_gfx_exec(f.h,256,1,0,0,id,MAGIC,0,0),-10);
 assert.equal(f.control(2,id),-10);assert.equal(f.host.presentCount,1);assert.equal(f.host.bytes(8192,2).readUInt16LE(),0xf800);
});
test('direct flush, pause and surface destruction cannot bypass a transaction',()=>{
 const f=fixture(),id=f.begin();f.draw(id);assert.equal(f.api.aster_surface_present(f.h),-5);assert.equal(f.control(2,id),-5);
 const next=f.begin();f.draw(next);f.host.call=()=>0;f.host.setPaused(true);assert.equal(f.draw(next),-12);assert.equal(f.host.presentCount,1);
 f.host.setPaused(false);const last=f.begin();f.draw(last);assert.equal(f.api.aster_surface_destroy(f.h),0);assert.equal(f.host.gfxFrame,null);assert.equal(f.host.presentCount,1);
});
test('canvas first batch must clear and frame budgets are bounded',()=>{
 const f=fixture(1),id=f.begin();assert.equal(f.draw(id,1),-12);assert.equal(f.control(2,id),-12);assert.equal(f.host.presentCount,1);
 const next=f.begin();assert.equal(f.draw(next),1);f.host.gfxFrame.batches=256;assert.equal(f.draw(next),-11);assert.equal(f.control(2,next),-11);
});

test('unaligned command arrays are rejected before private rasterization',()=>{
 const f=fixture(),id=f.begin();
 assert.equal(f.api.aster_gfx_exec(f.h,257,1,0,0,id,MAGIC,0,0),-1);
 assert.equal(f.control(2,id),-1);assert.equal(f.host.presentCount,1);
 assert.equal(f.host.bytes(8192,2).readUInt16LE(),0xf800);
});

test('optional frame clip is private, bounded, reset on begin, and QUERY epoch survives draws',()=>{
 const f=fixture();f.host.fontEpoch=37;assert.equal(f.control(0),0);assert.equal(f.host.u32(144),7);assert.equal(f.host.u32(140),37);
 const id=f.begin();
 function clip(x,y,w,h){[32,1,4,id,x,y,w,h].forEach((v,i)=>f.host.u32(128+i*4,v));return f.api.aster_gfx_exec(f.h,0,-1,128,32,MAGIC,1,0,0);}
 assert.equal(clip(1,1,2,2),0);
 [1,0,(4<<16)|4,0x001f,0,0].forEach((v,i)=>f.host.u32(256+i*4,v));
 assert.equal(f.api.aster_gfx_exec(f.h,256,1,0,0,id,MAGIC,0,0),1);assert.equal(f.host.presentCount,1);
 assert.equal(f.control(2,id),0);
 const px=f.s.canvas.getContext('2d').getImageData(0,0,4,4).data;
 for(let y=0;y<4;y++)for(let x=0;x<4;x++)assert.deepEqual([...px.slice((y*4+x)*4,(y*4+x)*4+3)],x>=1&&x<3&&y>=1&&y<3?[0,0,255]:[255,0,0]);
 assert.equal(f.control(0),0);assert.equal(f.host.u32(140),37);
 const next=f.begin();assert.deepEqual(f.host.gfxFrame.clip,[0,0,4,4]);
 [32,1,4,next,0xffffffff,0,2,2].forEach((v,i)=>f.host.u32(128+i*4,v));
 assert.equal(f.api.aster_gfx_exec(f.h,0,-1,128,32,MAGIC,1,0,0),-1);assert.equal(f.control(2,next),-1);
});
