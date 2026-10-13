'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createCanvas,execGraphics}=require('../src/graphics');
function fixture(commands){
 const canvas=createCanvas(4,4),ctx=canvas.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,4,4);
 const words=commands.flat();let syncs=0;
 const host={range:()=>true,u32:p=>words[p/4],handles:new Map([[1,{kind:'bitmap',canvas}]]),syncIn:()=>{},syncOut:()=>syncs++,present:()=>{}};
 const target=createCanvas(4,4);return {host,s:{w:4,h:4,canvas:target},syncs:()=>syncs};
}
test('sprite clip restores context and leaves outside pixels unchanged',()=>{
 const f=fixture([[9,0,1,0,0,0]]);
 assert.equal(execGraphics(f.host,f.s,0,1,0,0,1,1,2,2),1);
 const p=f.s.canvas.getContext('2d').getImageData(0,0,4,4).data;
 for(let y=0;y<4;y++)for(let x=0;x<4;x++)assert.equal(p[(y*4+x)*4+3],x>=1&&x<3&&y>=1&&y<3?255:0);
 assert.equal(execGraphics(f.host,f.s,0,1,0,0,0,0,0,0),1);
 assert.equal(f.s.canvas.getContext('2d').getImageData(0,0,1,1).data[3],255);
});
test('stale sprite and invalid region fail before clear or sync',()=>{
 const f=fixture([[0,0xffff,0,0,0,0],[9,0,99,0,0,0]]);
 assert.equal(execGraphics(f.host,f.s,0,2,0,0,0,0,4,4),-10);
 assert.equal(f.syncs(),0);assert.equal(f.s.canvas.getContext('2d').getImageData(0,0,1,1).data[3],0);
 assert.equal(execGraphics(f.host,f.s,0,2,0,0,0,0,4,0),-1);
});

test('sprite alpha uses the ABI mask and zero alpha writes nothing',()=>{
 const f=fixture([[11,0,1,0,512,0]]);
 assert.equal(execGraphics(f.host,f.s,0,1,0,0,0,0,4,4),1);
 assert.equal(f.s.canvas.getContext('2d').getImageData(0,0,1,1).data[3],0);
});
