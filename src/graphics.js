'use strict';
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');
const bmp = require('bmp-js');
const fs = require('node:fs');
for (const f of ['C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/segoeui.ttf']) {
  if (fs.existsSync(f)) GlobalFonts.registerFromPath(f);
}
const rgb = c => [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31].map(Math.round);
const color = c => `rgb(${rgb(c).join(',')})`;
const lo = v => v << 16 >> 16, hi = v => v >> 16;
const fontFaces = require('./sdk-compat.json').fontFaces;
function fontFace(px) {
  if (px === 0) return fontFaces[0];
  let selected = fontFaces[0], best = Infinity;
  for (const face of fontFaces) {
    const distance = Math.abs(px - face.px);
    if (distance < best) { selected = face; best = distance; }
  }
  return selected;
}
const snap = px => fontFace(px).px;
function textFont(c, px) { c.font = `${snap(px)}px "Microsoft YaHei", "Segoe UI", sans-serif`; c.textBaseline = 'alphabetic'; }
function decodeImage(bytes, cw, ch) {
  let decoded;
  const dimensions = (w, h) => { if (w <= 0 || h <= 0 || w > 4096 || h > 4096) throw Error('Image dimensions exceed simulator limit (4096x4096)'); };
  if (bytes.length > 16 * 1024 * 1024) throw Error('Image file exceeds 16 MiB');
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    dimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20)); decoded = PNG.sync.read(bytes);
  } else if (bytes.length >= 2 && bytes[0] === 255 && bytes[1] === 216) {
    decoded = jpeg.decode(bytes, { useTArray: true, maxResolutionInMP: 16, maxMemoryUsageInMB: 128, tolerantDecoding: false });
  } else if (bytes.length >= 54 && bytes.toString('ascii', 0, 2) === 'BM') {
    dimensions(bytes.readInt32LE(18), Math.abs(bytes.readInt32LE(22))); decoded = bmp.decode(bytes);
    const rgba = Buffer.alloc(decoded.width * decoded.height * 4);
    for (let i = 0; i < rgba.length; i += 4) { rgba[i] = decoded.data[i + 3]; rgba[i + 1] = decoded.data[i + 2]; rgba[i + 2] = decoded.data[i + 1]; rgba[i + 3] = 255; }
    decoded.data = rgba;
  } else throw Error('Unsupported image (expected BMP/PNG/JPEG)');
  dimensions(decoded.width, decoded.height);
  const image = createCanvas(decoded.width, decoded.height), context = image.getContext('2d'), pixels = context.createImageData(decoded.width, decoded.height);
  pixels.data.set(decoded.data);
  // Device PNG decode composites independent alpha onto black before RGB565.
  for(let i=0;i<pixels.data.length;i+=4) {
    const alpha=pixels.data[i+3];
    for(let channel=0;channel<3;channel++) pixels.data[i+channel]=Math.floor(pixels.data[i+channel]*alpha/255);
    pixels.data[i+3]=255;
  }
  context.putImageData(pixels, 0, 0);
  const scale = Math.min(1, cw ? cw / image.width : 1, ch ? ch / image.height : 1);
  const canvas = createCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return { canvas, width: image.width, height: image.height };
}
function to565(canvas) {
  const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  const b = Buffer.alloc(canvas.width * canvas.height * 2);
  for (let i = 0; i < d.length; i += 4) b.writeUInt16LE(((d[i] >> 3) << 11) | ((d[i + 1] >> 2) << 5) | (d[i + 2] >> 3), i / 2);
  return b;
}
function from565(canvas, b) {
  const c = canvas.getContext('2d'), img = c.createImageData(canvas.width, canvas.height);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data.set(rgb(b.readUInt16LE(i / 2)), i); img.data[i + 3] = 255;
  }
  c.putImageData(img, 0, 0);
}
// Match the firmware's native RGB565 coverage and exact nearest sampling.
function blend565(destination, foreground, alpha) {
  const channel = (shift, mask) => Math.floor((((destination >>> shift) & mask) * (255-alpha)
    + ((foreground >>> shift) & mask) * alpha + 127) / 255);
  return (channel(11,31)<<11) | (channel(5,63)<<5) | channel(0,31);
}
function drawBitmap565(context, image, x, y, scale, alpha, clip) {
  const sw=image.canvas.width, sh=image.canvas.height;
  const width=Math.floor(sw*scale/256), height=Math.floor(sh*scale/256);
  if(scale<8 || !alpha || !width || !height) return;
  alpha=Math.min(255,alpha);
  const [cx,cy,cw,ch]=clip;
  const x0=Math.max(x,cx,0), y0=Math.max(y,cy,0);
  const x1=Math.min(x+width,cx+cw), y1=Math.min(y+height,cy+ch);
  if(x0>=x1 || y0>=y1) return;
  const source=image.pixels565 || (image.pixels565=to565(image.canvas));
  const patch=context.getImageData(x0,y0,x1-x0,y1-y0), pixels=patch.data;
  for(let ty=y0;ty<y1;ty++) for(let tx=x0;tx<x1;tx++) {
    const sy=Math.floor((ty-y)*sh/height), sx=Math.floor((tx-x)*sw/width);
    const foreground=source.readUInt16LE((sy*sw+sx)*2);
    if(!foreground) continue; // Existing 0x0000 key, no independent image alpha.
    const offset=((ty-y0)*(x1-x0)+tx-x0)*4;
    const destination=((pixels[offset]>>3)<<11)|((pixels[offset+1]>>2)<<5)|(pixels[offset+2]>>3);
    const result=alpha===255?foreground:blend565(destination,foreground,alpha);
    pixels.set(rgb(result),offset);pixels[offset+3]=255;
  }
  // putImageData ignores Canvas clips, so the patch is explicitly intersected above.
  context.putImageData(patch,x0,y0);
}
const FRAME_MAGIC=0x47465231, FRAME_TIMEOUT=1000;
function frameFail(host, error) {
 if(host.gfxFrame && !host.gfxFrame.error) host.gfxFrame.error=error;
 return host.gfxFrame ? host.gfxFrame.error : error;
}
function frameControl(host,s,arena,len) {
 if(!arena||(arena&3)||![24,32].includes(len)||!host.range(arena,len)) return -1;
 if(len===32) {
  const v=Array.from({length:8},(_,i)=>host.u32(arena+i*4));
  if(v[0]!==32||v[1]!==1||v[2]!==4) return -1;
  const f=host.gfxFrame;if(!f) return -12;
  if(f.error) return f.error;
  if(host.now()>=f.deadline) return frameFail(host,-8);
  if(f.s!==s||f.id!==v[3]) return frameFail(host,-12);
  const [,,,,x,y,w,h]=v;
  if(!w||!h||x>s.w||w>s.w-x||y>s.h||h>s.h-y) return frameFail(host,-1);
  if(!f.initialized&&(x||y||w!==s.w||h!==s.h)) return frameFail(host,-12);
  f.clip=[x,y,w,h];return 0;
 }
 const v=Array.from({length:6},(_,i)=>host.u32(arena+i*4));
 if(v[0]!==24||v[1]!==1||v[4]||v[5]) return -1;
 const [,,action,id]=v;
 if(action===0) {if(id)return -1;host.u32(arena+16,7);host.u32(arena+12,host.fontEpoch||0);return 0;}
 if(action===1) {
  if(id) return -1;
  if(host.gfxFrame||host.paused) return -5;
  if(s.w*s.h>153600) return -1;
  if((host.gfxFrameSequence||0)===0xffffffff) return -11;
  host.syncIn(s);
  const draft={...s,ptr:0,canvas:createCanvas(s.w,s.h)};
  if(!(s.flags&1)) draft.canvas.getContext('2d').drawImage(s.canvas,0,0);
  host.gfxFrame={s,draft,id:host.gfxFrameSequence=(host.gfxFrameSequence||0)+1,
   clip:[0,0,s.w,s.h],deadline:host.now()+FRAME_TIMEOUT,error:0,batches:0,commands:0,arena:0,initialized:!(s.flags&1)};
  host.u32(arena+12,host.gfxFrame.id);return 0;
 }
 const f=host.gfxFrame;
 if(!f||f.s!==s||f.id!==id) return -12;
 if(action===3) {host.gfxFrame=null;return 0;}
 if(action!==2) return -1;
 let error=f.error;
 if(!error && host.now()>=f.deadline) error=-8;
 if(!error && !f.initialized) error=-12;
 if(!error && host.paused) error=-5;
 host.gfxFrame=null;
 if(error) {host.u32(arena+20,error);return error;}
 s.canvas=f.draft.canvas;host.syncOut(s);return host.present(s);
}
function execGraphics(host, s, ptr, n, arena, arenaLen, px, py, pw, ph) {
 n=n>>>0;
 if(n===0xffffffff && !ptr && (px>>>0)===FRAME_MAGIC && py===1 && !pw && !ph) return frameControl(host,s,arena,arenaLen);
 const f=host.gfxFrame;
 const batch=(py>>>0)===FRAME_MAGIC && !pw && !ph;
 if(batch&&!f) return -12;
 if(batch && n && (ptr&3)) return frameFail(host,-1);
 if(f) {
  if(!batch||(px>>>0)!==f.id) return frameFail(host,-12);
  if(host.now()>=f.deadline) frameFail(host,-8);
  if(f.s!==s) return frameFail(host,-5);
  if(f.error) return f.error;
 }

  if (n > 4096 || !host.range(ptr, n * 24) || !host.range(arena, arenaLen)) return frameFail(host,-1);
  if ((!!pw !== !!ph) || (pw && (px < 0 || py < 0 || pw < 0 || ph < 0 || px > s.w || pw > s.w - px || py > s.h || ph > s.h - py))) return frameFail(host,-1);
  const commands = Array.from({ length: n }, (_, i) => Array.from({ length: 6 }, (_, j) => host.u32(ptr + i * 24 + j * 4)));
  for (const w of commands) {
    const op = w[0] & 255;
    if (op >= 9 && op <= 12 && (!host.handles.get(w[2]) || host.handles.get(w[2]).kind !== 'bitmap')) return frameFail(host,-10);
  }
  if(f) {
    if(f.batches>=256||n>8192-f.commands||arenaLen>131072-f.arena) return frameFail(host,-11);
    if(!f.initialized && (!commands.length||(commands[0][0]&255)!==0)) return frameFail(host,-12);
    for(const w of commands) {
      const op=w[0]&255;
      if(op>12||op===8) return frameFail(host,-3);
      if(op===7 && (w[3]>arenaLen || (w[4]&65535)>arenaLen-w[3])) return frameFail(host,-1);
    }
    f.batches++;f.commands+=n;f.arena+=arenaLen;f.initialized=true;s=f.draft;
  }
  if(!f) host.syncIn(s);
  const c = s.canvas.getContext('2d');
  if(f) [px,py,pw,ph]=f.clip;
  const clipped = !!f || (pw && ph && !(s.flags & 1) && !commands.some(w => (w[0] & 255) === 0));
  if (clipped) { c.save(); c.beginPath(); c.rect(px, py, pw, ph); c.clip(); }
  try {
  for (let i = 0; i < n; i++) {
    const w = commands[i];
    const op = w[0] & 255, x = lo(w[1]), y = hi(w[1]), a = w[2] & 65535, b = w[2] >>> 16;
    c.fillStyle = c.strokeStyle = color(w[3] & 65535); c.lineWidth = 1;
    switch (op) {
      case 0: c.fillStyle = color(w[1]); c.fillRect(0, 0, s.w, s.h); break;
      case 1: c.fillRect(x, y, a, b); break;
      case 2: {
        if (!a || !b) break;
        const radius = Math.min(w[4] & 65535, a / 2, b / 2);
        c.beginPath(); c.roundRect(x, y, a, b, radius);
        if (w[4] >>> 16) c.stroke(); else c.fill(); break;
      }
      case 3: c.beginPath(); c.moveTo(x, y); c.lineTo(lo(w[2]), hi(w[2])); c.stroke(); break;
      case 4: c.beginPath(); c.ellipse(x, y, a, b, 0, 0, Math.PI * 2); if (w[3] >>> 16) c.stroke(); else c.fill(); break;
      case 5: c.fillStyle = color(w[4]); c.beginPath(); c.moveTo(x, y); c.lineTo(lo(w[2]), hi(w[2])); c.lineTo(lo(w[3]), hi(w[3])); c.closePath(); c.fill(); break;
      case 6: {
        const g = c.createLinearGradient(x, y, w[5] ? x + a : x, w[5] ? y : y + b);
        g.addColorStop(0, color(w[3])); g.addColorStop(1, color(w[4])); c.fillStyle = g; c.fillRect(x, y, a, b); break;
      }
      case 7: {
        if (w[3] + w[4] > arenaLen) return frameFail(host,-1);
        textFont(c, a); const text = host.string(arena + w[3], w[4]&65535);
        if (w[5] & 65536) { c.fillStyle = color(w[5]); const face = fontFace(a); c.fillRect(x, y - face.asc, c.measureText(text).width, face.line_h); }
        c.fillStyle = color(b); c.fillText(text, x, y); break;
      }
      case 9: case 10: case 11: case 12: {
        const image = host.handles.get(w[2]); if (!image || image.kind !== 'bitmap') return frameFail(host,-10);
        const scale = [10, 12].includes(op) ? (w[4] & 4095) : 256;
        const alpha = [11, 12].includes(op) ? ((op === 12 ? w[5] : w[4]) & 511) : 255;
        drawBitmap565(c,image,x,y,scale,alpha,clipped?[px,py,pw,ph]:[0,0,s.w,s.h]);
        break;
        const smoothing = c.imageSmoothingEnabled; c.imageSmoothingEnabled = false;
        c.globalAlpha = Math.min(255, alpha) / 255;
        c.drawImage(image.canvas, x, y, width, height);
        c.globalAlpha = 1; c.imageSmoothingEnabled = smoothing; break;
      }
      default: return -3;
    }
  }
  } finally { if (clipped) c.restore(); }
  if(!f) {host.syncOut(s);
  if (pw && ph) host.present(s);}
  return n;
}
module.exports = { createCanvas, fontFace, snap, textFont, decodeImage, to565, from565, execGraphics, blend565, drawBitmap565 };
