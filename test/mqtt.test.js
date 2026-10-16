'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),net=require('node:net'),tls=require('node:tls'),fs=require('node:fs'),path=require('node:path');
const {Host}=require('../src/host'),{live}=require('../src/network-budget');
const codec=require('../src/mqtt-codec');
require('../scripts/integration-inputs').requireIntegrationInputs();
const delay=()=>new Promise(r=>setTimeout(r,5));
async function until(fn){for(let i=0;i<1600;i++){const v=fn();if(v)return v;await delay();}throw Error('MQTT test deadline');}
function setup(t,options={}){const h=new Host({manifest:{id:'test.mqtt',permissions:['net']},assets:new Map()},{network:true,...options});h.memory=new WebAssembly.Memory({initial:1});const a=h.imports();t.after(async()=>{h.stop();await until(()=>![...live].some(s=>h.mqtt.slots.has(s.id)));await delay();});return {h,a};}
async function broker(t,port=0,tlsOptions=null){let accepts=0;const clients=new Set(),frames=[];
 const accept=socket=>{accepts++;clients.add(socket);let input=Buffer.alloc(0);socket.on('error',()=>{});socket.on('close',()=>clients.delete(socket));
  socket.on('data',b=>{input=Buffer.concat([input,b]);while(input.length>=2){let n=0,m=1,h=1;while(h<input.length){const x=input[h++];n+=(x&127)*m;m*=128;if(!(x&128))break;}if(input.length<h+n)return;
    const type=input[0]>>4,flags=input[0]&15,body=Buffer.from(input.subarray(h,h+n));frames.push({type,body});input=Buffer.from(input.subarray(h+n));
    if(type===1)socket.write(Buffer.from([0x20,2,0,0]));
    else if(type===8)socket.write(Buffer.from([0x90,3,body[0],body[1],body[body.length-1]]));
    else if(type===10)socket.write(Buffer.from([0xb0,2,body[0],body[1]]));
    else if(type===12)socket.write(Buffer.from([0xd0,0]));
    else if(type===3){const len=body.readUInt16BE(0),qos=(flags>>1)&3;if(qos)socket.write(Buffer.from([0x40,2,body[2+len],body[3+len]]));
      let remaining=body.length,header=[0x30|(qos<<1)];do{let v=remaining%128;remaining=Math.floor(remaining/128);header.push(v|(remaining?128:0));}while(remaining);socket.write(Buffer.concat([Buffer.from(header),body]));}
  }});
 };const server=tlsOptions?tls.createServer(tlsOptions,accept):net.createServer(accept);server.on('tlsClientError',()=>{});server.listen(port,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>{for(const c of clients)c.destroy();server.close();});return {port:server.address().port,clients,frames,get accepts(){return accepts;}};
}
function open(x,port,flags=0,hostname="127.0.0.1"){const b=x.h.bytes(101,80);b.fill(0);[80,1,flags,port,5000,5,0,0,201,hostname.length,301,11,0,0,0,0,0,0,0,0].forEach((v,i)=>b.writeUInt32LE(v,i*4));x.h.bytes(201,hostname.length).write(hostname);x.h.bytes(301,11).write('sim-test-id');const h=x.a.aster_mqtt_connect(101,80);assert.ok(h>0,`connect=${h}`);return h;}
function state(x,h){assert.equal(x.a.aster_mqtt_status(h,501,64),0);return x.h.u32(509);}
async function done(x,h,op){assert.ok(op>0);await until(()=>x.a.aster_mqtt_operation(h,op,701)===0);assert.equal(x.h.u32(701)|0,0);}
test('MQTT real wire, UTF-8, binary and empty messages, bounds, ownership, QoS and quotas',async t=>{
 const peer=await broker(t),x=setup(t),other=setup(t),h=open(x,peer.port);
 x.h.bytes(101,300).fill(0);await until(()=>state(x,h)===4);
 assert.equal(other.a.aster_mqtt_close(h),-10);assert.equal(x.a.aster_network_close(h),-10);
 assert.equal(x.a.aster_mqtt_status(h,65535,64),-1);
 x.h.bytes(201,3).write('a/b');await done(x,h,x.a.aster_mqtt_subscribe(h,201,3,1));
 for(const [qos,data] of [[0,Buffer.alloc(0)],[1,Buffer.from([0,1,255])],[1,Buffer.alloc(1024,42)]]){
  if(data.length)data.copy(x.h.bytes(3001,data.length));
  const op=x.a.aster_mqtt_publish(h,201,3,data.length?3001:0,data.length,qos,0);if(data.length)x.h.bytes(3001,data.length).fill(0);
  await done(x,h,op);await until(()=>x.h.mqtt.slots.get(h).messages.length);
  assert.equal(x.a.aster_mqtt_recv(h,65535,1176),-1);assert.equal(x.a.aster_mqtt_recv(h,1001,1175),-1);
  assert.equal(x.a.aster_mqtt_recv(h,1001,1176),0);assert.equal(x.h.u32(1009),data.length);assert.deepEqual(x.h.bytes(1153,data.length),data);assert.equal(x.a.aster_mqtt_recv(h,1001,1176),-15);
 }
 assert.equal(x.a.aster_mqtt_publish(h,201,3,3001,1025,0,0),-20);
 assert.equal(x.a.aster_mqtt_publish(h,201,3,0,0,2,0),-1);
 await done(x,h,x.a.aster_mqtt_unsubscribe(h,201,3));
 const udp=other.a.aster_network_open(2,0,0,0,0);assert.ok(udp>h);assert.equal(other.a.aster_network_open(2,0,0,0,0),-11);
 assert.equal(x.a.aster_mqtt_close(h),0);assert.equal(x.a.aster_mqtt_status(h,501,64),-10);other.a.aster_network_close(udp);
 await until(()=>live.size===0);assert.ok(peer.frames.some(f=>f.type===14));
});
test('MQTT reconnect restores filters, cancellation, terminal quota and APP cleanup',async t=>{
 const peer=await broker(t),x=setup(t),h=open(x,peer.port,2);await until(()=>state(x,h)===4);
 x.h.bytes(201,3).write('a/+');await done(x,h,x.a.aster_mqtt_subscribe(h,201,3,1));
 for(const s of peer.clients)s.destroy();await until(()=>x.h.mqtt.slots.get(h).reconnects>0&&state(x,h)===4&&x.h.mqtt.slots.get(h).filters.get('a/+').active);
 assert.ok(peer.accepts>=2);assert.equal(x.a.aster_mqtt_cancel(h),0);assert.equal(state(x,h),7);assert.equal(x.a.aster_mqtt_recv(h,1001,1176),-19);assert.equal(live.size,1);
 x.h.stop();assert.equal(x.h.mqtt.slots.size,0);await until(()=>live.size===0);
});
test('MQTT permission/capability and malformed frames',async t=>{
 const x=setup(t);x.h.permissions.clear();assert.equal(x.a.aster_mqtt_connect(0,0),-4);x.h.permissions.add('net');x.h.features.delete(19);assert.equal(x.a.aster_mqtt_connect(0,0),-3);
 assert.throws(()=>codec.text(Buffer.from([0xc0,0x80])),/EINVAL/);assert.throws(()=>codec.text(Buffer.from('a/#/b'),true),/EINVAL/);
 assert.throws(()=>codec.decode(Buffer.from([0x90,3,0,0,1])),/EPROTO/);assert.throws(()=>codec.decode(Buffer.from([0x20,2,1,0])),/EPROTO/);
 assert.throws(()=>codec.decode(Buffer.from([0x30,0xff,0x7f])),/EMSGSIZE/);assert.equal(codec.decode(Buffer.from([0x20,2,0])),null);
});
const packageFile=process.env.ASTER_MQTT_ECHO_AST;
test('actual SDK MQTT Echo APP imports, content, rendering and stop cleanup',{skip:!packageFile},async t=>{
 const peer=await broker(t,1883);
 const {loadPackage}=require('../src/package');
 const h=new Host(loadPackage(packageFile),{network:true});t.after(()=>h.stop());h.start();
 await until(()=>{h.tick();assert.ok(!h.logs.some(x=>x.message.includes('MQTTAPP FAIL')),JSON.stringify(h.logs));return h.logs.some(x=>x.message.includes('MQTTAPP round=1'));});
 assert.ok(h.presentCount>0);assert.ok(peer.frames.some(f=>f.type===3));h.stop();await until(()=>live.size===0);
});

