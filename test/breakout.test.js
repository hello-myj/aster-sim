'use strict';
require('../scripts/integration-inputs').requireIntegrationInputs();
const test = require('node:test');
const assert = require('node:assert/strict');
const { Host } = require('../src/host');
const { loadPackage } = require('../src/package');
const file = process.env.ASTER_SIM_BREAKOUT_AST;
for (const [width,height] of [[240,320],[320,480],[480,800]]) {
  test(`external SDK breakout WASM: native ${width}x${height}, touch and pause`, { skip: !file }, t => {
    const pkg = loadPackage(file, {}), h = new Host(pkg, {width,height});
    t.after(() => h.stop()); h.start();
    let ms=h.now(); h.now=() => ms;
    const tick=() => {ms+=17;h.tick();};
    const input=(x,y,action) => h.input({type:'touch',x,y,action});
    const tap=(x,y) => {input(x,y,1);input(x,y,3);tick();};
    tick(); assert.equal(h.exitCode,null); assert.ok(h.presentCount>0);
    assert.ok(h.logs.some(x => x.message.includes(`display ${width}x${height}, adaptive canvas ${width}x${height}`)));
    input(width/2,Math.round(height*370/480),1);
    input(Math.round(width*.3),Math.round(height*370/480),2);
    input(Math.round(width*.3),Math.round(height*370/480),3); tick();
    assert.ok(h.logs.some(x => x.message.includes(`paddle=${Math.round(width*.3)}`)));
    tap(Math.round(width/2),Math.round(height*445/480));
    assert.ok(h.logs.some(x => x.message.includes('breakout launch')));
    for(let i=0;i<10;i++) tick();
    tap(Math.round(width*275/320),Math.round(height*36/480));
    assert.ok(h.logs.some(x => x.message.includes('breakout mode=2')));
    assert.equal(h.exitCode,null);
  });
}
