'use strict';
require('../scripts/integration-inputs').requireIntegrationInputs();
const test=require('node:test'),assert=require('node:assert/strict');
const {Host}=require('../src/host'),{loadPackage}=require('../src/package');
function setup(){
 const h=new Host({manifest:{id:'test.imu',permissions:[]},assets:new Map()});
 h.memory=new WebAssembly.Memory({initial:1});h.heap=4096;let clock=100;h.now=()=>clock;
 const api=h.imports(),out=(size,version=1)=>{const p=h.alloc(size);h.bytes(p,size).fill(0xaa);h.u32(p,size);h.u32(p+4,version);return p;};
 return {h,api,out,time:t=>clock=t,values:p=>Array.from({length:6},(_,i)=>h.bytes(p+24+i*4,4).readFloatLE())};
}
test('ABI 3.7 paired IMU samples, cache TTL and u32 wraparound',t=>{
 const {h,api,out,time,values}=setup();t.after(()=>h.stop());
 assert.equal(api.aster_system_get_abi_version(),0x30b00);
 const info=out(16),sample=out(48);assert.equal(api.aster_imu_get_info(info,16),0);
 assert.equal(h.u32(info+8),3);assert.equal(h.u32(info+12),10);
 h.input({type:'sensor',accel:[1,2,3],gyro:[4,5,6]});
 assert.equal(api.aster_imu_read(sample,48),0);assert.equal(h.bytes(sample+8,8).readBigUInt64LE(),100n);
 assert.equal(h.u32(sample+16),1);assert.equal(h.u32(sample+20),3);assert.deepEqual(values(sample),[1,2,3,4,5,6]);
 const first=Buffer.from(h.bytes(sample,48));h.input({type:'sensor',accel:[7,8,9],gyro:[10,11,12]});
 time(109);assert.equal(api.aster_imu_read(sample,48),0);assert.deepEqual(h.bytes(sample,48),first);
 time(110);assert.equal(api.aster_imu_read(sample,48),0);assert.deepEqual(values(sample),[7,8,9,10,11,12]);
 assert.equal(h.u32(sample+16),2);assert.equal(h.bytes(sample+8,8).readBigUInt64LE(),110n);
 h.imuSequence=0xffffffff;time(120);assert.equal(api.aster_imu_read(sample,48),0);assert.equal(h.u32(sample+16),0);
 time(130);assert.equal(api.aster_imu_read(sample,48),0);assert.equal(h.u32(sample+16),1);
 const xyz=h.alloc(12);assert.equal(api.aster_accel_read(xyz,12),0);assert.equal(h.bytes(xyz,4).readFloatLE(),7);
 assert.equal(api.aster_gyro_read(xyz,12),0);assert.equal(h.bytes(xyz,4).readFloatLE(),10);
});
test('IMU validates before writing and reports missing/invalid channels',t=>{
 const {h,api,out,time}=setup();t.after(()=>h.stop());
 for(const [fn,size] of [[api.aster_imu_get_info,16],[api.aster_imu_read,48]]){
  const p=out(size),original=Buffer.from(h.bytes(p,size));
  assert.equal(fn(p,size-1),-1);assert.deepEqual(h.bytes(p,size),original);
  h.u32(p+4,2);const wrong=Buffer.from(h.bytes(p,size));assert.equal(fn(p,size),-1);assert.deepEqual(h.bytes(p,size),wrong);
  assert.equal(fn(0,size),-1);assert.equal(fn(h.memory.buffer.byteLength-4,size),-1);
  h.u32(p+4,1);h.u32(p,size-1);const short=Buffer.from(h.bytes(p,size));assert.equal(fn(p,size),-1);assert.deepEqual(h.bytes(p,size),short);
  h.u32(p,size);h.features.delete(10);const missing=Buffer.from(h.bytes(p,size));assert.equal(fn(p,size),-16);assert.deepEqual(h.bytes(p,size),missing);h.features.add(10);
 }
 const p=out(48),original=Buffer.from(h.bytes(p,48));h.gyro=[NaN,0,0];time(200);
 assert.equal(api.aster_imu_read(p,48),-7);assert.deepEqual(h.bytes(p,48),original);
 h.gyro=[1e100,0,0];assert.equal(api.aster_imu_read(p,48),-7);
 h.gyro=[0,0,0];assert.equal(api.aster_imu_read(p,48),0);assert.equal(h.u32(p+16),1);
});
test('external SDK ABI 3.7 imucube responds to six-axis motion',{skip:!process.env.ASTER_SIM_IMUCUBE_AST},t=>{
 const pkg=loadPackage(process.env.ASTER_SIM_IMUCUBE_AST);assert.equal(pkg.manifest.abi.min,'3.7');
 const h=new Host(pkg);let clock=100;h.now=()=>clock;h.start();t.after(()=>h.stop());
 for(let i=0;i<4;i++){clock+=34;h.tick();}
 const initial=h.screen.toBuffer('image/png');assert.ok(h.presentCount>0);
 h.input({type:'sensor',accel:[0,0,9.80665],gyro:[0,0,1]});
 for(let i=0;i<30;i++){clock+=34;h.tick();}
 assert.notDeepEqual(h.screen.toBuffer('image/png'),initial);assert.ok(h.imuSample.sequence>1);assert.equal(h.exitCode,null);
});
