'use strict';
const fs = require('node:fs');
function requireIntegrationInputs(env = process.env) {
  const keys = ['ASTER_SIM_2048_AST', 'ASTER_SIM_IMUCUBE_AST', 'ASTER_SIM_BREAKOUT_AST'];
  if (env.ASTER_SIM_REQUIRE_PACKAGES !== '1') return;
  for (const key of keys) {
    if (!env[key] || !fs.existsSync(env[key])) throw Error(`Required integration APP missing: ${key}`);
  }
}
module.exports = { requireIntegrationInputs };
