/* SPDX-License-Identifier: MIT. Two browser pointers -> stable Aster slots. */
(function (root) {
  'use strict';
  function connectTouchPointers(canvas, emit) {
    const pointers = new Map();
    function position(event) {
      const r = canvas.getBoundingClientRect();
      return { x: Math.max(0, Math.min(canvas.width - 1, (event.clientX - r.left) * canvas.width / r.width)),
               y: Math.max(0, Math.min(canvas.height - 1, (event.clientY - r.top) * canvas.height / r.height)) };
    }
    function send(point, action) { emit({ type: 'touch', action, slot: point.slot, x: point.x, y: point.y }); }
    canvas.onpointerdown = event => {
      if (pointers.has(event.pointerId) || pointers.size >= 2 || (event.button !== undefined && event.button !== 0)) return;
      const used = new Set([...pointers.values()].map(p => p.slot));
      const point = { ...position(event), slot: used.has(0) ? 1 : 0 };
      pointers.set(event.pointerId, point); canvas.focus();
      try { canvas.setPointerCapture(event.pointerId); } catch (_) { /* blur still releases every pointer */ }
      send(point, 1);
    };
    canvas.onpointermove = event => {
      const point = pointers.get(event.pointerId); if (!point) return;
      Object.assign(point, position(event)); send(point, 2);
    };
    function end(event) {
      const point = pointers.get(event.pointerId); if (!point) return;
      if (event.type === 'pointerup' && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) Object.assign(point, position(event));
      pointers.delete(event.pointerId); send(point, 3);
    }
    canvas.onpointerup = canvas.onpointercancel = canvas.onlostpointercapture = end;
    return { release() { for (const point of pointers.values()) send(point, 3); pointers.clear(); } };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { connectTouchPointers };
  else root.connectTouchPointers = connectTouchPointers;
})(typeof globalThis !== 'undefined' ? globalThis : this);
