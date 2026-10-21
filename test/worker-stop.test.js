'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {stopWorker}=require('../src/worker-stop');
function worker(){const w=new EventEmitter();w.threadId=1;w.terminated=0;w.terminate=async()=>{w.terminated++;w.threadId=-1;w.emit('exit',1);};return w;}
test('normal worker completion waits for exit without interrupting cleanup',async()=>{
 const w=worker();const stopping=stopWorker(w,true,100);assert.equal(w.terminated,0);
 w.threadId=-1;w.emit('exit',0);await stopping;assert.equal(w.terminated,0);assert.equal(w.listenerCount('exit'),0);
});
test('watchdog and a stalled graceful shutdown still terminate the worker',async()=>{
 const forced=worker();await stopWorker(forced);assert.equal(forced.terminated,1);
 const stalled=worker();await stopWorker(stalled,true,5);assert.equal(stalled.terminated,1);assert.equal(stalled.listenerCount('exit'),0);
});
