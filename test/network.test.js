'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),net=require('node:net'),dgram=require('node:dgram');
const {Host}=require('../src/host');
require('../scripts/integration-inputs').requireIntegrationInputs();
const delay=()=>new Promise(r=>setTimeout(r,10));
async function until(fn){for(let i=0;i<300;i++){const value=fn();if(value)return value;await delay();}throw Error('network test deadline');}
function setup(t,permissions=['net'],network=true){const h=new Host({manifest:{id:'test.net',permissions},assets:new Map()},{network});h.memory=new WebAssembly.Memory({initial:1});h.heap=4096;const api=h.imports();t.after(()=>h.stop());h.bytes(100,9).write('127.0.0.1');return {h,api,status:id=>{assert.equal(api.aster_network_status(id,500,56),0);return h.u32(512);}};}
test('real UDP, bounds, atomic datagrams, quota, foreign handles and stop cleanup',async t=>{
 const {h,api,status}=setup(t),b=setup(t);
 assert.equal(api.aster_network_open(2,0,0,1,0),-1);
 assert.equal(api.aster_network_open(1,100,-1,80,10),-1);
 const a=api.aster_network_open(2,0,0,0,0),other=b.api.aster_network_open(2,0,0,0,0);assert.ok(a>0&&other>0);
 await until(()=>status(a)===4&&b.status(other)===4);assert.equal(api.aster_network_open(2,0,0,0,0),-11);
 assert.equal(api.aster_network_close(other),-10);assert.equal(api.aster_network_cancel(other),-10);
 const port=b.h.u32(536);h.bytes(200,5).write('hello');
 assert.equal(api.aster_network_send(a,65535,5,100,9,port),-1);
 assert.equal(api.aster_network_send(a,200,-1,100,9,port),-20);
 assert.equal(api.aster_network_send(a,200,1201,100,9,port),-20);
 assert.equal(api.aster_network_send(a,200,5,100,9,port),5);h.bytes(200,5).fill(0);
 await until(()=>{b.status(other);return b.h.u32(528)===1;});
 assert.equal(b.api.aster_network_recv(other,1000,5,65530,32),-1);
 assert.equal(b.api.aster_network_recv(other,1000,5,1000,32),-1);
 assert.equal(b.api.aster_network_recv(other,1000,5,500,31),-1);
 assert.equal(b.api.aster_network_recv(other,1000,4,500,32),-20);assert.equal(b.h.u32(508),5);
 assert.equal(b.api.aster_network_recv(other,1000,5,500,32),5);assert.equal(b.h.string(1000,5),'hello');assert.equal(b.h.cstring(516),'127.0.0.1');
 assert.equal(b.api.aster_network_recv(other,1000,5,500,32),-15);
 assert.equal(api.aster_network_send(a,0,0,100,9,port),0);await until(()=>{b.status(other);return b.h.u32(528)===1;});assert.equal(b.api.aster_network_recv(other,0,0,500,32),0);
 assert.equal(api.aster_network_cancel(a),0);assert.equal(status(a),7);assert.equal(h.u32(520)|0,-19);
 assert.equal(api.aster_network_close(a),0);assert.equal(api.aster_network_close(a),-10);b.h.stop();assert.equal(b.h.network.host,null);await delay();
 const fresh=api.aster_network_open(2,0,0,0,0);assert.ok(fresh>other);api.aster_network_close(fresh);await delay();
});
test('TCP buffered EOF, byte counts and stable errors',async t=>{
 const server=net.createServer(s=>s.on('data',b=>s.end(b)));server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
 const {h,api,status}=setup(t);const id=api.aster_network_open(1,100,9,server.address().port,2000);await until(()=>status(id)===4);
 h.bytes(200,5).write('hello');assert.equal(api.aster_network_send(id,200,5,0,0,0),5);
 await until(()=>{status(id);return h.u32(528)>0;});assert.equal(api.aster_network_recv(id,1000,2,500,32),2);assert.equal(h.string(1000,2),'he');assert.equal(api.aster_network_recv(id,1000,5,500,32),3);assert.equal(h.string(1000,3),'llo');
 await until(()=>status(id)===5);assert.equal(api.aster_network_recv(id,1000,5,500,32),0);assert.equal(api.aster_network_send(id,200,1,0,0,0),-21);
 api.aster_network_close(id);await delay();
 t.mock.method(require('node:dns').Resolver.prototype,'resolve4',(name,cb)=>queueMicrotask(()=>cb(Object.assign(Error('not found'),{code:'ENOTFOUND'}))));
 h.bytes(100,15).write('missing.invalid');const bad=api.aster_network_open(1,100,15,80,2000);await until(()=>status(bad)===6);assert.equal(h.u32(520)|0,-22);assert.equal(api.aster_network_recv(bad,1000,5,500,32),-22);api.aster_network_close(bad);await delay();
});
test('UDP oversized/full queue, short retry and lifecycle',async t=>{
 const {h,api,status}=setup(t);let id=api.aster_network_open(2,0,0,0,0);await until(()=>status(id)===4);const port=h.u32(536),sender=dgram.createSocket('udp4');t.after(()=>sender.close());
 const send=b=>new Promise((r,j)=>sender.send(b,port,'127.0.0.1',e=>e?j(e):r()));
 await send(Buffer.alloc(1300));await until(()=>{status(id);return h.u32(532)===1;});
 for(let i=0;i<3;i++)await send(Buffer.from([i]));await until(()=>{status(id);return h.u32(532)===2;});
 assert.equal(api.aster_network_recv(id,1000,10,500,32),1);assert.equal(h.bytes(1000,1)[0],0);assert.equal(api.aster_network_recv(id,1000,10,500,32),1);assert.equal(h.bytes(1000,1)[0],1);
 api.aster_network_close(id);await delay();for(let i=0;i<20;i++){id=api.aster_network_open(2,0,0,0,0);assert.ok(id>0);api.aster_network_close(id);await delay();}
});
test('read-only interface info validates before writing and does not take a connection slot',async t=>{
 const {h,api}=setup(t);assert.equal(api.aster_network_get_info(0,44),-1);assert.equal(api.aster_network_get_info(500,43),-1);assert.equal(api.aster_network_get_info(65530,44),-1);
 h.bytes(500,52).fill(0xaa);assert.equal(api.aster_network_get_info(500,52),0);assert.equal(h.u32(500),44);assert.equal(h.u32(504),1);assert.equal(h.u32(528),2);assert.equal(h.u32(536),1200);assert.deepEqual(h.bytes(544,8),Buffer.alloc(8,0xaa));assert.equal(h.network.slots.size,0);
});
test('permissions and explicit host-network opt-in',t=>{
 const denied=setup(t,['wifi']);assert.equal(denied.api.aster_network_open(2,0,0,0,0),-4);assert.equal(denied.api.aster_network_get_info(500,44),-4);
 const off=setup(t,['net'],false);assert.equal(off.api.aster_network_open(2,0,0,0,0),-3);
 assert.throws(()=>new Host({manifest:{id:'test.replay'},assets:new Map()},{network:true,clock:()=>0}),/replay/);
});

