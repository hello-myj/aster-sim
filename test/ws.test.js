const {legacy}=require('../src/net');
'use strict';
// ABI 3.12 WebSocket/WSS simulation tests against a real Node `ws` peer:
// wire content with boundaries, bounded single-slot ordering, stable error
// domain, device-wide client quota, shared TLS lease, terminal handle
// retention and stop cleanup. TLS/cert and packaged-APP cases require their
// explicit environment fixtures.
const test=require('node:test'),assert=require('node:assert/strict'),net=require('node:net'),http=require('node:http'),https=require('node:https'),fs=require('node:fs'),path=require('node:path');
const {WebSocketServer}=require('ws');
const {Host}=require('../src/host');
const {live}=require('../src/network-budget');
const {parse}=require('../src/ws');
require('../scripts/integration-inputs').requireIntegrationInputs();
const delay=ms=>new Promise(r=>setTimeout(r,ms??5));
async function until(fn,limit=2000){for(let i=0;i<limit;i++){const v=fn();if(v)return v;await delay();}throw Error('WS test deadline');}
function setup(t,extra={}){const h=new Host({manifest:{id:'test.ws',permissions:['net']},assets:new Map()},{network:true,...extra});
 h.memory=new WebAssembly.Memory({initial:1});const a=h.imports();
 t.after(()=>h.stop());
 return {h,a,n:legacy(h)};}
async function peer(t,options=null,port=0){const clients=new Set(),log={opened:0,pongs:0};
 const wss=new WebSocketServer({noServer:true,maxPayload:65535,perMessageDeflate:false});
 const handler=(req,res)=>{const u=new URL(req.url,'http://local');
  if(u.pathname==='/stats'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(log));return;}
  res.writeHead(404);res.end();};
 const app=options?https.createServer(options,handler):http.createServer(handler);
 app.on('upgrade',(req,sock,head)=>{const pathname=new URL(req.url,'http://local').pathname;
  if(pathname==='/badaccept'){sock.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: invalid\r\n\r\n');return;}
  if(pathname==='/stall')return; /* no reply: exercises the connect deadline */
  wss.handleUpgrade(req,sock,head,socket=>{log.opened++;clients.add(socket);socket.on('close',()=>clients.delete(socket));socket.on('error',()=>{});
   socket.on('pong',()=>log.pongs++);
   if(pathname==='/oversize'){socket._socket.write(Buffer.from([0x82,126,0x10,0x01]));
    socket._socket.write(Buffer.alloc(4097,0x41));return;} /* full 4097-byte frame */
   if(pathname==='/badutf8'){socket._socket.write(Buffer.from([0x81,2,0xc0,0x80]));return;}
   if(pathname==='/close'){socket.close(1000);return;}
   if(pathname==='/closemsg'){socket.send(Buffer.from([0x42]),{binary:true});setTimeout(()=>socket.close(1001),80);return;}
   if(pathname==='/buffered-cancel'){socket.send(Buffer.from([0x55]),{binary:true});return;} /* one message, then idle: APP drains before cancel */
   if(pathname==='/ping'){socket.ping(Buffer.from('1'));socket.send(Buffer.from([0xd1]),{binary:true});
    socket.ping(Buffer.from('2'));socket.send(Buffer.from([0xd2]),{binary:true});
    socket.ping(Buffer.from('3'));socket.send(Buffer.from([0xd3]),{binary:true});return;}
   if(pathname==='/multi'){socket.send(Buffer.from([0xa1]),{binary:true});socket.send(Buffer.from([0xb1,0xb2]),{binary:true});
    socket.send(Buffer.alloc(0),{binary:true});socket.send('尾',{binary:false});return;}
   socket.on('message',(data,binary)=>{if(data.length>4096){socket.close(1009);return;}socket.send(Buffer.from(data),{binary});});});});
 app.listen(port,'127.0.0.1');await new Promise(r=>app.once('listening',r));
 t.after(()=>{for(const c of clients)c.terminate();app.close();});
 return {app,port:app.address().port,clients,log};}
function put(x,at,data){const b=Buffer.from(data);b.copy(x.h.bytes(at,b.length));return b.length;}
function state(x,h){assert.equal(x.n.aster_ws_status(h,5000,48),0);
 return {state:x.h.u32(5008),error:x.h.u32(5012)|0,queued:x.h.u32(5016),pending:x.h.u32(5020),
  received:x.h.u32(5024),sent:x.h.u32(5028),close:x.h.u32(5032),cert:x.h.u32(5036)};}
