'use strict';
// Desktop APP text uses the same SD CPFONT v4 glyphs and integer metrics as firmware.
const fs=require('node:fs'),path=require('node:path');
const {createCanvas}=require('@napi-rs/canvas');
const faces=require('./sdk-compat.json').fontFaces;
class FirmwareFonts {
 constructor(root){this.root=root;this.loaded=new Map();this.bitmaps=new Map();}
 face(px){let selected=faces[0];if(px)for(const face of faces)if(Math.abs(face.px-px)<Math.abs(selected.px-px))selected=face;
  if(this.loaded.has(selected.px))return this.loaded.get(selected.px);
  const data=fs.readFileSync(path.join(this.root,`ui_${selected.px}.cpfont`));
  if(data.length<64||data.toString('ascii',0,6)!=='CPFONT'||data.readUInt16LE(8)!==4||(data[10]&~1)||data.readUInt32LE(56)!==64)throw Error('Unsupported firmware font');
  const count=data.readUInt32LE(36),glyphs=data.readUInt32LE(40),records=64+12*count,bitmap=records+16*glyphs;
  if(!count||count>20000||!glyphs||glyphs>65536||bitmap>data.length||!data[44])throw Error('Invalid firmware font');
  const face={px:selected.px,data,count,glyphs,records,bitmap,bpp:data[10]&1?2:4,line_h:data[44],asc:data.readInt16LE(45)};
  if(this.loaded.size>=4)this.loaded.delete(this.loaded.keys().next().value);
  this.loaded.set(face.px,face);return face;
 }
 glyph(face,cp){
  if(cp<32||cp===0xf8ff||cp===0x200c)return {advance:0,w:0,h:0};
  const d=face.data;let lo=0,hi=face.count,index=-1;
  while(lo<hi){const mid=(lo+hi)>>>1,p=64+mid*12,first=d.readUInt32LE(p),last=d.readUInt32LE(p+4);if(cp<first)hi=mid;else if(cp>last)lo=mid+1;else{index=d.readUInt32LE(p+8)+cp-first;break;}}
  if(index<0)return {advance:face.px>>1,w:0,h:0};
  if(index>=face.glyphs)throw Error('Invalid font glyph index');
  const p=face.records+16*index,w=d[p],h=d[p+1],length=d.readUInt16LE(p+8),offset=face.bitmap+d.readUInt32LE(p+12);
  if(length!==Math.ceil(w*h*face.bpp/8)||offset+length>d.length)throw Error('Invalid font glyph bitmap');
  return {w,h,advance:(d.readUInt16LE(p+2)+8)>>4,left:d.readInt16LE(p+4),top:d.readInt16LE(p+6),offset};
 }
 measure(px,text){const face=this.face(px);let width=0,line=0;for(const c of text){if(c==='\n'){width=Math.max(width,line);line=0;}else line+=this.glyph(face,c.codePointAt(0)).advance;}return Math.max(width,line);}
 draw(context,px,text,x,y,color){const face=this.face(px),origin=x;for(const c of text){if(c==='\n'){x=origin;y+=face.line_h;continue;}const cp=c.codePointAt(0),g=this.glyph(face,cp);if(g.w&&g.h){
   const key=`${face.px}:${cp}:${color&65535}`;let bitmap=this.bitmaps.get(key);
   if(!bitmap){bitmap=createCanvas(g.w,g.h);const ctx=bitmap.getContext('2d'),image=ctx.createImageData(g.w,g.h),r=Math.round(((color>>11)&31)*255/31),green=Math.round(((color>>5)&63)*255/63),b=Math.round((color&31)*255/31),mask=(1<<face.bpp)-1;
    for(let i=0;i<g.w*g.h;i++){const v=(face.data[g.offset+Math.floor(i*face.bpp/8)]>>(8-face.bpp-(i*face.bpp)%8))&mask;image.data.set([r,green,b,v*255/mask],i*4);}ctx.putImageData(image,0,0);
    if(this.bitmaps.size>=512)this.bitmaps.delete(this.bitmaps.keys().next().value);this.bitmaps.set(key,bitmap);
   }context.drawImage(bitmap,x+g.left,y-g.top-1);
  }x+=g.advance;}}
}
module.exports={FirmwareFonts};
