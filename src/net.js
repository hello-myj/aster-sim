'use strict';
/* ABI 4.0. Six imports over the existing protocol objects. Public handles
 * carry a generation so a closed id cannot be reused. */
function trap(fn) { try { return fn(); } catch (e) { return e && e.code === 'EINVAL' ? -1 : -7; } }
let handleGeneration = 1;
const PROTO = { TCP: 1, UDP: 2, HTTP: 3, MQTT: 4, WS: 5 };
const OP = { SEND: 1, RECV: 2, HEADER: 3, SUBSCRIBE: 4, UNSUBSCRIBE: 5, OPERATION: 6 };
const OPEN = 40, HTTP_TAIL = 24, MQTT_TAIL = 48, IO = 56, STATUS = 40;
function u32(buf, at, v) { if (v === undefined) return buf.readUInt32LE(at); buf.writeUInt32LE(v >>> 0, at); }
class NetAbi {
  constructor(host) {
    this.host = host; this.slots = [];
    const orig = host.netEvent.bind(host);
    host.netEventRaw = orig;
    host.netEvent = (handle, kind, state) => {
      const pub = this.slots.find(s => s.live && s.proto === kind && s.internal === (handle >>> 0));
      if (pub) orig(pub.handle, kind, state);
    };
  }
  gate() { return this.host.network.gate(); }
  adopt(proto, internal) {
    if (internal <= 0) return internal;
    if (this.slots.filter(s => s.live).length >= 4) { this.rawClose(proto, internal); return -11; }
    this.slots.push({ live: true, handle: internal >>> 0, proto, internal: internal >>> 0 });
    return internal;
  }
  resolve(handle) { return this.slots.find(s => s.live && s.handle === (handle >>> 0)) || null; }
  rawClose(proto, internal) {
    const h = internal >>> 0;
    if (proto === PROTO.TCP || proto === PROTO.UDP) return this.host.network.close(this.host.network.slots.get(h));
    if (proto === PROTO.HTTP) return this.host.http.close(this.host.http.slots.get(h));
    if (proto === PROTO.MQTT) return this.host.mqtt.close(this.host.mqtt.slots.get(h));
    if (proto === PROTO.WS) return this.host.ws.close(this.host.ws.slots.get(h));
    return -3;
  }
  info(off, size) { return trap(() => this.host.network.info(off, size)); }
  open(off, size) {
    if (this.gate()) return this.gate();
    off >>>= 0; size >>>= 0;
    if (size < OPEN || !this.host.range(off, size)) return -1;
    const b = this.host.bytes(off, size);
    const hdr = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => u32(b, i * 4));
    if (hdr[0] !== size || hdr[1] !== 1 || hdr[8] || hdr[9]) return -1;
    const proto = hdr[2], flags = hdr[3], timeout = hdr[4], port = hdr[5], tOff = hdr[6], tLen = hdr[7];
    let internal = -3, expect = OPEN;
    if (proto === PROTO.HTTP) expect += HTTP_TAIL;
    else if (proto === PROTO.MQTT) expect += MQTT_TAIL;
    else if (proto !== PROTO.TCP && proto !== PROTO.UDP && proto !== PROTO.WS) return -3;
    if (size !== expect) return -1;
    if (proto === PROTO.TCP || proto === PROTO.UDP) {
      if (flags) return -1;
      internal = trap(() => this.host.network.open(proto, tOff, tLen, port, timeout));
    } else if (proto === PROTO.WS) {
      if (flags || port) return -1;
      internal = this.host.ws.connect(tOff, tLen, timeout);
    } else if (proto === PROTO.HTTP) {
      if (flags || port) return -1;
      const method = u32(b, 40), limit = u32(b, 44), ho = u32(b, 48), hn = u32(b, 52), bo = u32(b, 56), bn = u32(b, 60);
      internal = this.host.http.request(method, tOff, tLen, ho, hn, bo, bn, timeout, limit);
    } else {
      const opt = Buffer.alloc(80);
      opt.writeUInt32LE(80, 0); opt.writeUInt32LE(1, 4); opt.writeUInt32LE(flags, 8);
      opt.writeUInt32LE(port, 12); opt.writeUInt32LE(timeout, 16);
      opt.writeUInt32LE(u32(b, 40), 20); opt.writeUInt32LE(u32(b, 44), 24);
      opt.writeUInt32LE(tOff, 32); opt.writeUInt32LE(tLen, 36);
      [[40, 10], [48, 12], [56, 14], [64, 16], [72, 18], [80, 8]].forEach(([from, word]) => {
        /* client id starts at byte 48 of the tail, which is open+8; words filled below */
        void from; void word;
      });
      /* tail: keepalive, will_qos, client, user, password, will topic, will payload */
      opt.writeUInt32LE(u32(b, 48), 40); opt.writeUInt32LE(u32(b, 52), 44);
      opt.writeUInt32LE(u32(b, 56), 48); opt.writeUInt32LE(u32(b, 60), 52);
      opt.writeUInt32LE(u32(b, 64), 56); opt.writeUInt32LE(u32(b, 68), 60);
      opt.writeUInt32LE(u32(b, 72), 64); opt.writeUInt32LE(u32(b, 76), 68);
      opt.writeUInt32LE(u32(b, 80), 72); opt.writeUInt32LE(u32(b, 84), 76);
      const at = this.host.memory.buffer.byteLength - 96;
      if (off + size > at) return -1;
      opt.copy(this.host.bytes(at, 80));
      internal = this.host.mqtt.connect(at, 80);
    }
    return this.adopt(proto, internal);
  }
  status(handle, off, size) {
    if (this.gate()) return this.gate();
    const slot = this.resolve(handle); if (!slot) return -10;
    off >>>= 0; size >>>= 0;
    const need = slot.proto === PROTO.WS ? STATUS + 16 : STATUS + 32;
    if (size < need || !this.host.range(off, need)) return -1;
    const scratch = this.host.memory.buffer.byteLength - 160;
    if (off + need > scratch) return -1;
    let rc = 0;
    if (slot.proto === PROTO.TCP || slot.proto === PROTO.UDP) rc = this.host.network.status(slot.internal, scratch, 56);
    else if (slot.proto === PROTO.HTTP) rc = this.host.http.status(slot.internal, scratch, 56);
    else if (slot.proto === PROTO.MQTT) rc = this.host.mqtt.status(slot.internal, scratch, 64);
    else rc = this.host.ws.status(slot.internal, scratch, 48);
    if (rc) return rc;
    const s = this.host.bytes(scratch, 80), out = this.host.bytes(off, need);
    out.fill(0); u32(out, 0, need); u32(out, 4, 1); u32(out, 8, slot.proto);
    if (slot.proto === PROTO.TCP || slot.proto === PROTO.UDP) {
      const state = u32(s, 12);
      u32(out, 12, state >= 6 ? 4 : state >= 4 ? 2 : 1); u32(out, 16, state); u32(out, 20, u32(s, 20));
      u32(out, 28, u32(s, 24)); u32(out, 32, u32(s, 28));
      u32(out, 40, u32(s, 8)); u32(out, 44, u32(s, 16)); u32(out, 48, u32(s, 32)); u32(out, 52, u32(s, 36));
      s.copy(out, 56, 40, 56);
    } else if (slot.proto === PROTO.HTTP) {
      const state = u32(s, 8);
      u32(out, 12, state >= 6 ? 4 : state >= 4 ? 2 : 1); u32(out, 16, state); u32(out, 20, u32(s, 16));
      u32(out, 24, u32(s, 32)); u32(out, 32, u32(s, 24));
      u32(out, 40, u32(s, 12)); u32(out, 44, u32(s, 20)); u32(out, 48, u32(s, 28));
      s.copy(out, 56, 40, 56);
    } else if (slot.proto === PROTO.MQTT) {
      const state = u32(s, 8);
      u32(out, 12, state === 4 ? 2 : state >= 6 ? 4 : 1); u32(out, 16, state); u32(out, 20, u32(s, 12));
      u32(out, 24, u32(s, 52)); u32(out, 28, u32(s, 16)); u32(out, 32, u32(s, 20));
      [u32(s, 16), u32(s, 28), u32(s, 32), u32(s, 36), u32(s, 40), u32(s, 44), u32(s, 48), u32(s, 56)]
        .forEach((v, i) => u32(out, 40 + i * 4, v));
    } else {
      const state = u32(s, 8);
      u32(out, 12, state >= 6 ? 4 : state === 5 ? 3 : state >= 4 ? 2 : 1);
      u32(out, 16, state); u32(out, 20, u32(s, 12)); u32(out, 24, u32(s, 32));
      u32(out, 28, u32(s, 20)); u32(out, 32, u32(s, 16));
      u32(out, 40, u32(s, 24)); u32(out, 44, u32(s, 28)); u32(out, 48, u32(s, 32) ? u32(s, 32) : u32(s, 36) && 0);
      u32(out, 48, u32(s, 36));
    }
    return 0;
  }
  io(handle, op, off, size) {
    if (this.gate()) return this.gate();
    const slot = this.resolve(handle); if (!slot) return -10;
    off >>>= 0; size >>>= 0; op >>>= 0;
    if (size < IO || !this.host.range(off, IO)) return -1;
    const b = Buffer.from(this.host.bytes(off, IO));
    if (u32(b, 0) < IO || u32(b, 4) !== 1) return -1;
    const flags = u32(b, 8), port = u32(b, 12), no = u32(b, 16), nl = u32(b, 20), dOff = u32(b, 24), dLen = u32(b, 28), aux = u32(b, 36);
    const h = slot.internal;
    if (slot.proto === PROTO.TCP || slot.proto === PROTO.UDP) {
      if (op === OP.SEND) return trap(() => this.host.network.send(h, dOff, dLen, no, nl, port));
      if (op !== OP.RECV) return -3;
      const pkt = this.host.memory.buffer.byteLength - 48;
      if (off < pkt + 32 && pkt < off + IO) return -1;
      const rc = trap(() => this.host.network.recv(h, dOff, dLen, pkt, 32));
      const p = this.host.bytes(pkt, 32), io = this.host.bytes(off, IO);
      u32(io, 32, u32(p, 8)); u32(io, 12, u32(p, 12)); p.copy(io, 40, 16, 32);
      return rc;
    }
    if (slot.proto === PROTO.HTTP) {
      if (op === OP.RECV) return this.host.http.read(h, dOff, dLen);
      if (op !== OP.HEADER) return -3;
      return this.host.http.header(h, no, nl, aux, dOff, dLen, off + 32);
    }
    if (slot.proto === PROTO.MQTT) {
      const qos = flags & 3, retain = (flags >> 2) & 1;
      if (op === OP.SEND) return this.host.mqtt.publish(h, no, nl, dOff, dLen, qos, retain);
      if (op === OP.SUBSCRIBE) return this.host.mqtt.subscribe(h, no, nl, qos, false);
      if (op === OP.UNSUBSCRIBE) return this.host.mqtt.subscribe(h, no, nl, 0, true);
      if (op === OP.OPERATION) return this.host.mqtt.operation(h, aux, off + 32);
      if (op !== OP.RECV) return -3;
      if (no < 24) return -1;
      const rc = this.host.mqtt.recv(h, no - 24, 1176);
      if (rc) return rc;
      const m = this.host.bytes(no - 24, 24), io = this.host.bytes(off, IO);
      u32(io, 32, u32(m, 8)); u32(io, 12, u32(m, 12));
      u32(io, 8, (u32(m, 16) & 3) | ((u32(m, 20) & 1) << 2) | ((u32(m, 20) & 2) << 2));
      return 0;
    }
    if (op === OP.SEND) return this.host.ws.send(h, (flags >> 8) & 0xff, dOff, dLen);
    if (op !== OP.RECV) return -3;
    if (dOff < 28) return -1;
    const rc = this.host.ws.recv(h, dOff - 28, 4124);
    if (rc) return rc;
    const m = this.host.bytes(dOff - 28, 16), io = this.host.bytes(off, IO);
    u32(io, 32, u32(m, 12)); u32(io, 8, (u32(io, 8) & 0xff) | ((u32(m, 8) & 0xff) << 8));
    return 0;
  }
  cancel(handle) {
    if (this.gate()) return this.gate();
    const slot = this.resolve(handle); if (!slot) return -10;
    if (slot.proto <= PROTO.UDP) return this.host.network.cancel(slot.internal);
    if (slot.proto === PROTO.HTTP) return this.host.http.imports().aster_http_cancel(slot.internal);
    if (slot.proto === PROTO.MQTT) return this.host.mqtt.cancel(slot.internal);
    return this.host.ws.cancel(slot.internal);
  }
  close(handle) {
    if (this.gate()) return this.gate();
    const slot = this.resolve(handle); if (!slot) return -10;
    const rc = this.rawClose(slot.proto, slot.internal);
    if (!rc) slot.live = false;
    return rc;
  }
  imports() {
    const raw = {
      aster_net_info: (o, n) => this.info(o, n),
      aster_net_open: (o, n) => this.open(o, n),
      aster_net_io: (h, op, o, n) => this.io(h, op, o, n),
      aster_net_status: (h, o, n) => this.status(h, o, n),
      aster_net_cancel: h => this.cancel(h),
      aster_net_close: h => this.close(h),
    };
    return Object.fromEntries(Object.entries(raw).map(([k, fn]) => [k, (...args) => trap(() => fn(...args))]));
  }
}
const LEGACY = 64000;
function legacy(host) {
  const a = host.netabi.imports();
  const put = (extra = 0) => { const n = OPEN + extra; const b = host.bytes(LEGACY, n); b.fill(0); u32(b, 0, n); u32(b, 4, 1); return b; };
  const fns = {
    aster_network_get_info: (p, n) => a.aster_net_info(p, n),
    aster_network_open: (kind, p, n, port, ms) => { const b = put(); u32(b, 8, kind); u32(b, 16, ms); u32(b, 20, port); u32(b, 24, p); u32(b, 28, n); return a.aster_net_open(LEGACY, OPEN); },
    aster_network_send: (h, p, n, hp, hn, port) => { const b = host.bytes(LEGACY, IO); b.fill(0); u32(b, 0, IO); u32(b, 4, 1); u32(b, 12, port); u32(b, 16, hp); u32(b, 20, hn); u32(b, 24, p); u32(b, 28, n); return a.aster_net_io(h, OP.SEND, LEGACY, IO); },
    aster_network_recv: (h, p, cap, out, size) => {
      if ((size >>> 0) < 32 || !host.range(out >>> 0, 32) || (cap && !host.range(p >>> 0, cap >>> 0))) return -1;
      const p0 = p >>> 0, c0 = cap >>> 0, o0 = out >>> 0;
      if (c0 && p0 < o0 + 32 && o0 < p0 + c0) return -1;
      const b = host.bytes(LEGACY, IO); b.fill(0); u32(b, 0, IO); u32(b, 4, 1); u32(b, 24, p); u32(b, 28, cap);
      const rc = a.aster_net_io(h, OP.RECV, LEGACY, IO); const io = host.bytes(LEGACY, IO), pkt = host.bytes(out, 32);
      pkt.fill(0); u32(pkt, 0, 32); u32(pkt, 4, 1); u32(pkt, 8, u32(io, 32)); u32(pkt, 12, u32(io, 12)); io.copy(pkt, 16, 40, 56); return rc;
    },
    aster_network_status: (h, p, size) => {
      if ((size >>> 0) < 56) return -1;
      const rc = a.aster_net_status(h, LEGACY, 72); if (rc) return rc;
      const s = host.bytes(LEGACY, 72), o = host.bytes(p, 56); o.fill(0);
      u32(o, 0, 56); u32(o, 4, 1); u32(o, 8, u32(s, 40)); u32(o, 12, u32(s, 16)); u32(o, 16, u32(s, 44)); u32(o, 20, u32(s, 20));
      u32(o, 24, u32(s, 28)); u32(o, 28, u32(s, 32)); u32(o, 32, u32(s, 48)); u32(o, 36, u32(s, 52)); s.copy(o, 40, 56, 72); return 0;
    },
    aster_network_cancel: h => { const s = host.netabi.resolve(h); return !s || s.proto > 2 ? -10 : a.aster_net_cancel(h); },
    aster_network_close: h => { const s = host.netabi.resolve(h); return !s || s.proto > 2 ? -10 : a.aster_net_close(h); },
    aster_http_request: (method, u, un, hp, hn, bp, bn, timeout, limit) => {
      const b = put(HTTP_TAIL); u32(b, 8, PROTO.HTTP); u32(b, 16, timeout); u32(b, 24, u); u32(b, 28, un);
      u32(b, 40, method); u32(b, 44, limit); u32(b, 48, hp); u32(b, 52, hn); u32(b, 56, bp); u32(b, 60, bn);
      return a.aster_net_open(LEGACY, OPEN + HTTP_TAIL);
    },
    aster_http_status: (h, p, size) => {
      if ((size >>> 0) < 56) return -1;
      const rc = a.aster_net_status(h, LEGACY, 72); if (rc) return rc;
      const s = host.bytes(LEGACY, 72), o = host.bytes(p, 56); o.fill(0);
      u32(o, 0, 56); u32(o, 4, 1); u32(o, 8, u32(s, 16)); u32(o, 12, u32(s, 40)); u32(o, 16, u32(s, 20));
      u32(o, 20, u32(s, 44)); u32(o, 24, u32(s, 32)); u32(o, 28, u32(s, 48)); u32(o, 32, u32(s, 24)); s.copy(o, 40, 56, 72); return 0;
    },
    aster_http_read: (h, p, n) => { const b = host.bytes(LEGACY, IO); b.fill(0); u32(b, 0, IO); u32(b, 4, 1); u32(b, 24, p); u32(b, 28, n); return a.aster_net_io(h, OP.RECV, LEGACY, IO); },
    aster_http_header: (h, np, nl, index, p, n, req) => {
      const a0 = p >>> 0, n0 = n >>> 0, r0 = req >>> 0;
      if (n0 && r0 < a0 + n0 && a0 < r0 + 4) return -1;
      const b = host.bytes(LEGACY, IO); b.fill(0); u32(b, 0, IO); u32(b, 4, 1); u32(b, 16, np); u32(b, 20, nl); u32(b, 24, p); u32(b, 28, n); u32(b, 36, index);
      const rc = a.aster_net_io(h, OP.HEADER, LEGACY, IO);
      if (rc >= 0 || rc === -20) host.u32(req, host.u32(LEGACY + 32));
      return rc;
    },
    aster_http_cancel: h => { const s = host.netabi.resolve(h); return !s || s.proto !== 3 ? -10 : a.aster_net_cancel(h); },
    aster_http_close: h => { const s = host.netabi.resolve(h); return !s || s.proto !== 3 ? -10 : a.aster_net_close(h); },
    aster_mqtt_connect: (p, size) => {
      const gate = host.mqtt.gate(); if (gate) return gate;
      if ((size >>> 0) < 80) return -1;
      const v = host.bytes(p, 80), b = put(MQTT_TAIL);
      u32(b, 8, PROTO.MQTT); u32(b, 12, u32(v, 8)); u32(b, 16, u32(v, 16)); u32(b, 20, u32(v, 12)); u32(b, 24, u32(v, 32)); u32(b, 28, u32(v, 36));
      u32(b, 40, u32(v, 20)); u32(b, 44, u32(v, 24));
      for (let i = 0; i < 10; i++) u32(b, 48 + i * 4, u32(v, 40 + i * 4));
      return a.aster_net_open(LEGACY, OPEN + MQTT_TAIL);
    },
    aster_mqtt_status: (h, p, size) => {
      if ((size >>> 0) < 64) return -1;
      const rc = a.aster_net_status(h, LEGACY, 72); if (rc) return rc;
      const s = host.bytes(LEGACY, 72), o = host.bytes(p, 64); o.fill(0);
      u32(o, 0, 64); u32(o, 4, 1); u32(o, 8, u32(s, 16)); u32(o, 12, u32(s, 20)); u32(o, 16, u32(s, 40));
      u32(o, 20, u32(s, 28)); u32(o, 24, u32(s, 32)); u32(o, 28, u32(s, 44)); u32(o, 32, u32(s, 48)); u32(o, 36, u32(s, 52));
      u32(o, 40, u32(s, 56)); u32(o, 44, u32(s, 60)); u32(o, 48, u32(s, 64)); u32(o, 52, u32(s, 24)); u32(o, 56, u32(s, 68)); return 0;
    },
    aster_mqtt_publish: (h, p, n, d, len, qos, retain) => { const b = host.bytes(LEGACY, IO); b.fill(0); u32(b, 0, IO); u32(b, 4, 1); u32(b, 8, (qos & 3) | ((retain & 1) << 2)); u32(b, 16, p); u32(b, 20, n); u32(b, 24, d); u32(b, 28, len); return a.aster_net_io(h, OP.SEND, LEGACY, IO); },
    aster_mqtt_subscribe: (h, p, n, qos) => { const b = host.bytes(LEGACY, IO); b.fill(0); u32(b, 0, IO); u32(b, 4, 1); u32(b, 8, qos & 3); u32(b, 16, p); u32(b, 20, n); return a.aster_net_io(h, OP.SUBSCRIBE, LEGACY, IO); },
    aster_mqtt_unsubscribe: (h, p, n) => { const b = host.bytes(LEGACY, IO); b.fill(0); u32(b, 0, IO); u32(b, 4, 1); u32(b, 16, p); u32(b, 20, n); return a.aster_net_io(h, OP.UNSUBSCRIBE, LEGACY, IO); },
    aster_mqtt_operation: (h, seq, p) => {
      const b = host.bytes(LEGACY, IO); b.fill(0); u32(b, 0, IO); u32(b, 4, 1); u32(b, 36, seq);
      const rc = a.aster_net_io(h, OP.OPERATION, LEGACY, IO); if (!rc) host.u32(p, host.u32(LEGACY + 32)); return rc;
    },
    aster_mqtt_recv: (h, p, size) => {
      if ((size >>> 0) < 1176) return -1;
      const b = host.bytes(LEGACY, IO); b.fill(0); u32(b, 0, IO); u32(b, 4, 1); u32(b, 16, (p >>> 0) + 24); u32(b, 20, 128); u32(b, 24, (p >>> 0) + 152); u32(b, 28, 1024);
      const rc = a.aster_net_io(h, OP.RECV, LEGACY, IO); if (rc) return rc;
      const io = host.bytes(LEGACY, IO), m = host.bytes(p, 24);
      m.fill(0); u32(m, 0, 1176); u32(m, 4, 1); u32(m, 8, u32(io, 32)); u32(m, 12, u32(io, 12)); u32(m, 16, u32(io, 8) & 3);
      u32(m, 20, ((u32(io, 8) & 4) ? 1 : 0) | ((u32(io, 8) & 8) ? 2 : 0)); return 0;
    },
    aster_mqtt_cancel: h => { const s = host.netabi.resolve(h); return !s || s.proto !== 4 ? -10 : a.aster_net_cancel(h); },
    aster_mqtt_close: h => { const s = host.netabi.resolve(h); return !s || s.proto !== 4 ? -10 : a.aster_net_close(h); },
    aster_ws_connect: (p, n, t) => { const b = put(); u32(b, 8, PROTO.WS); u32(b, 16, t); u32(b, 24, p); u32(b, 28, n); return a.aster_net_open(LEGACY, OPEN); },
    aster_ws_status: (h, p, size) => {
      if ((size >>> 0) < 48) return -1;
      const rc = a.aster_net_status(h, LEGACY, 56); if (rc) return rc;
      const s = host.bytes(LEGACY, 56), o = host.bytes(p, 48); o.fill(0);
      u32(o, 0, 48); u32(o, 4, 1); u32(o, 8, u32(s, 16)); u32(o, 12, u32(s, 20)); u32(o, 16, u32(s, 32)); u32(o, 20, u32(s, 28));
      u32(o, 24, u32(s, 40)); u32(o, 28, u32(s, 44)); u32(o, 32, u32(s, 24)); u32(o, 36, u32(s, 48)); return 0;
    },
    aster_ws_send: (h, op, p, n) => { const b = host.bytes(LEGACY, IO); b.fill(0); u32(b, 0, IO); u32(b, 4, 1); u32(b, 8, (op & 255) << 8); u32(b, 24, p); u32(b, 28, n); return a.aster_net_io(h, OP.SEND, LEGACY, IO); },
    aster_ws_recv: (h, p, size) => {
      if ((size >>> 0) < 4124) return -1;
      const b = host.bytes(LEGACY, IO); b.fill(0); u32(b, 0, IO); u32(b, 4, 1); u32(b, 24, (p >>> 0) + 28); u32(b, 28, 4096);
      const rc = a.aster_net_io(h, OP.RECV, LEGACY, IO); if (rc) return rc;
      const io = host.bytes(LEGACY, IO), m = host.bytes(p, 28);
      const opcode = (u32(io, 8) >> 8) & 255, length = u32(io, 32);
      m.fill(0); u32(m, 0, 4124); u32(m, 4, 1); u32(m, 8, opcode); u32(m, 12, length); return 0;
    },
    aster_ws_cancel: h => { const s = host.netabi.resolve(h); return !s || s.proto !== 5 ? -10 : a.aster_net_cancel(h); },
    aster_ws_close: h => { const s = host.netabi.resolve(h); return !s || s.proto !== 5 ? -10 : a.aster_net_close(h); },
  };
  return Object.fromEntries(Object.entries(fns).map(([k, fn]) => [k, (...args) => trap(() => fn(...args))]));
}
module.exports = { NetAbi, legacy, PROTO, OP };
