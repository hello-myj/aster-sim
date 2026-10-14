'use strict';
require('../scripts/integration-inputs').requireIntegrationInputs();
const test = require('node:test');
const assert = require('node:assert/strict');
const {Host} = require('../src/host');
const {loadPackage} = require('../src/package');
const files = {settings: process.env.ASTER_SIM_SCENE_SETTINGS_AST,
               sprites: process.env.ASTER_SIM_SCENE_SPRITES_AST};
for (const [width, height] of [[240, 320], [320, 480]]) {
  for (const kind of ['settings', 'sprites']) {
    test(`SDK Scene ${kind} at ${width}x${height}`, {skip: !files[kind]}, t => {
      let ms = 0;
      const host = new Host(loadPackage(files[kind], {}), {width, height, clock: () => ms});
      t.after(() => host.stop());
      host.start();
      const tick = () => {ms += 34; host.tick();};
      const input = (x, y, action) => host.input({type: 'touch', x, y, action});
      const tap = (x, y) => {input(x, y, 1); tick(); input(x, y, 3); tick();};
      tick();
      assert.equal(host.exitCode, null);
      assert.ok(host.presentCount > 0);
      assert.ok(host.logs.some(x => x.message.includes(`${width}x${height}`)));
      if (kind === 'settings') {
        const presents = host.presentCount, draws = host.metrics.abiCalls.aster_gfx_exec;
        for (let i = 0; i < 30; i++) tick();
        assert.equal(host.presentCount, presents, 'static Scene publishes no frame');
        // QUERY still polls asynchronous font readiness once per frame.
        assert.equal(host.metrics.abiCalls.aster_gfx_exec - draws, 30);
        tap(40, 95);
        assert.ok(host.logs.some(x => x.message.includes('G7SET CLICK index=0 value=1')));
        const clicks = host.logs.filter(x => x.message.includes('G7SET CLICK')).length;
        input(40, height - 70, 1); tick();
        input(40, 110, 2); tick(); input(40, 110, 3); tick();
        assert.equal(host.logs.filter(x => x.message.includes('G7SET CLICK')).length, clicks,
                     'scroll release must not activate a button');
      } else {
        for (let i = 0; i < 270; i++) tick();
        assert.ok(host.presentCount > 200, 'move, hide and recreate sprites');
        tap(30, 100);
        const presents = host.presentCount;
        for (let i = 0; i < 30; i++) tick();
        assert.equal(host.presentCount, presents, 'paused Scene is quiet');
        tap(30, 100); tick();
        assert.ok(host.presentCount > presents);
      }
      host.setPaused(true);
      const count = host.presentCount; tick(); assert.equal(host.presentCount, count);
      host.setPaused(false); tick(); assert.ok(host.presentCount > count);
      assert.equal(host.exitCode, null);
      assert.ok(!host.logs.some(x => /render=-|errors=[1-9]/.test(x.message)), JSON.stringify(host.logs));
    });
  }
}