function open(x,srv,route='echo',host='127.0.0.1',tlsScheme=false,timeout=8000,at=100){
 const n=put(x,at,`ws${tlsScheme?'s':''}://${host}:${srv.port}/${route}`);
 const h=x.n.aster_ws_connect(at,n,timeout);assert.ok(h>0,`connect=${h}`);return h;}
async function ready(x,h){await until(()=>state(x,h).state===4);return state(x,h);}
async function drain(x,h,opcode,data){
 await until(()=>state(x,h).queued===1);
 assert.equal(x.n.aster_ws_recv(h,2000,4124),0);
 assert.equal(x.h.u32(2008),opcode);assert.equal(x.h.u32(2012),data.length);
 assert.deepEqual(Buffer.from(x.h.bytes(2028,data.length)),Buffer.from(data));}
async function roundtrip(x,srv,h,opcode,payload){
 const n=put(x,1000,payload);
 assert.equal(x.n.aster_ws_send(h,opcode,n?1000:0,n),0);x.h.bytes(1000,Math.max(n,1)).fill(0);
 await drain(x,h,opcode,payload);}
async function terminal(x,h){return until(()=>{const s=state(x,h);return s.state>=6?s:null;});}
async function released(){await until(()=>live.size===0);}

test('URL parser accepts bounded ws(s) forms and rejects malformed targets',()=>{
 assert.deepEqual(parse('ws://a.test/'),{tls:false,host:'a.test',port:80,path:'/'});
 assert.deepEqual(parse('wss://1.2.3.4:8443/x?y=1'),{tls:true,host:'1.2.3.4',port:8443,path:'/x?y=1'});
 assert.deepEqual(parse('ws://h'),{tls:false,host:'h',port:80,path:'/'});
 for(const bad of ['http://host/','ws://host:0/','ws://ho st/','ws://user@host/','ws://host/#frag','ws://host/a#b',
  'ws://host:'+'9'.repeat(6),'ws://'+'a'.repeat(1025)+'.test/','ws://[::1]/','ws://.lead.test/','ws://trail.test./','ws://host:notaport/'])
  assert.throws(()=>parse(bad),undefined,'should reject '+bad);
});
test('WS real wire: text/binary/empty boundaries, send slot, one client, close/reopen',async t=>{
 const srv=await peer(t),x=setup(t),other=setup(t);const h=open(x,srv);await ready(x,h);
 // Foreign host cannot address the handle at all.
 assert.equal(other.n.aster_ws_status(h,5000,48),-10);assert.equal(other.n.aster_ws_close(h),-10);
 assert.equal(other.n.aster_ws_recv(h,2000,4124),-10);assert.equal(other.n.aster_ws_cancel(h),-10);
 // Bounds are checked before the service sees the call.
 assert.equal(x.n.aster_ws_status(h,65535,48),-1);assert.equal(x.n.aster_ws_status(h,5000,47),-1);
 assert.equal(x.n.aster_ws_send(h,3,0,0),-1);assert.equal(x.n.aster_ws_send(h,2,0,1),-1);
 assert.equal(x.n.aster_ws_recv(h,5000,4123),-1);
 // Text round trip with payload copied at call time.
 const text='你好 WebSocket',tBuf=Buffer.from(text);tBuf.copy(x.h.bytes(1000,tBuf.length));
 assert.equal(x.n.aster_ws_send(h,1,1000,tBuf.length),0);x.h.bytes(1000,tBuf.length).fill(0x41);
 await drain(x,h,1,tBuf);
 // Binary round trip; empty binary is distinct from no message.
 await roundtrip(x,srv,h,2,Buffer.from(Array.from({length:32},(_,i)=>i)));
 assert.equal(x.n.aster_ws_recv(h,2000,4124),-15); /* empty slot reports EAGAIN */
 assert.equal(x.n.aster_ws_send(h,2,0,0),0);await drain(x,h,2,Buffer.alloc(0));
 // 4096 boundary plus the one bounded send slot (EAGAIN, never lost data).
 const big=Buffer.from(Array.from({length:4096},(_,i)=>(i+17)%251));big.copy(x.h.bytes(1000,4096));
 assert.equal(x.n.aster_ws_send(h,2,1000,4096),0);
 assert.equal(x.n.aster_ws_send(h,2,1000,1),-15);
 x.h.bytes(1000,4096).fill(0);await drain(x,h,2,big);
 assert.equal(state(x,h).sent,4);
 // Invalid UTF-8 text refused with the stable protocol domain.
 const n=put(x,1000,Buffer.from([0xc0,0x80]));assert.equal(x.n.aster_ws_send(h,1,1000,n),-26);
 // One client device-wide: second host refused while the handle lives.
 const otherLen=put(other,100,`ws://127.0.0.1:${srv.port}/echo`);
 assert.equal(other.n.aster_ws_connect(100,otherLen,5000),-11);
 assert.equal(x.n.aster_ws_close(h),0);assert.equal(x.n.aster_ws_status(h,5000,48),-10);await released();
 // Recovery after close: a fresh session works again.
 const h2=open(x,srv);await ready(x,h2);await roundtrip(x,srv,h2,1,Buffer.from('again'));
 assert.equal(x.n.aster_ws_close(h2),0);await released();
});
test('WS head-of-line order preserved; interleaved ping frames auto-pong',async t=>{
 const srv=await peer(t),x=setup(t);const h=open(x,srv,'multi');await ready(x,h);
 for(const [opcode,data] of [[2,Buffer.from([0xa1])],[2,Buffer.from([0xb1,0xb2])],[2,Buffer.alloc(0)],[1,Buffer.from('尾','utf8')]])
  await drain(x,h,opcode,data);
 assert.equal(x.n.aster_ws_recv(h,2000,4124),-15);assert.equal(state(x,h).state,4);
 assert.equal(x.n.aster_ws_close(h),0);await released();
 // Interleaved ping frames: data messages arrive in order, client auto-pongs.
 const h2=open(x,srv,'ping');await ready(x,h2);
 for(const want of [Buffer.from([0xd1]),Buffer.from([0xd2]),Buffer.from([0xd3])])await drain(x,h2,2,want);
 await until(()=>srv.log.pongs>=3);
 assert.equal(x.n.aster_ws_close(h2),0);await released();
});
test('WS connect deadline covers stalled upgrade; cancel semantics; refused port',async t=>{
 const srv=await peer(t),x=setup(t);
 const stalled=open(x,srv,'stall','127.0.0.1',false,400);
 const f=await terminal(x,stalled);assert.equal(f.state,7);assert.equal(f.error,-8);
 assert.equal(x.n.aster_ws_recv(stalled,2000,4124),-8);assert.equal(x.n.aster_ws_send(stalled,1,0,0),-23);
 assert.equal(x.n.aster_ws_cancel(stalled),0); /* terminal cancel stays unchanged */
 assert.equal(state(x,stalled).state,7);
 assert.equal(x.n.aster_ws_close(stalled),0);await released();
 // Cancel while connecting becomes CANCELLED and retains quota until close.
 const slow=open(x,srv,'stall','127.0.0.1',false,9000);
 assert.equal(x.n.aster_ws_cancel(slow),0);await until(()=>state(x,slow).state===8);
 assert.equal(x.n.aster_ws_recv(slow,2000,4124),-19);assert.equal(state(x,slow).error,-19);
 const againLen=put(x,200,`ws://127.0.0.1:${srv.port}/echo`);
 assert.equal(x.n.aster_ws_connect(200,againLen,1000),-11); /* quota retained by terminal */
 assert.equal(x.n.aster_ws_close(slow),0);await released();
 // Refused port: stable connection-refused domain.
 const dead=await new Promise(res=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>res(p));});});
 const refused=open(x,{port:dead},'echo','127.0.0.1',false,3000);
 const rf=await terminal(x,refused);assert.equal(rf.error,-24);
 assert.equal(x.n.aster_ws_close(refused),0);await released();
});
test('WS completed messages remain deliverable through terminal transitions',async t=>{
 const srv=await peer(t),x=setup(t);
 // Peer sends one message then a normal close; the completed message survives
 // ahead of the CLOSED terminal and only then becomes EPIPE.
 const h=open(x,srv,'closemsg');
 await drain(x,h,2,Buffer.from([0x42]));
 await until(()=>{const s=state(x,h);return s.state===6?s:null;});
 assert.equal(x.n.aster_ws_recv(h,2000,4124),-21);
 assert.equal(x.n.aster_ws_close(h),0);await released();
 // Cancel after a completed message that has not been drained: the finished
 // message is delivered first (queued survives into CANCELLED), like firmware.
 const h2=open(x,srv,'buffered-cancel');
 await until(()=>state(x,h2).queued===1); /* one message waiting, not drained */
 assert.equal(x.n.aster_ws_cancel(h2),0);
 assert.equal(state(x,h2).state,8);
 assert.equal(x.n.aster_ws_recv(h2,2000,4124),0); /* completed precedes terminal */
 assert.equal(x.h.u32(2008),2);assert.equal(x.h.u32(2012),1);assert.equal(x.h.bytes(2028,1)[0],0x55);
 assert.equal(x.n.aster_ws_recv(h2,2000,4124),-19); /* then the stable terminal */
 assert.equal(x.n.aster_ws_close(h2),0);await released();
});
test('WS protocol faults map to the stable domain',async t=>{
 const srv=await peer(t),x=setup(t);
 for(const [route,error] of [['oversize',-20],['badutf8',-26],['badaccept',-26]]){
  const h=open(x,srv,route,'127.0.0.1',false,4000);const f=await terminal(x,h);
  assert.equal(f.error,error,route+' expected '+error+' got '+f.error);
  assert.equal(x.n.aster_ws_recv(h,2000,4124),error,route+' recv keeps terminal error');
  assert.equal(x.n.aster_ws_close(h),0);await released();}
});
test('WS peer close: code reported, buffered message delivered first, then EPIPE',async t=>{
 const srv=await peer(t),x=setup(t);
 const h=open(x,srv,'closemsg');
 await drain(x,h,2,Buffer.from([0x42])); /* buffered input precedes the close */
 const f=await until(()=>{const s=state(x,h);return s.state===6?s:null;});
 assert.equal(f.close,1001);assert.equal(f.error,0);
 assert.equal(x.n.aster_ws_recv(h,2000,4124),-21);
 assert.equal(x.n.aster_ws_close(h),0);await released();
 // Plain /close without messages: CLOSED, recv drains to EPIPE.
 const h2=open(x,srv,'close');
 await until(()=>{const s=state(x,h2);return s.state>=6?s:null;});
 assert.equal(state(x,h2).close,1000);
 assert.equal(x.n.aster_ws_recv(h2,2000,4124),-21);
 assert.equal(x.n.aster_ws_close(h2),0);await released();
});
test('WS permission and capability gates',async t=>{
 const srv=await peer(t),x=setup(t);
 x.h.permissions.clear();
 const len=put(x,100,`ws://127.0.0.1:${srv.port}/echo`);
 assert.equal(x.n.aster_ws_connect(100,len,1000),-4);
 x.h.permissions.add('net');
 assert.equal(x.n.aster_ws_connect(100,len,50),-1); /* timeout bounds before capability gate */
 x.h.features.delete(20);
 assert.equal(x.n.aster_ws_connect(100,len,1000),-3);
});
const certDir=process.env.ASTER_WS_TEST_CERTS;
test('WSS real trust, name/date rejection and shared TLS lease with HTTPS',{skip:!certDir},async t=>{
 const read=n=>fs.readFileSync(path.join(certDir,n));
 const good={key:read('server.key'),cert:read('server.pem')};
 const srv=await peer(t,good),x=setup(t,{networkCA:path.join(certDir,'ca.pem')});
 const h=open(x,srv,'echo','localhost',true);await ready(x,h);
 const len=put(x,1000,'tls-echo');assert.equal(x.n.aster_ws_send(h,1,1000,len),0);await drain(x,h,1,Buffer.from('tls-echo'));
 assert.equal(x.n.aster_ws_close(h),0);await released();
 for(const [name,certBit] of [['wrong',4],['expired',1]]){
  const w=await peer(t,{key:read(name+'.key'),cert:read(name+'.pem')});
  const c=setup(t,{networkCA:path.join(certDir,'ca.pem')});
  const id=open(c,w,'echo','localhost',true);const f=await terminal(c,id);
  assert.equal(f.error,-28,name);assert.ok(f.cert&certBit,name+' flags '+f.cert);
  c.n.aster_ws_close(id);await released();}
 // Shared verified-TLS lease: HTTPS is refused EBUSY while a live WSS holds it.
 const s2=await peer(t,good),y=setup(t,{networkCA:path.join(certDir,'ca.pem')});
 const wsid=open(y,s2,'echo','localhost',true);await ready(y,wsid);
 const ul=put(y,100,`https://localhost:${s2.port}/x`);assert.equal(y.n.aster_http_request(1,100,ul,0,0,0,0,1500,64),-5);
 assert.equal(y.n.aster_ws_close(wsid),0);await released();
});
const packageFile=process.env.ASTER_WS_ECHO_AST;
test('actual SDK WS Echo APP imports, content, rendering and stop cleanup',{skip:!packageFile},async t=>{
 const {loadPackage}=require('../src/package');
 const port=Number(process.env.ASTER_WS_TEST_PORT||17880);
 const srv=await peer(t,null,port);
 const h=new Host(loadPackage(packageFile),{network:true});t.after(()=>h.stop());h.start();
 await until(()=>{h.tick();assert.ok(!h.logs.some(x=>x.message.includes('WSAPP FAIL')),JSON.stringify(h.logs));
  return h.logs.some(x=>x.message.includes('WSAPP round=1'));});
 assert.ok(h.presentCount>0);assert.ok(srv.log.opened>=1);
 h.stop();await until(()=>live.size===0);
});
