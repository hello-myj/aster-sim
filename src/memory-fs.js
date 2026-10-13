'use strict';
const path = require('node:path');
const { constants } = require('node:fs');
const fail = code => { throw Object.assign(Error(code), { code }); };
// A session-owned filesystem: nodes and open handles never touch host storage.
class MemoryFS {
  constructor(limit = Infinity) { this.limit = limit; this.constants = constants; this.nodes = new Map(); this.fds = new Map(); this.next = 1; }
  usedBytes() { return [...new Set([...this.nodes.values(), ...[...this.fds.values()].map(h=>h.node)])].reduce((n,x)=>n+(x.dir?0:x.data.length),0); }
  reserve(n, bytes) { if(this.usedBytes() + bytes - (n?.data?.length || 0) > this.limit) fail('ENOSPC'); }
  key(p) { return path.resolve(p); }
  node(p) { const n = this.nodes.get(this.key(p)); if (!n) fail('ENOENT'); return n; }
  parent(p) { if (!this.node(path.dirname(this.key(p))).dir) fail('ENOTDIR'); }
  existsSync(p) { return this.nodes.has(this.key(p)); }
  realpathSync(p) { this.node(p); return this.key(p); }
  mkdirSync(p, options = {}) {
    p = this.key(p);
    if (this.nodes.has(p)) { if (!this.node(p).dir) fail('ENOTDIR'); if (!options.recursive) fail('EEXIST'); return; }
    if (options.recursive) { const parent = path.dirname(p); if (parent !== p && !this.nodes.has(parent)) this.mkdirSync(parent, options); }
    else this.parent(p);
    this.nodes.set(p, { dir: true });
  }
  stat(n) { return { size: n.dir ? 0 : n.data.length, isDirectory: () => n.dir }; }
  statSync(p) { return this.stat(this.node(p)); }
  fstatSync(fd) { return this.stat(this.handle(fd).node); }
  handle(fd) { const h = this.fds.get(fd); if (!h) fail('EBADF'); return h; }
  openSync(p, flags) {
    p = this.key(p); let n = this.nodes.get(p);
    if (!n) { if (!(flags & constants.O_CREAT)) fail('ENOENT'); this.parent(p); n = { dir: false, data: Buffer.alloc(0) }; this.nodes.set(p, n); }
    if (n.dir) fail('EISDIR');
    if (flags & constants.O_TRUNC) n.data = Buffer.alloc(0);
    const fd = this.next++; this.fds.set(fd, { node: n, flags }); return fd;
  }
  closeSync(fd) { this.handle(fd); this.fds.delete(fd); }
  readSync(fd, b, offset, length, position) {
    const n = this.handle(fd).node;
    return n.data.copy(b, offset, Math.min(position, n.data.length), Math.min(position + length, n.data.length));
  }
  writeSync(fd, b, offset, length, position) {
    const h = this.handle(fd), n = h.node;
    if ((h.flags & 3) === constants.O_RDONLY) fail('EBADF');
    if (position === null || h.flags & constants.O_APPEND) position = n.data.length;
    if (position + length > n.data.length) { this.reserve(n,position+length); const next = Buffer.alloc(position + length); n.data.copy(next); n.data = next; }
    b.copy(n.data, position, offset, offset + length); return length;
  }
  readFileSync(p) { const n = this.node(p); if (n.dir) fail('EISDIR'); return Buffer.from(n.data); }
  writeFileSync(p, data) {
    p = this.key(p); this.parent(p); if (this.nodes.get(p)?.dir) fail('EISDIR');
    const n = this.nodes.get(p) || { dir: false }; this.reserve(n,Buffer.byteLength(data)); n.data = Buffer.from(data); this.nodes.set(p, n);
  }
  renameSync(from, to) { const n = this.node(from); this.parent(to); this.nodes.set(this.key(to), n); this.nodes.delete(this.key(from)); }
  unlinkSync(p) { if (this.node(p).dir) fail('EISDIR'); this.nodes.delete(this.key(p)); }
  readdirSync(p) {
    p = this.key(p); if (!this.node(p).dir) fail('ENOTDIR');
    return [...this.nodes].filter(([name]) => name !== p && path.dirname(name) === p).map(([name, n]) => ({ name: path.basename(name), isDirectory: () => n.dir }));
  }
}
module.exports = { MemoryFS };
