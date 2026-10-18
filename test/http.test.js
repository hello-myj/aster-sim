'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),https=require('node:https'),fs=require('node:fs'),path=require('node:path');
const {Host}=require('../src/host');
require('../scripts/integration-inputs').requireIntegrationInputs();
const delay=()=>new Promise(r=>setTimeout(r,5));
async function until(fn){for(let i=0;i<1200;i++){const v=fn();if(v)return v;await delay();}throw Error('HTTP test deadline');}
function setup(t,extra={}){const h=new Host({manifest:{id:'test.http',permissions:['net']},assets:new Map()},{network:true,...extra});h.memory=new WebAssembly.Memory({initial:1});const a=h.imports();t.after(()=>h.stop());return {h,a};}
function start(x,url,timeout=5000,limit=1048576,method=1,headers=''){const u=Buffer.from(url),v=Buffer.from(headers);u.copy(x.h.bytes(100,u.length));if(v.length)v.copy(x.h.bytes(2000,v.length));const id=x.a.aster_http_request(method,100,u.length,v.length?2000:0,v.length,0,0,timeout,limit);assert.ok(id>0,`request=${id}`);return id;}
function snap(x,id){assert.equal(x.a.aster_http_status(id,500,56),0);return {state:x.h.u32(508),status:x.h.u32(512),error:x.h.u32(516)|0,queued:x.h.u32(524),flags:x.h.u32(528),cert:x.h.u32(532)};}
async function body(x,id){const chunks=[];await until(()=>{const n=x.a.aster_http_read(id,5000,512);if(n>0)chunks.push(Buffer.from(x.h.bytes(5000,n)));else if(n!==-15)return {n};});const s=snap(x,id);return {data:Buffer.concat(chunks),s};}
async function server(t,handler,options){const s=options?https.createServer(options,handler):http.createServer(handler);s.listen(0,'127.0.0.1');await new Promise(r=>s.once('listening',r));t.after(()=>{s.closeAllConnections();s.close();});return `http${options?'s':''}://127.0.0.1:${s.address().port}`;}
test('HTTP real streaming, backpressure, duplicate headers, bounds, owner and shared quota',async t=>{
 const data=Buffer.from(Array.from({length:8192},(_,i)=>i%251));
 const base=await server(t,(req,res)=>{res.setHeader('X-Repeat',['one','two']);res.end(data);});
 const x=setup(t),other=setup(t);const id=start(x,base);
 x.h.bytes(100,base.length).fill(0);await until(()=>snap(x,id).queued===2048);
 assert.equal(x.a.aster_http_read(id,65535,5),-1);assert.equal(other.a.aster_http_close(id),-10);
 x.h.bytes(100,8).write('x-repeat');assert.equal(x.a.aster_http_header(id,100,8,1,1000,2,1100),-20);assert.equal(x.h.u32(1100),3);
 assert.equal(x.a.aster_http_header(id,100,8,1,1000,4,1001),-1);assert.equal(x.a.aster_http_header(id,100,8,1,1000,4,1100),3);assert.equal(x.h.string(1000,3),'two');
 const udp=other.a.aster_network_open(2,0,0,0,0);assert.ok(udp>id);assert.equal(other.a.aster_network_open(2,0,0,0,0),-11);
 const got=await body(x,id);assert.equal(got.s.state,6);assert.equal(got.s.status,200);assert.deepEqual(got.data,data);
 assert.equal(x.a.aster_http_close(id),0);assert.equal(x.a.aster_http_read(id,5000,1),-10);other.a.aster_network_close(udp);await delay();
});
test('HTTP redirect policies, methods, failure, timeout and cancellation',async t=>{
 let seen;
 const target=await server(t,(req,res)=>{seen=req.headers;res.end('ok');});
 const base=await server(t,(req,res)=>{
  if(req.url==='/redirect'){res.writeHead(302,{Location:target});res.end();}
  else if(req.url==='/loop'){res.writeHead(302,{Location:'/loop'});res.end();}
  else if(req.url==='/stall')return;
  else if(req.url==='/truncated'){res.writeHead(200,{'Content-Length':100});res.write('abc');setTimeout(()=>res.destroy(),10);}
  else {res.writeHead(404);res.end('missing');}
 });const x=setup(t);
 let id=start(x,base+'/redirect',5000,100,1,'Authorization: secret\r\nCookie: secret\r\n');let got=await body(x,id);assert.equal(got.data.toString(),'ok');assert.equal(seen.authorization,undefined);assert.equal(seen.cookie,undefined);x.a.aster_http_close(id);await delay();
 id=start(x,base+'/loop');got=await body(x,id);assert.equal(got.s.error,-30);x.a.aster_http_close(id);await delay();
 id=start(x,base+'/404');got=await body(x,id);assert.equal(got.s.status,404);assert.equal(got.s.error,0);x.a.aster_http_close(id);await delay();
 id=start(x,base+'/truncated');got=await body(x,id);assert.equal(got.s.error,-26);assert.equal(got.data.toString(),'abc');x.a.aster_http_close(id);await delay();
 id=start(x,base+'/stall',100);got=await body(x,id);assert.equal(got.s.error,-8);x.a.aster_http_close(id);await delay();
 id=start(x,base+'/stall');assert.equal(x.a.aster_http_cancel(id),0);assert.equal(snap(x,id).state,8);assert.equal(x.a.aster_http_read(id,5000,1),-19);x.a.aster_http_close(id);await delay();
});
test('HTTP permission, explicit networking and hostile request bounds',t=>{
 const x=setup(t);x.h.permissions.clear();assert.equal(x.a.aster_http_request(1,0,0,0,0,0,0,1,1),-4);x.h.permissions.add('net');
 assert.equal(x.a.aster_http_request(1,65535,10,0,0,0,0,1,1),-1);assert.equal(x.a.aster_http_request(1,100,-1,0,0,0,0,1,1),-1);
 const u='http://127.0.0.1:9080/';x.h.bytes(100,u.length).write(u);
 const headers='X-Test: \nunsafe\r\n';x.h.bytes(2000,headers.length).write(headers);
 assert.equal(x.a.aster_http_request(1,100,u.length,2000,headers.length,0,0,1000,100),-1);
 const off=setup(t,{network:false});assert.equal(off.a.aster_http_request(1,0,0,0,0,0,0,1,1),-3);
});
test('HTTP HEAD, 204, binary POST copy and body limit',async t=>{
 const base=await server(t,(req,res)=>{
  if(req.url==='/204'){res.writeHead(204);res.end();return;}
  if(req.method==='POST'){const parts=[];req.on('data',b=>parts.push(b));req.on('end',()=>res.end(Buffer.concat(parts)));return;}
  res.setHeader('Content-Length',8);res.end('12345678');
 });const x=setup(t);
 let id=start(x,base,5000,100,2),got=await body(x,id);assert.equal(got.s.state,6);assert.equal(got.data.length,0);x.a.aster_http_close(id);await delay();
 id=start(x,base+'/204');got=await body(x,id);assert.equal(got.s.state,6);assert.equal(got.s.status,204);assert.equal(got.data.length,0);x.a.aster_http_close(id);await delay();
 id=start(x,base,5000,7);got=await body(x,id);assert.equal(got.s.error,-20);assert.equal(got.data.length,0);x.a.aster_http_close(id);await delay();
 x.h.bytes(100,base.length).write(base);x.h.bytes(2000,4).set([0,255,128,1]);
 id=x.a.aster_http_request(3,100,base.length,0,0,2000,4,5000,100);assert.ok(id>0);x.h.bytes(2000,4).fill(0);
 got=await body(x,id);assert.deepEqual(got.data,Buffer.from([0,255,128,1]));x.a.aster_http_close(id);await delay();
});
const certDir=process.env.ASTER_HTTP_TEST_CERTS;
test('immediate HTTP close retains quota until native request teardown',async t=>{
 const base=await server(t,()=>{}),x=setup(t),id=start(x,base);
 assert.equal(x.a.aster_http_close(id),0);
 const udp=x.a.aster_network_open(2,0,0,0,0);assert.ok(udp>0);
 assert.equal(x.a.aster_network_open(2,0,0,0,0),-11);
 const next=await until(()=>{const n=x.a.aster_network_open(2,0,0,0,0);assert.ok(n===-11||n>0);return n>0?n:0;});
 x.a.aster_network_close(udp);x.a.aster_network_close(next);await delay();
});
test('HTTPS real verification, single TLS quota, failure recovery and APP stop',{skip:!certDir},async t=>{
 const read=n=>fs.readFileSync(path.join(certDir,n));
 const base=await server(t,(req,res)=>res.end('secure'),{key:read('server.key'),cert:read('server.pem'),minVersion:'TLSv1.2',maxVersion:'TLSv1.2'});
 const x=setup(t,{networkCA:path.join(certDir,'ca.pem')});
 // The local fixture has LAN SANs and a DNS SAN, not loopback: prove rejection.
 let id=start(x,base);let got=await body(x,id);assert.equal(got.s.error,-28);assert.equal(got.s.cert,4);x.a.aster_http_close(id);await delay();
 const lan=process.env.ASTER_HTTP_TEST_HOST;
 assert.ok(lan,'set ASTER_HTTP_TEST_HOST to the fixture LAN IP');
 const untrusted=setup(t);id=start(untrusted,`https://${lan}:9443/fixed?n=8`);got=await body(untrusted,id);assert.equal(got.s.error,-28);assert.ok(got.s.cert);untrusted.a.aster_http_close(id);await delay();
 id=start(x,`https://${lan}:9443/fixed?n=4096`);got=await body(x,id);assert.equal(got.s.error,0);assert.equal(got.data.length,4096);assert.deepEqual(got.data,Buffer.from(Array.from({length:4096},(_,i)=>i%251)));
 const url=`https://${lan}:9443/fixed?n=8`;x.h.bytes(100,url.length).write(url);assert.equal(x.a.aster_http_request(1,100,url.length,0,0,0,0,5000,100),-5);
 x.a.aster_http_close(id);await delay();
 id=start(x,`https://${lan}:9445/fixed?n=8`);got=await body(x,id);assert.equal(got.s.error,-28);assert.equal(got.s.cert,1);x.a.aster_http_close(id);await delay();
 id=start(x,`https://${lan}:9443/stall`);await delay();x.h.stop();await delay();assert.equal(x.h.http.slots.size,0);
});
/* N5.4 resume reference: packaged APP + Range-aware fixture that drops the
 * stream mid-flight, forcing a real 206 continuation; verifies the final
 * file end to end and the temp cleanup. */
