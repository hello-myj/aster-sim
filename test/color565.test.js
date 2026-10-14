'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {createCanvas,to565,from565,blend565,drawBitmap565}=require('../src/graphics');
test('RGB565 coverage preserves identical colors and symmetric native rounding',()=>{
 for(let c=0;c<65536;c+=1)for(const a of [0,1,17,85,128,170,254,255])assert.equal(blend565(c,c,a),c);
 for(let d=0;d<32;d++)for(let s=0;s<32;s++)for(let a=0;a<256;a++){
  assert.equal(blend565(d,s,a),Math.floor((d*(255-a)+s*a+127)/255));
  assert.equal(blend565(d,s,a),blend565(s,d,255-a));
 }
});
test('native sprite alpha, color key, negative origin and fractional nearest match firmware',()=>{
 const source=createCanvas(3,2), texture=Buffer.alloc(12);
 [0xf800,0,0x07e0,0x8410,0x001f,0xffff].forEach((v,i)=>texture.writeUInt16LE(v,i*2));from565(source,texture);
 for(const scale of [128,256,384,511,768])for(const alpha of [1,85,128,254,255]){
  const canvas=createCanvas(8,8), background=Buffer.alloc(128);for(let i=0;i<64;i++)background.writeUInt16LE(0x8410,i*2);from565(canvas,background);
  const image={canvas:source};drawBitmap565(canvas.getContext('2d'),image,-1,1,scale,alpha,[1,2,4,3]);
  const output=to565(canvas),w=Math.floor(3*scale/256),h=Math.floor(2*scale/256);
  for(let y=0;y<8;y++)for(let x=0;x<8;x++){
   let expected=0x8410;
   if(x>=1&&x<5&&y>=2&&y<5&&x<-1+w&&y<1+h){
    const color=texture.readUInt16LE((Math.floor((y-1)*2/h)*3+Math.floor((x+1)*3/w))*2);
    if(color)expected=blend565(expected,color,alpha);
   }
   assert.equal(output.readUInt16LE((y*8+x)*2),expected);
  }
 }
});

test('PNG independent alpha is composited onto black before native RGB565, with device fit rounding',()=>{
 const {PNG}=require('pngjs'),{decodeImage}=require('../src/graphics');
 const png=new PNG({width:3,height:2});
 for(let i=0;i<png.data.length;i+=4)png.data.set([200,160,80,128],i);
 const bytes=PNG.sync.write(png),native=to565(decodeImage(bytes,3,2).canvas);
 const expected=((Math.floor(200*128/255)>>3)<<11)|((Math.floor(160*128/255)>>2)<<5)|(Math.floor(80*128/255)>>3);
 for(let i=0;i<6;i++)assert.equal(native.readUInt16LE(i*2),expected);
 assert.equal(decodeImage(bytes,2,2).canvas.height,1);
});
