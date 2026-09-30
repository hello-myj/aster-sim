'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function validRelative(p) {
  return typeof p === 'string' && p.length > 0 && !p.includes('\\') &&
    !p.includes(':') && !p.includes('\0') && !p.startsWith('/') &&
    p.split('/').every(x => x && x !== '.' && x !== '..' && !/[. ]$/.test(x) && !/[<>"|?*\x00-\x1f]/.test(x) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(x));
}
function checkManifest(m) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(m.id) || m.id.includes('..')) throw Error('Invalid APP ID');
  const abi = String(m.abi?.min || m.abi?.target || '3.6').split('.').map(Number);
  if (abi[0] !== 3 || abi[1] > 6) throw Error('Requires unsupported ABI; host is 3.6');
  if (m.orientation && !['portrait', 'landscape'].includes(m.orientation)) throw Error('Invalid orientation');
  return m;
}
function loadPackage(file, options = {}) {
  file = path.resolve(file);
  if (fs.statSync(file).isDirectory()) {
    if (fs.existsSync(path.join(file, 'app.toml'))) throw Error('Build project with aster build --no-aot first; pass its .ast or build directory');
    file = path.join(file, 'app.wasm');
  }
  const b = fs.readFileSync(file);
  let manifest, wasm, assets = new Map(), hasAot = false;
  if (b.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))) {
    const mf = options.manifest || path.join(path.dirname(file), 'manifest.json');
    manifest = fs.existsSync(mf) ? JSON.parse(fs.readFileSync(mf, 'utf8')) :
      { id: 'local.wasm', name: path.basename(file), abi: { min: '3.6' }, permissions: [] };
    wasm = b;
  } else {
    if (b.length < 64 || b.toString('ascii', 0, 4) !== 'ASTP' || b.readUInt16LE(4) !== 1) throw Error('Expected .ast (ASTP v1) or .wasm; AOT-only modules cannot run on Windows');
    const hs = b.readUInt16LE(6), flags = b.readUInt32LE(8);
    if (![64, 72].includes(hs) || b.length < hs || (flags & ~5) || b.readBigUInt64LE(56)) throw Error('Invalid package header');
    const limit = b.length - ((flags & 1) ? 64 : 0), sections = [];
    const section = (at, required = false) => {
      const off = b.readUInt32LE(at), len = b.readUInt32LE(at + 4);
      if (!len && !required) return Buffer.alloc(0);
      if (!len || off < hs || off + len > limit || (off % 4)) throw Error('Package section outside bounds');
      if (sections.some(([o, l]) => off < o + l && o < off + len)) throw Error('Overlapping package sections');
      sections.push([off, len]); return b.subarray(off, off + len);
    };
    manifest = JSON.parse(section(12, true).toString('utf8'));
    wasm = section(20, true); hasAot = section(28).length > 0; section(40);
    if (flags & 1) {
      if (!options.pubkey) throw Error('Signed package requires --pubkey PEM (or run the verified raw .wasm)');
      if (!crypto.verify(null, b.subarray(0, limit), fs.readFileSync(options.pubkey), b.subarray(limit))) throw Error('Invalid package signature');
    }
    if (hs === 72) {
      const a = section(64);
      if (!!a.length !== !!(flags & 4)) throw Error('Assets flag mismatch');
      if (a.length) {
        if (a.length < 16 || a.toString('ascii', 0, 4) !== 'ASTR' || a.readUInt16LE(4) !== 1) throw Error('Invalid assets');
        const n = a.readUInt16LE(6), end = 16 + n * 12;
        if (n > 64 || end > a.length) throw Error('Invalid asset table');
        for (let i = 0; i < n; i++) {
          const p = a.readUInt32LE(16 + i * 12), d = a.readUInt32LE(20 + i * 12), l = a.readUInt32LE(24 + i * 12), z = a.indexOf(0, p);
          if (p < end || z < p || z - p >= 96 || d < end || d + l > a.length) throw Error('Invalid asset bounds');
          const name = a.toString('utf8', p, z);
          if (!validRelative(name) || assets.has(name)) throw Error('Invalid/duplicate asset path');
          assets.set(name, Buffer.from(a.subarray(d, d + l)));
        }
      }
    }
    if (manifest.wasm_sha256 && crypto.createHash('sha256').update(wasm).digest('hex') !== manifest.wasm_sha256) throw Error('WASM hash mismatch');
  }
  checkManifest(manifest);
  if (wasm.length < 8 || !wasm.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))) throw Error('No portable WASM payload');
  return { file, manifest, wasm, assets, hasAot };
}
module.exports = { loadPackage, validRelative };
