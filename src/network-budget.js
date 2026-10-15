'use strict';
// Shared TCP/UDP/HTTP admission and generations across APP host instances.
const live = new Set(); let generation = 0;
function allocate() { return live.size < 2 && generation < 0x7fffffff ? ++generation : 0; }
module.exports = {live, allocate};
