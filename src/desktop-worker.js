'use strict';
const {parentPort:threadPort,workerData:threadData}=require('node:worker_threads');
function boot(port,options){
  const fs=require('node:fs'),{Host}=require('./host'),{DesktopCatalog}=require('./desktop-catalog');
  let host,timer,finished=false;const registry=new DesktopCatalog(options.state),catalog=registry.list();
  const send=m=>port.postMessage(m);
  const announce=()=>send({type:'catalog',apps:registry.list().map(p=>p.manifest)});
  function home(error){if(finished)return;finished=true;clearTimeout(timer);try{host?.stop();}catch(e){error ||= e;}announce();send({type:'home',error:error?.message});port.close();}
  function start(id){const pkg=catalog.find(p=>p.manifest.id===id);if(!pkg)throw Error('APP not installed: '+id);
    host=new Host(pkg,{...options,catalog,send,commitInstall:(installed,request)=>{send({type:'install',phase:'copy',id:installed.manifest.id});registry.commit(installed,fs.readFileSync(request.program));send({type:'install',phase:'done',id:installed.manifest.id});}});send({type:'ready',width:host.width,height:host.height,manifest:pkg.manifest});host.start();run();}
  function run(){try{host.tick();if(host.exitCode!==null){const next=host.switchTo;host.stop();host.completeInstall();if(next){start(next);return;}home();return;}send({type:'heartbeat',frames:host.frame});timer=setTimeout(run,1000/host.fps);}catch(e){home(e);}}
  try{start(options.appId);port.on('message',m=>{try{if(m.type==='stop')home();else if(m.type==='volume'){host.volume=Math.max(0,Math.min(100,m.volume|0));host.send({type:'audio',op:'volume',volume:host.volume});}else host.input(m);}catch(e){home(e);}});}catch(e){home(e);}
}
if(threadPort)boot(threadPort,threadData);else process.once('message',data=>boot({postMessage:m=>process.send(m),close:()=>process.disconnect(),on:(name,fn)=>process.on(name,fn)},data));
