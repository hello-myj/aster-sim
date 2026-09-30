'use strict';
const fs = require('node:fs');
const path = require('node:path');
module.exports = {
  storageImports() {
    const fs = this.storageFs;
    const assetEntries = rel => {
      const prefix = rel ? rel + '/' : '', result = new Map();
      for (const name of this.pkg.assets.keys()) if (name.startsWith(prefix)) { const parts = name.slice(prefix.length).split('/'); result.set(parts[0], parts.length > 1); }
      return [...result].map(([name, dir]) => ({ name, dir }));
    };
    const keyPath = (p, n) => { this.permission('kv'); const k = this.string(p, n); if (!n || n > 63 || !/^[\x20-\x7e]+$/.test(k)) throw Object.assign(Error('Invalid KV key'), { code: 'EINVAL' }); return path.join(this.root, 'kv', Buffer.from(k).toString('hex')); };
    return {
      aster_fs_open: (p, n, flags, out) => {
        const mode = flags & 3; if (![1, 2, 3].includes(mode) || (flags & ~0x73) || (mode === 1 && flags & 0x70)) return -1;
        this.bytes(out, 4); const v = this.virtual(p, n, mode !== 1);
        let value;
        if (v.area === 'assets') { const data = this.pkg.assets.get(v.rel); if (!data) return -6; value = { data, position: 0, mode }; }
        else {
          let f = mode === 1 ? fs.constants.O_RDONLY : mode === 2 ? fs.constants.O_WRONLY : fs.constants.O_RDWR;
          if (flags & 16) f |= fs.constants.O_CREAT;
          if (flags & 32) f |= fs.constants.O_TRUNC;
          if (flags & 64) f |= fs.constants.O_APPEND;
          const fd = fs.openSync(v.path, f); value = { fd, mode, append: !!(flags & 64), position: flags & 64 ? fs.fstatSync(fd).size : 0 };
        }
        this.u32(out, this.add('file', value, 0x04000000)); return 0;
      },
      aster_fs_read: (h, p, n) => {
        this.permission('fs'); const f = this.get(h, 'file'); if (f.mode === 2) return -4;
        const b = this.bytes(p, n); const count = f.data ? f.data.copy(b, 0, Math.min(f.position, f.data.length), Math.min(f.position + n, f.data.length)) : fs.readSync(f.fd, b, 0, n, f.position);
        f.position += count; return count;
      },
      aster_fs_write: (h, p, n) => {
        this.permission('fs'); const f = this.get(h, 'file'); if (f.mode === 1 || f.data) return -4;
        const count = fs.writeSync(f.fd, this.bytes(p, n), 0, n, f.append ? null : f.position);
        f.position = f.append ? fs.fstatSync(f.fd).size : f.position + count; return count;
      },
      aster_fs_seek: (h, offset, whence) => {
        this.permission('fs'); const f = this.get(h, 'file'); if (whence > 2 || whence < 0) return -1;
        const base = whence === 0 ? 0 : whence === 1 ? f.position : f.data ? f.data.length : fs.fstatSync(f.fd).size;
        if (base + offset < 0) return -1; f.position = base + offset; return 0;
      },
      aster_fs_close: h => { this.permission('fs'); const f = this.get(h, 'file'); if (f.fd !== undefined) fs.closeSync(f.fd); this.handles.delete(h); return 0; },
      aster_fs_mkdir: (p, n) => { const v = this.virtual(p, n, true); fs.mkdirSync(v.path); return 0; },
      aster_fs_unlink: (p, n) => { const v = this.virtual(p, n, true); if (!v.rel) return -4; fs.unlinkSync(v.path); return 0; },
      aster_fs_stat: (p, n, out, size) => {
        const v = this.virtual(p, n); if (!this.struct(out, size, 24)) return -1;
        let length, directory;
        if (v.area === 'assets') { const b = this.pkg.assets.get(v.rel); directory = !b && (!v.rel || assetEntries(v.rel).length > 0); if (!b && !directory) return -6; length = b?.length || 0; }
        else { const st = fs.statSync(v.path); length = st.size; directory = st.isDirectory(); }
        this.bytes(out + 8, 8).writeBigUInt64LE(BigInt(length)); this.u32(out + 16, directory ? 1 : 0); return 0;
      },
      aster_fs_opendir: (p, n, out) => {
        const v = this.virtual(p, n); this.bytes(out, 4);
        const entries = v.area === 'assets' ? assetEntries(v.rel) : fs.readdirSync(v.path, { withFileTypes: true }).map(d => ({ name: d.name, dir: d.isDirectory() }));
        if (v.area === 'assets' && v.rel && !entries.length) return -6;
        this.u32(out, this.add('dir', { entries, index: 0 }, 0x07000000)); return 0;
      },
      aster_fs_dir_next: (h, p, n, out) => {
        this.permission('fs'); const d = this.get(h, 'dir'), item = d.entries[d.index]; if (!item) return 0;
        this.bytes(out, 4); const count = this.output(p, item.name, n, true); if (count < 0) return count; this.u32(out, item.dir ? 1 : 0); d.index++; return count;
      },
      aster_fs_closedir: h => { this.permission('fs'); this.get(h, 'dir'); this.handles.delete(h); return 0; },
      aster_kv_set: (p, n, v, len) => { const file = keyPath(p, n), b = Buffer.from(this.bytes(v, len)); if (len > 65536) return -11; fs.writeFileSync(file + '.tmp', b); fs.renameSync(file + '.tmp', file); return 0; },
      aster_kv_get: (p, n, out, cap) => { const b = fs.readFileSync(keyPath(p, n)); if (cap < b.length) return -11; this.bytes(out, b.length).set(b); return b.length; },
      aster_kv_delete: (p, n) => { fs.unlinkSync(keyPath(p, n)); return 0; },
    };
  },
};
