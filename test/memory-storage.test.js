'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Host } = require('../src/host');
const { MemoryFS } = require('../src/memory-fs');
const { loadPackage } = require('../src/package');
function setup(memoryStorage, id = 'memory.app') {
  const h = new Host({ manifest: { id, permissions: ['fs','kv','sd'] }, assets: new Map() }, { memoryStorage });
  h.memory = new WebAssembly.Memory({ initial: 4 }); h.heap = 16384;
  const api = h.imports(), out = h.alloc(4), dst = h.alloc(32);
  const str = s => { const b = Buffer.from(s), p = h.alloc(b.length); h.bytes(p,b.length).set(b); return [p,b.length]; };
  return {h,api,out,dst,str};
}
test('default virtual filesystem performs no host writes and supports file lifecycle', () => {
  const old = fs.mkdirSync; fs.mkdirSync = () => { throw Error('Unexpected disk write'); };
  let s; try { s = setup(); } finally { fs.mkdirSync = old; }
  const {h,api,out,dst,str} = s;
  assert.ok(h.storageFs instanceof MemoryFS);
  assert.equal(api.aster_fs_open(...str('/data/missing/file'),0x12,out),-6);
  assert.equal(api.aster_fs_mkdir(...str('/data/nested')),0);
  assert.equal(api.aster_fs_mkdir(...str('/data/nested')), -9);
  const name = str('/data/nested/file');
  assert.equal(api.aster_fs_open(...name,0x33,out),0); const fd = h.u32(out);
  assert.equal(api.aster_fs_write(fd,...str('abc')),3);
  assert.equal(api.aster_fs_seek(fd,5,0),0);
  assert.equal(api.aster_fs_write(fd,...str('z')),1);
  assert.equal(api.aster_fs_seek(fd,0,0),0);
  assert.equal(api.aster_fs_read(fd,dst,32),6);
  assert.deepEqual(h.bytes(dst,6),Buffer.from([97,98,99,0,0,122]));
  assert.equal(api.aster_fs_open(...name,0x42,out),0); const append = h.u32(out);
  assert.equal(api.aster_fs_write(append,...str('!')),1);
  assert.equal(api.aster_fs_seek(fd,-1,2),0);
  assert.equal(api.aster_fs_read(fd,dst,32),1); assert.equal(h.string(dst,1),'!');
  assert.equal(api.aster_fs_opendir(...str('/data/nested'),out),0);
  const dir = h.u32(out), isdir = h.alloc(4);
  assert.equal(api.aster_fs_dir_next(dir,dst,32,isdir),4);
  assert.equal(h.string(dst,4),'file'); assert.equal(h.u32(isdir),0);
  assert.equal(api.aster_fs_unlink(...name),0);
  assert.equal(api.aster_fs_open(...name,1,out),-6);
  // Unlink keeps an already open file usable, as on the device filesystem.
  assert.equal(api.aster_fs_seek(fd,0,0),0); assert.equal(api.aster_fs_read(fd,dst,32),7);
  assert.equal(api.aster_fs_open(...str('/data/../escape'),1,out),-4);
  assert.equal(api.aster_fs_open(...str('/music/write'),0x12,out),-4);
  assert.equal(api.aster_fs_open(...str('/cache/test'),0x12,out),0);
  assert.equal(api.aster_fs_open(...str('/sd/test'),0x12,out),0);
  h.stop();
});
test('session memory survives reload, isolates APP data, shares SD, and fresh sessions reset', () => {
  const memory = new MemoryFS(), first = setup(memory);
  assert.equal(first.api.aster_kv_set(...first.str('best'),...first.str('2048')),0);
  assert.equal(first.api.aster_fs_open(...first.str('/sd/shared'),0x12,first.out),0);
  first.h.stop();
  const reload = setup(memory);
  assert.equal(reload.api.aster_kv_get(...reload.str('best'),reload.dst,32),4);
  assert.equal(reload.h.string(reload.dst,4),'2048');
  const other = setup(memory,'other.app');
  assert.equal(other.api.aster_kv_get(...other.str('best'),other.dst,32),-6);
  assert.equal(other.api.aster_fs_open(...other.str('/sd/shared'),1,other.out),0);
  const fresh = setup();
  assert.equal(fresh.api.aster_kv_get(...fresh.str('best'),fresh.dst,32),-6);
  for (const s of [reload,other,fresh]) s.h.stop();
});
test('external SDK 2048 renders using only memory storage', { skip: !process.env.ASTER_SIM_2048_AST }, () => {
  const old = fs.mkdirSync; fs.mkdirSync = () => { throw Error('Unexpected disk write'); };
  let h;
  try {
    h = new Host(loadPackage(process.env.ASTER_SIM_2048_AST)).start();
    for(let i=0;i<3;i++) h.tick();
    assert.ok(h.presentCount > 0);
    assert.ok(h.storageFs instanceof MemoryFS);
  } finally { h?.stop(); fs.mkdirSync = old; }
});
