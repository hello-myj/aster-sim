'use strict';
/* A completed worker already closes its parentPort. Let native canvas cleanup
 * finish normally; watchdog/error paths still force termination. */
async function stopWorker(worker, graceful = false, graceMs = 2000) {
  if (!worker || worker.threadId === -1) return;
  if (!graceful) { await worker.terminate(); return; }
  await new Promise(resolve => {
    let timer;
    const finish = () => { clearTimeout(timer); worker.removeListener('exit', finish); resolve(); };
    worker.once('exit', finish);
    timer = setTimeout(() => { Promise.resolve(worker.terminate()).then(finish, finish); }, graceMs);
    if (worker.threadId === -1) finish();
  });
}
module.exports = { stopWorker };
