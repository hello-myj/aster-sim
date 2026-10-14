'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { requireIntegrationInputs } = require('../scripts/integration-inputs');
test('release cannot silently skip external APP regression', () => {
  assert.throws(() => requireIntegrationInputs({ ASTER_SIM_REQUIRE_PACKAGES: '1' }), /Required integration APP missing/);
  assert.throws(() => requireIntegrationInputs({ ASTER_SIM_REQUIRE_PACKAGES: '1', ASTER_SIM_2048_AST: '/missing/package.ast' }), /Required integration APP missing/);
  assert.doesNotThrow(() => requireIntegrationInputs({}));
});

test('required Scene integration cannot silently skip absent packages', () => {
  assert.throws(() => requireIntegrationInputs({ASTER_SIM_REQUIRE_SCENE_PACKAGES: '1'}),
                /ASTER_SIM_SCENE_SETTINGS_AST/);
});