const certDir=process.env.ASTER_MQTT_TEST_CERTS;
test('MQTTS real trust/name rejection, shared HTTPS TLS lease and recovery',{skip:!certDir},async t=>{
 const read=n=>fs.readFileSync(path.join(certDir,n));
 const peer=await broker(t,0,{key:read('server.key'),cert:read('server.pem'),minVersion:'TLSv1.2',maxVersion:'TLSv1.2'});
 const x=setup(t,{networkCA:path.join(certDir,'ca.pem')});
 let h=open(x,peer.port,1,'localhost');await until(()=>state(x,h)===4);
 x.h.bytes(4001,24).write('https://localhost:9999/xx');
 assert.equal(x.a.aster_http_request(1,4001,24,0,0,0,0,1000,100),-5);
 const other=setup(t,{networkCA:path.join(certDir,'ca.pem')});
 assert.throws(()=>open(other,peer.port,1,'localhost'),/connect=-5/);
 assert.equal(x.a.aster_mqtt_close(h),0);await until(()=>live.size===0);
 h=open(x,peer.port,1);await until(()=>state(x,h)===6);assert.equal(x.h.u32(513)|0,-28);assert.equal(x.h.u32(557),4);x.a.aster_mqtt_close(h);await until(()=>live.size===0);
 h=open(other,peer.port,1,'localhost');await until(()=>state(other,h)===4);other.a.aster_mqtt_close(h);await until(()=>live.size===0);
 const untrusted=setup(t);h=open(untrusted,peer.port,1,'localhost');await until(()=>state(untrusted,h)===6);assert.equal(untrusted.h.u32(513)|0,-28);assert.ok(untrusted.h.u32(557));untrusted.a.aster_mqtt_close(h);await until(()=>live.size===0);
});
