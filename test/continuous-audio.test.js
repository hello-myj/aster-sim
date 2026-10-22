'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { Host } = require('../src/host');
const { loadPackage } = require('../src/package');

// Build apps/continuous-audio in the SDK, then provide its ASTP path.
for (const [width,height] of [[240,320],[320,480]]) {
  test(`SDK continuous effect: ${width}x${height}, 50 lifecycle cycles`,
    {skip: !process.env.ASTER_SIM_CONTINUOUS_AST}, () => {
    const pkg=loadPackage(process.env.ASTER_SIM_CONTINUOUS_AST);
    for(let round=0;round<50;round++) {
      let ms=0;
      const h=new Host(pkg,{width,height,clock:()=>ms}).start();
      try {
        const effects=[...h.handles.values()].filter(v=>v.kind==='effect');
        assert.equal(effects.length,1);const v=effects[0].voice;
        assert.equal(effects[0].info.bytes,4096);assert.equal(h.fps,5);assert.equal(v.playing,true);
        ms=17;v.sync(ms);const phase=v.phase;
        // Hundreds of seconds without an APP frame cannot stop the voice.
        ms+=600003;v.sync(ms);assert.equal(v.playing,true);assert.notEqual(v.phase,phase);
        h.setPaused(true);const frozen=v.phase;ms+=1303;v.sync(ms);assert.equal(v.phase,frozen);
        h.setPaused(false);ms+=25;v.sync(ms);assert.notEqual(v.phase,frozen);
        const tap=x=>{h.input({type:'touch',action:1,x,y:150});h.input({type:'touch',action:3,x,y:150});};
        tap(10);ms+=200;v.sync(ms);assert.equal(v.pitch,98304);
        tap(width-30);ms+=200;v.sync(ms);assert.equal(v.playing,false);
        tap(width-30);assert.equal(v.playing,true);h.tick();assert.ok(h.presentCount>0);
        assert.equal(h.lastTrap,undefined);
      } finally {h.stop();}
      assert.equal(h.handles.size,0);
      assert.deepEqual([...h.allocations.entries()],[[h.eventPtr,64]]); // Host-owned event buffer; no APP allocations survive.
    }
  });
}
