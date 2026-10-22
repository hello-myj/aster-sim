'use strict';
const { parentPort: threadPort, workerData: threadData } = require('node:worker_threads');
function boot(parentPort, workerData) {
const { loadPackage } = require('./package');
const { Host } = require('./host');
const fs = require('node:fs');
const { MemoryFS } = require('./memory-fs');
const { Replay } = require('./replay');
const replay = workerData.replay ? new Replay(workerData.replay) : null;
const memoryStorage = workerData.state ? undefined : new MemoryFS(replay?.config.faults?.storage_bytes);
let host, timeout, activePkg, finished=false;
function send(msg) { parentPort.postMessage(msg); }
function finish(error) {
  if(finished)return;finished=true;
  clearTimeout(timeout);
  const diagnostics=host?.diagnostics()||{appId:activePkg?.manifest.id,appVersion:activePkg?.manifest.version,abiTarget:activePkg?.manifest.abi?.target,phase:'load'};const state=host?.stateDigest();
  try { host?.stop(); } catch (e) { error ||= e; }
  if (workerData.screenshot && host) {try{fs.writeFileSync(workerData.screenshot,host.screen.toBuffer('image/png'));}catch(e){error ||= e;}}
  send({ type: 'done', error: error?.stack, code: error ? 1 : host?.exitCode || 0, frames: host?.frame, presents: host?.presentCount, diagnostics, state, replay: replay ? {steps:replay.frame,seed:replay.config.seed,stepMs:replay.config.step_ms}:null });
  parentPort.close();
}
function run() {
  try {
    if(replay)replay.step(host);else host.tick();
    if (host.exitCode !== null && host.switchTo) {
      const app = host.options.catalog.find(x => x.manifest.id === host.switchTo); host.stop(); start(app); return;
    }
    if (host.exitCode !== null || (workerData.frames && (replay?replay.frame:host.frame) >= workerData.frames)) { finish(); return; }
    send({ type: 'heartbeat', frames: host.frame, paused: host.paused,diagnostics:host.diagnostics() });
    timeout = setTimeout(run, replay ? 0 : 1000 / host.fps);
  } catch (e) { finish(e); }
}
function start(pkg) {
  activePkg=pkg;
  const fault=replay?.config.faults||{};
  host = new Host(pkg, { ...workerData, memoryStorage, catalog, send,clock:replay?()=>replay.ms:undefined,epochMs:replay?.config.epoch_ms,missingFeatures:fault.missing_features,allocationFailAt:fault.allocation_fail_at }); host.start();
  send({ type: 'ready', width: host.width, height: host.height, manifest: host.manifest, hasAot: pkg.hasAot, features: [...host.features], apis: host.apiNames });
  run();
}
let catalog;
try {
  catalog = workerData.files.map(file => loadPackage(file, workerData)); start(catalog[0]);
  parentPort.on('message', msg => { try { if (msg.type === 'stop') finish(); else if(replay)return;else if (msg.type === 'reset') { clearTimeout(timeout); host.stop(); start(catalog[0]); } else host.input(msg); } catch (e) { finish(e); } });
} catch (e) { finish(e); }

}
if (threadPort) boot(threadPort, threadData);
else process.once('message', data => boot({
  postMessage: message => process.send(message),
  close: () => process.disconnect(),
  on: (event, handler) => process.on(event, handler),
}, data));
