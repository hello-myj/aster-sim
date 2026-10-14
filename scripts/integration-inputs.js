'use strict';
const fs = require('node:fs');
function requireIntegrationInputs(env = process.env) {
  const keys = [];
  if (env.ASTER_SIM_REQUIRE_PACKAGES === '1')
    keys.push('ASTER_SIM_2048_AST', 'ASTER_SIM_IMUCUBE_AST', 'ASTER_SIM_BREAKOUT_AST');
  if (env.ASTER_SIM_REQUIRE_SCENE_PACKAGES === '1')
    keys.push('ASTER_SIM_SCENE_SETTINGS_AST', 'ASTER_SIM_SCENE_SPRITES_AST');
  for (const key of keys) {
    if (!env[key] || !fs.existsSync(env[key])) throw Error(`Required integration APP missing: ${key}`);
  }
}
module.exports = { requireIntegrationInputs };
