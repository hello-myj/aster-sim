'use strict';
// N5.5: coalesced network state events in the simulator. Mirrors the firmware
// contract: one pending change per handle (newest wins), bounded to 8 distinct
// handles, delivered one per frame BEFORE the FRAME event (SYS code 3).
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {Host}=require('../src/host');
const {loadPackage}=require('../src/package');
const delay=()=>new Promise(r=>setTimeout(r,5));
async function until(fn){for(let i=0;i<1200;i++){const v=fn();if(v)return v;await delay();}throw Error('deadline');}
function setup(t){
 const file=process.env.ASTER_NET_EVENT_APP;
 const h=new Host(loadPackage(file),{network:true});const a=h.imports();
 // Capture every delivered event before the guest sees it.
 h.delivered=[];const rawCall=h.call.bind(h);
 h.call=(name,...args)=>{
  if(name==='aster_app_event'){
   const base=args[0];
   /* layout: size@0 version@4 type@8 flags@12 timestamp@16 union@24 */
   h.delivered.push({type:h.u32(base+8),code:h.u32(base+24),value:h.u32(base+28),
                     data2:h.u32(base+32),data3:h.u32(base+36)});
  }
  return rawCall(name,...args);
 };
 t.after(()=>h.stop());
 h.start();
 return {h,a};
}
test('net events coalesce per handle: newest state wins, no queue buildup',{skip:!process.env.ASTER_NET_EVENT_APP},t=>{
 const x=setup(t);
 x.h.netEvent(7,3,1); x.h.netEvent(7,3,2); x.h.netEvent(7,3,4);
 assert.equal(x.h.netEvents.size,1);
 assert.equal(x.h.pumpNetEvent(),true);
 assert.equal(x.h.netEvents.size,0);
 /* a repeat of the same state is not a transition */
 x.h.netEvent(7,3,4); x.h.netEvent(7,3,4);
 assert.equal(x.h.pumpNetEvent(),true);
 assert.equal(x.h.pumpNetEvent(),false);
});
test('bounded ring keeps 8 distinct handles and evicts the oldest',{skip:!process.env.ASTER_NET_EVENT_APP},t=>{
 const x=setup(t);
 for(let i=0;i<12;i++)x.h.netEvent(100+i,5,4);
 assert.equal(x.h.netEvents.size,8);
 assert.ok(!x.h.netEvents.has(100),'oldest evicted');
 assert.ok(x.h.netEvents.has(111),'newest kept');
});
test('event is delivered before FRAME with SYS code 3 and handle/state only',{skip:!process.env.ASTER_NET_EVENT_APP},async t=>{
 const srv=http.createServer((req,res)=>res.end('ok'));
 srv.listen(0,'127.0.0.1');await new Promise(r=>srv.once('listening',r));
 t.after(()=>{srv.closeAllConnections();srv.close();});
 const x=setup(t);
 const u=Buffer.from(`http://127.0.0.1:${srv.address().port}/`);
 u.copy(x.h.bytes(100,u.length));
 const id=x.a.aster_http_request(1,100,u.length,0,0,0,0,5000,1024);
 assert.ok(id>0);
 await until(()=>{x.h.tick();return x.h.delivered.some(e=>e.type===5);});
 const ev=x.h.delivered.find(e=>e.type===5);
 assert.equal(ev.code,3,'ASTER_SYS_NET_STATE');
 assert.equal(ev.value,id,'handle only, no payload');
 assert.equal(ev.data2,3,'kind=HTTP');
 assert.ok(ev.data3>=1&&ev.data3<=5,'protocol state number');
 /* the SYS event must precede the FRAME that carries it */
 const idxSys=x.h.delivered.indexOf(ev);
 assert.equal(x.h.delivered[idxSys+1].type,1,'FRAME follows the SYS event');
 x.a.aster_http_close(id);
});