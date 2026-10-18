'use strict';
// Shared TCP/UDP/HTTP/WS admission and generations across APP host instances.
// Two transport slots; the WebSocket layer also enforces one client per device
// (shared with the diagnostic CLI) through wsSlot, retained until close.
const live = new Set(); let generation = 0;
let wsSlot = null;
function allocate() { return live.size < 2 && generation < 0x7fffffff ? ++generation : 0; }
module.exports = {live, allocate, ws: () => wsSlot, takeWs: s => { if (wsSlot) return false; wsSlot = s; return true; }, releaseWs: s => { if (wsSlot === s) wsSlot = null; }};
