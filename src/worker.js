'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { loadPackage } = require('./package');
const { Host } = require('./host');
const fs = require('node:fs');
const { MemoryFS } = require('./memory-fs');
const memoryStorage = workerData.state ? undefined : new MemoryFS();
let host, timeout;
function send(msg) { parentPort.postMessage(msg); }
function finish(error) {
  clearTimeout(timeout);
  try { host?.stop(); } catch (e) { error ||= e; }
  if (workerData.screenshot && host) fs.writeFileSync(workerData.screenshot, host.screen.toBuffer('image/png'));
  send({ type: 'done', error: error?.stack, code: error ? 1 : host?.exitCode || 0, frames: host?.frame, presents: host?.presentCount });
  parentPort.close();
}
function run() {
  try {
    host.tick();
    if (host.exitCode !== null && host.switchTo) {
      const app = host.options.catalog.find(x => x.manifest.id === host.switchTo); host.stop(); start(app); return;
    }
    if (host.exitCode !== null || (workerData.frames && host.frame >= workerData.frames)) { finish(); return; }
    send({ type: 'heartbeat', frames: host.frame, paused: host.paused });
    timeout = setTimeout(run, 1000 / host.fps);
  } catch (e) { finish(e); }
}
function start(pkg) {
  host = new Host(pkg, { ...workerData, memoryStorage, catalog, send }); host.start();
  send({ type: 'ready', width: host.width, height: host.height, manifest: host.manifest, hasAot: pkg.hasAot, features: [...host.features], apis: host.apiNames });
  run();
}
let catalog;
try {
  catalog = workerData.files.map(file => loadPackage(file, workerData)); start(catalog[0]);
  parentPort.on('message', msg => { try { if (msg.type === 'stop') finish(); else if (msg.type === 'reset') { clearTimeout(timeout); host.stop(); start(catalog[0]); } else host.input(msg); } catch (e) { finish(e); } });
} catch (e) { finish(e); }
