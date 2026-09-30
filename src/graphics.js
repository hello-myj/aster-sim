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
const snap = px => Math.abs(px - 16) < Math.abs(px - 20) ? 16 : 20;
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
  pixels.data.set(decoded.data); context.putImageData(pixels, 0, 0);
  const scale = Math.min(1, cw ? cw / image.width : 1, ch ? ch / image.height : 1);
  const canvas = createCanvas(Math.max(1, Math.floor(image.width * scale)), Math.max(1, Math.floor(image.height * scale)));
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
function execGraphics(host, s, ptr, n, arena, arenaLen, px, py, pw, ph) {
  if (n > 4096 || !host.range(ptr, n * 24) || !host.range(arena, arenaLen)) return -1;
  host.syncIn(s);
  const c = s.canvas.getContext('2d');
  for (let i = 0; i < n; i++) {
    const w = Array.from({ length: 6 }, (_, j) => host.u32(ptr + i * 24 + j * 4));
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
        if (w[3] + w[4] > arenaLen) return -1;
        textFont(c, a); const text = host.string(arena + w[3], w[4]);
        if (w[5] & 65536) { c.fillStyle = color(w[5]); c.fillRect(x, y - (snap(a) === 20 ? 21 : 17), c.measureText(text).width, snap(a) === 20 ? 26 : 21); }
        c.fillStyle = color(b); c.fillText(text, x, y); break;
      }
      case 9: case 10: case 11: case 12: {
        const image = host.handles.get(w[2]); if (!image || image.kind !== 'bitmap') return -10;
        const scale = [10, 12].includes(op) ? (w[4] & 4095) / 256 : 1;
        c.globalAlpha = [11, 12].includes(op) ? Math.min(255, op === 12 ? w[5] : w[4]) / 255 : 1;
        c.drawImage(image.canvas, x, y, image.canvas.width * scale, image.canvas.height * scale); c.globalAlpha = 1; break;
      }
      default: return -3;
    }
  }
  host.syncOut(s);
  if (pw && ph) host.present(s);
  return n;
}
module.exports = { createCanvas, textFont, decodeImage, to565, from565, execGraphics };
