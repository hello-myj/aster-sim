'use strict';
// Synthetic byte buffers for loader/lifecycle tests; no APP files are shipped.
function wasmFixture(eventBody = [0,0x0b]) {
  const bytes=[0,97,115,109,1,0,0,0], section=(id,data)=>bytes.push(id,data.length,...data);
  section(1,[2,0x60,0,1,0x7f,0x60,1,0x7f,0]); section(3,[2,0,1]);
  section(5,[1,1,1,32]); section(6,[1,0x7f,0,0x41,0x80,0x08,0x0b]);
  const exports=[4];
  for(const [name,kind,index] of [['memory',2,0],['__heap_base',3,0],['aster_app_init',0,0],['aster_app_event',0,1]]) exports.push(name.length,...Buffer.from(name),kind,index);
  section(7,exports); section(10,[2,4,0,0x41,0,0x0b,eventBody.length,...eventBody]); return Buffer.from(bytes);
}
function packageFixture(wasm = wasmFixture()) {
  const manifest=Buffer.from(JSON.stringify({id:'test.fixture',abi:{min:'3.6'},permissions:[]}));
  const offset=(64+manifest.length+3)&~3, b=Buffer.alloc(offset+wasm.length);
  b.write('ASTP'); b.writeUInt16LE(1,4); b.writeUInt16LE(64,6);
  b.writeUInt32LE(64,12); b.writeUInt32LE(manifest.length,16);
  b.writeUInt32LE(offset,20); b.writeUInt32LE(wasm.length,24);
  manifest.copy(b,64); wasm.copy(b,offset); return b;
}
module.exports={wasmFixture,packageFixture};
