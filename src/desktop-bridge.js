'use strict';
// Private line protocol for the native Python desktop. No HTTP/browser server.
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const {DesktopCatalog}=require('./desktop-catalog'),{createRuntimeWorker}=require('./worker-transport'),{stopWorker}=require('./worker-stop');
let worker,options,registry,last=0,quitting=false;
const send=m=>process.stdout.write(JSON.stringify({...m,...(options?{state:options.state}:{})})+'\n');
const announce=()=>{registry=new DesktopCatalog(options.state);send({type:'catalog',apps:registry.list().map(p=>p.manifest)});};
async function home(){const old=worker;worker=null;if(old)await stopWorker(old);send({type:'audio',op:'stop'});if(registry)announce();send({type:'home'});}
function start(id){
 if(worker)throw Error('Stop the active APP before starting another');
 last=Date.now();const current=createRuntimeWorker(path.join(__dirname,'desktop-worker.js'),{workerData:{...options,appId:id}});worker=current;
 current.on('message',m=>{if(worker!==current)return;last=Date.now();if(Buffer.isBuffer(m.data)||m.data instanceof Uint8Array)m.data=Buffer.from(m.data).toString('base64');if(m.type==='home'){worker=null;stopWorker(current,true).catch(()=>{});}if(m.type!=='heartbeat')send(m);});
 current.on('error',e=>{if(worker===current){send({type:'error',message:e.message});home();}});
 current.on('exit',code=>{if(worker===current){worker=null;send({type:'home',error:code?'APP process exited '+code:undefined});}});
}
let serial=Promise.resolve();
readline.createInterface({input:process.stdin}).on('line',line=>{serial=serial.then(async()=>{
 if(line.length>16384)throw Error('Command too large');const m=JSON.parse(line);
 if(m.type==='configure'){const old=worker;worker=null;if(old)await stopWorker(old);options=m.options;registry=new DesktopCatalog(options.state);registry.exportIcons();send({type:'audio',op:'stop'});announce();send({type:'home'});}
 else if(m.type==='import'){try{if(worker)throw Error('Return home before importing');const id=registry.import(m.file,m.resources,p=>send({type:'install',request:m.request,...p}));announce();send({type:'imported',id,request:m.request});}catch(e){send({type:'import-failed',request:m.request,message:e.message});}}
 else if(m.type==='uninstall'){if(worker)throw Error('Return home before uninstalling');registry=new DesktopCatalog(options.state);registry.uninstall(m.id);announce();}
 else if(m.type==='start')start(m.id);
 else if(m.type==='home')await home();
 else if(m.type==='quit'){quitting=true;await home();process.exit(0);}
 else if(worker)worker.postMessage(m);
 }).catch(e=>send({type:'error',message:e.message}));});
const watchdog=setInterval(()=>{if(worker&&Date.now()-last>10000){send({type:'error',message:'APP callback timed out; returned home'});home();}},500);
process.stdin.on('end',async()=>{if(quitting)return;quitting=true;clearInterval(watchdog);await home();process.exit(0);});
