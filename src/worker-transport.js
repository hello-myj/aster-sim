'use strict';
const { Worker } = require('node:worker_threads');
const { fork } = require('node:child_process');
const { EventEmitter } = require('node:events');

// Windows native Canvas can fault during worker-isolate teardown after a
// WASM exception. Run that native environment in a child process instead;
// keep the same messages, exit notification and watchdog termination API.
class ProcessWorker extends EventEmitter {
  constructor(filename, { workerData }) {
    super();
    this.child = fork(filename, [], {
      serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    this.threadId = this.child.pid;
    this.onParentExit = () => this.child.kill();
    process.once('exit', this.onParentExit);
    this.child.on('message', message => this.emit('message', message));
    this.child.on('error', error => this.emit('error', error));
    this.child.on('exit', code => {
      process.removeListener('exit', this.onParentExit);
      this.threadId = -1;
      this.emit('exit', code === null ? 1 : code);
    });
    this.postMessage(workerData);
  }
  postMessage(message) {
    if (!this.child.connected) return;
    this.child.send(message, error => {
      if (error && this.threadId !== -1) this.emit('error', error);
    });
  }
  terminate() {
    if (this.threadId === -1) return Promise.resolve(0);
    return new Promise(resolve => {
      this.once('exit', resolve);
      this.child.kill();
    });
  }
}

function createRuntimeWorker(filename, options, platform = process.platform) {
  return platform === 'win32' ? new ProcessWorker(filename, options) : new Worker(filename, options);
}
module.exports = { createRuntimeWorker };