const resumeFile=process.env.ASTER_HTTP_RESUME_AST, resumeServer=process.env.ASTER_RESUME_SERVER;
test('actual SDK HTTP RESUME APP survives mid-stream drops and commits verified file',
 {skip:!resumeFile||!resumeServer},async t=>{
 const {spawn}=require('node:child_process');
 const srv=spawn(process.execPath,[resumeServer],{stdio:['ignore','pipe','inherit']});
 let out='';srv.stdout.on('data',b=>{out+=b;});
 t.after(()=>srv.kill());
 await new Promise(r=>{const iv=setInterval(()=>{if(out.includes('ready')){clearInterval(iv);r();}},25);setTimeout(()=>{clearInterval(iv);r();},3000);});
 const {loadPackage}=require('../src/package');
 const h=new Host(loadPackage(resumeFile),{network:true});t.after(()=>h.stop());h.start();
 await until(()=>{h.tick();assert.ok(!h.logs.some(x=>x.message.includes('DLAPP FAIL')),JSON.stringify(h.logs));
  return h.logs.some(x=>x.message.includes('DLAPP PASS'));});
 h.tick();assert.equal(h.http.slots.size,0);
 const data=h.storageFs.readFileSync(path.join(h.root,'data/file.bin'));
 assert.equal(data.length,65536);
 assert.deepEqual(data,Buffer.from(Array.from({length:65536},(_,i)=>i%251)));
 const lines=out.split('\n').filter(l=>l.trim().startsWith('{')).map(l=>JSON.parse(l));
 const dropped=lines.filter(l=>l.droppedAt), part=lines.filter(l=>l.status===206);
 assert.ok(dropped.length>=1,'mid-stream drop happened: '+out);
 assert.ok(part.length>=1,'resume 206 issued: '+out);
 assert.ok(!lines.some(l=>l.status===200&&l.req>1),'never re-GET after resume started: '+out);
 assert.ok(!h.storageFs.existsSync(path.join(h.root,'data/file.part')),'temp removed after commit');
});
for(const kind of ['FETCH','DOWNLOAD']){
 const file=process.env['ASTER_HTTP_'+kind+'_AST'];
 test('actual SDK HTTP '+kind+' APP content and resource cleanup',{skip:!file},async t=>{
  const {loadPackage}=require('../src/package');
  const h=new Host(loadPackage(file),{network:true});t.after(()=>h.stop());h.start();
  await until(()=>{h.tick();assert.ok(!h.logs.some(x=>x.message.includes('HTTPAPP FAIL')),JSON.stringify(h.logs));return h.logs.some(x=>x.message.includes('HTTPAPP PASS'));});
  h.tick();assert.equal(h.http.slots.size,0);
  if(kind==='DOWNLOAD'){
   const data=h.storageFs.readFileSync(path.join(h.root,'data/download.bin'));
   assert.deepEqual(data,Buffer.from(Array.from({length:65536},(_,i)=>i%251)));
  }
  assert.ok(h.presentCount>0);
 });
}
