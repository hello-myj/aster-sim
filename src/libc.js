'use strict';
module.exports = {
  libcImports() {
    const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
    const format = (p, va) => {
      const fmt = this.cstring(p); let cursor = va >>> 0;
      return fmt.replace(/%([-+ 0#]*)(\d*)(?:\.(\d+))?(?:ll|l|z)?([diuxXscp%])/g, (_, flags, width, precision, type) => {
        if (type === '%') return '%'; const v = this.u32(cursor); cursor += 4;
        let text = type === 's' ? (v ? this.cstring(v) : '(null)') : type === 'c' ? String.fromCharCode(v) : type === 'd' || type === 'i' ? String(v | 0) : type === 'x' || type === 'X' || type === 'p' ? v.toString(16) : String(v);
        if (type === 'X') text = text.toUpperCase(); if (type === 's' && precision) text = text.slice(0, Number(precision));
        return flags.includes('-') ? text.padEnd(Math.min(Number(width), 4096), ' ') : text.padStart(Math.min(Number(width), 4096), flags.includes('0') ? '0' : ' ');
      });
    };
    const snprintf = (dst, cap, fmt, args) => { const s = Buffer.from(format(fmt, args)); if (cap) { const n = Math.min(s.length, cap - 1); this.bytes(dst, cap).set(s.subarray(0, n)); this.buffer()[dst + n] = 0; } return s.length; };
    const strdup = p => { const b = Buffer.from(this.cstring(p) + '\0'), ptr = this.alloc(b.length); if (ptr) this.bytes(ptr, b.length).set(b); return ptr; };
    const a = {
      malloc: n => this.alloc(n), free: p => this.free(p),
      calloc: (n, size) => { if (n * size > this.maxLinear || n < 0 || size < 0) return 0; const p = this.alloc(n * size); if (p) this.bytes(p, n * size).fill(0); return p; },
      realloc: (p, n) => { if (!n) { this.free(p); return 0; } const out = this.alloc(n); if (out && p) { this.bytes(out, Math.min(n, this.allocations.get(p) || 0)).set(this.bytes(p, Math.min(n, this.allocations.get(p) || 0))); this.free(p); } return out; },
      memcpy: (d, s, n) => { const b = Buffer.from(this.bytes(s, n)); this.bytes(d, n).set(b); return d; },
      memmove: (d, s, n) => { const b = Buffer.from(this.bytes(s, n)); this.bytes(d, n).set(b); return d; },
      memset: (d, v, n) => { this.bytes(d, n).fill(v & 255); return d; },
      memcmp: (a, b, n) => Buffer.compare(this.bytes(a, n), this.bytes(b, n)),
      memchr: (p, c, n) => { const at = this.bytes(p, n).indexOf(c & 255); return at < 0 ? 0 : p + at; },
      strlen: p => Buffer.byteLength(this.cstring(p)),
      strcmp: (a, b) => compare(this.cstring(a), this.cstring(b)),
      strncmp: (a, b, n) => compare(this.bytes(a, n).toString().split('\0')[0], this.bytes(b, n).toString().split('\0')[0]),
      strncasecmp: (a, b, n) => compare(this.cstring(a).slice(0, n).toLowerCase(), this.cstring(b).slice(0, n).toLowerCase()),
      strcpy: (d, s) => { const b = Buffer.from(this.cstring(s) + '\0'); this.bytes(d, b.length).set(b); return d; },
      strncpy: (d, s, n) => { const b = Buffer.from(this.cstring(s)); const out = this.bytes(d, n); out.fill(0); out.set(b.subarray(0, n)); return d; },
      strchr: (p, c) => { const s = Buffer.from(this.cstring(p) + '\0'); const i = s.indexOf(c & 255); return i < 0 ? 0 : p + i; },
      strstr: (p, q) => { const i = Buffer.from(this.cstring(p)).indexOf(Buffer.from(this.cstring(q))); return i < 0 ? 0 : p + i; },
      strspn: (p, q) => { const s = this.cstring(p), set = this.cstring(q); let i = 0; while (i < s.length && set.includes(s[i])) i++; return i; },
      strcspn: (p, q) => { const s = this.cstring(p), set = this.cstring(q); let i = 0; while (i < s.length && !set.includes(s[i])) i++; return i; },
      strdup, _strdup: strdup,
      atoi: p => parseInt(this.cstring(p), 10) || 0,
      tolower: c => c >= 65 && c <= 90 ? c + 32 : c,
      toupper: c => c >= 97 && c <= 122 ? c - 32 : c,
      puts: p => { this.log(1, this.cstring(p)); return 0; },
      putchar: c => { this.log(1, String.fromCharCode(c)); return c; },
      printf: (p, args) => { const s = format(p, args); this.log(1, s); return Buffer.byteLength(s); },
      snprintf, vsnprintf: snprintf,
      sprintf: (p, fmt, args) => snprintf(p, this.memory.buffer.byteLength - p, fmt, args),
      clock: () => this.now() * 1000,
      exit: code => { this.exitCode = code; },
      abort: () => { throw new WebAssembly.RuntimeError('APP abort'); },
      abortStackOverflow: () => { throw new WebAssembly.RuntimeError('APP stack overflow'); },
    };
    a.vprintf = a.printf; a.vsprintf = a.sprintf; a.emscripten_memcpy_big = a.memcpy;
    const classifications = { isdigit: /[0-9]/, isalpha: /[a-z]/i, isalnum: /[a-z0-9]/i, isspace: /[\t\n\v\f\r ]/, isupper: /[A-Z]/, isxdigit: /[a-f0-9]/i, isgraph: /[!-~]/, isprint: /[ -~]/ };
    for (const [key, re] of Object.entries(classifications)) a[key] = c => c >= 0 && c <= 127 && re.test(String.fromCharCode(c)) ? 1 : 0;
    return a;
  },
};