test('retired DNS callbacks cannot connect a closed session; quota stays bounded',async t=>{
 const dns=require('node:dns');let late;
 t.mock.method(dns.Resolver.prototype,'resolve4',(name,cb)=>{late=cb;});
 t.mock.method(dns.Resolver.prototype,'cancel',()=>queueMicrotask(()=>late(Object.assign(Error('cancelled'),{code:'ECANCELLED'}))));
 const {h,api,status}=setup(t);h.bytes(100,12).write('pending.test');
 const old=api.aster_network_open(1,100,12,9,2000);assert.equal(status(old),2);
 assert.equal(api.aster_network_close(old),0);
 const next=api.aster_network_open(2,0,0,0,0);assert.ok(next>old);assert.equal(api.aster_network_open(2,0,0,0,0),-11);
 await delay();assert.equal(api.aster_network_status(old,500,56),-10);
 const free=api.aster_network_open(2,0,0,0,0);assert.ok(free>next);late(null,['127.0.0.1']);assert.equal(api.aster_network_status(old,500,56),-10);api.aster_network_close(next);api.aster_network_close(free);await delay();
});

const echoPackage=process.env.ASTER_NETWORK_ECHO_AST;
test('actual SDK TCP/UDP Echo APP validates content and releases its session',{skip:!echoPackage},async t=>{
 const tcp=net.createServer(s=>{let total=0;s.on('error',()=>{});s.on('data',b=>{total+=b.length;s.write(b);if(total>=512)s.end();});});
 const udp=dgram.createSocket('udp4');udp.on('message',(data,p)=>udp.send(data,p.port,p.address));
 tcp.listen(Number(process.env.ASTER_NETWORK_TEST_TCP_PORT||17780),'127.0.0.1');udp.bind(Number(process.env.ASTER_NETWORK_TEST_UDP_PORT||17781),'127.0.0.1');
 await Promise.all([new Promise(r=>tcp.once('listening',r)),new Promise(r=>udp.once('listening',r))]);
 t.after(()=>{tcp.close();udp.close();});
 const {loadPackage}=require('../src/package');
 const h=new Host(loadPackage(echoPackage),{network:true});t.after(()=>h.stop());h.start();
 await until(()=>{h.tick();assert.ok(!h.logs.some(x=>x.message.includes('NETAPP FAIL')),JSON.stringify(h.logs));return h.logs.some(x=>x.message.includes('NETAPP round=1'));});
 await until(()=>{h.tick();return h.exitCode!==null;});h.stop();assert.equal(h.exitCode,0);assert.equal(h.network.slots.size,0);assert.ok(h.presentCount>0);
});
