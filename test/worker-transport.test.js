'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {once}=require('node:events');
const {createRuntimeWorker}=require('../src/worker-transport');
const {stopWorker}=require('../src/worker-stop');

function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aster-process-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'runtime.cjs');
 fs.writeFileSync(file,`process.once('message', options=>{
  process.send({type:'ready',bytes:new Uint8Array([0,128,255])});
  if(options.block)while(true){}
  process.once('message', message=>{
   process.send({type:'done',code:message.code},()=>process.disconnect());
  });
 });`);
 return file;
}
test('process runtime preserves binary messages and graceful shutdown',async t=>{
 const worker=createRuntimeWorker(fixture(t),{workerData:{}},'win32');
 t.after(()=>stopWorker(worker));
 const [ready]=await once(worker,'message');
 assert.deepEqual([...ready.bytes],[0,128,255]);
 worker.postMessage({code:1});
 const [done]=await once(worker,'message');assert.equal(done.code,1);
 await stopWorker(worker,true);assert.equal(worker.threadId,-1);
});
test('process runtime can be killed while the guest blocks',async t=>{
 const worker=createRuntimeWorker(fixture(t),{workerData:{block:true}},'win32');
 t.after(()=>stopWorker(worker));
 await once(worker,'message');await stopWorker(worker);
 assert.equal(worker.threadId,-1);
});
