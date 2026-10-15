'use strict';
// ABI 3.8. Only copied bytes and numeric endpoint IDs outlive an import call.
const net = require('node:net'), dns = require('node:dns'), dgram = require('node:dgram');
const { performance } = require('node:perf_hooks');
const live = new Set(); let generation = 0;
const ERR = {EINVAL:-1,ENOMEM:-2,ENOTSUP:-3,EPERM:-4,EBUSY:-5,EIO:-7,ETIMEDOUT:-8,EBADF:-10,ENOSPC:-11,EAGAIN:-15,ECANCELED:-19,EMSGSIZE:-20,EPIPE:-21,ENOTFOUND:-22,EAI_AGAIN:-22,ECONNRESET:-23,ENOTCONN:-23,ECONNREFUSED:-24,ENETUNREACH:-25,EHOSTUNREACH:-25};
const mapped = e => ERR[e?.code] || -7;
const unicast = ip => net.isIP(ip)===4 && +ip.split('.')[0]>0 && +ip.split('.')[0]<224;
class Network {
  constructor(host) { this.host=host; this.slots=new Map(); }
  gate() { return !this.host ? -12 : !this.host.permissions.has('net') ? -4 : !this.host.features.has(15) ? -3 : 0; }
  bytes(p,n) { p>>>=0;n>>>=0;if(!p||!n||!this.host.range(p,n))throw Object.assign(Error('network buffer'),{code:'EINVAL'});return this.host.bytes(p,n); }
  hostName(p,n) { if(!n||n>253)throw Object.assign(Error('network host'),{code:'EINVAL'});const b=this.bytes(p,n),s=b.toString('ascii');if([...b].some(c=>c>127)||! /^[a-z0-9.-]+$/i.test(s))throw Object.assign(Error('network host'),{code:'EINVAL'});return s; }
  fail(s,error) { if(s.closing||s.state===6||s.state===7)return;s.state=error===-19?7:6;s.error=error;s.tx=[];s.txQueued=0;clearTimeout(s.timer);if(s.resolver)s.resolver.cancel();if(s.socket){if(s.kind===1)s.socket.destroy();else if(s.bound){s.bound=false;s.socket.close();}} }
  release(s) { if(s.closing&&!s.resolving&&!s.socket)live.delete(s); }
  close(s) { if(!s)return -10;s.closing=true;this.slots.delete(s.id);clearTimeout(s.timer);s.tx=[];s.rx=[];s.txQueued=0;if(s.resolver)s.resolver.cancel();if(s.socket){if(s.kind===1)s.socket.destroy();else if(s.bound){s.bound=false;s.socket.close();}}this.release(s);return 0; }
  stop() { for(const s of [...this.slots.values()])this.close(s); this.host=null; }
  resolve(s,name,done) {
    if(net.isIP(name)===4){if(!unicast(name))this.fail(s,-3);else done(name);return;}
    s.phase=2;s.state=2;s.resolving=true;
    const resolver=s.resolver=new dns.Resolver();
    resolver.resolve4(name,(err,addresses)=>{s.resolving=false;s.resolver=null;const ip=addresses?.[0];if(s.closing){this.release(s);return;}if(s.state===6||s.state===7)return;if(err){this.fail(s,-22);return;}if(!unicast(ip)){this.fail(s,-3);return;}done(ip);});
  }
  timer(s,deadline) { clearTimeout(s.timer);s.timer=setTimeout(()=>this.fail(s,-8),Math.max(0,deadline-performance.now()));s.timer.unref(); }
  open(kind,p,n,port,ms) {
    if(this.gate())return this.gate();[kind,p,n,port,ms]=[kind,p,n,port,ms].map(x=>x>>>0);
    let name;
    if(kind===2){if(p||n||port||ms)return -1;}else if(kind!==1||!port||port>65535||!ms||ms>30000)return -1;else name=this.hostName(p,n);
    if(live.size>=2||generation===0x7fffffff)return -11;
    const s={id:++generation,kind,state:1,phase:1,error:0,tx:[],rx:[],txQueued:0,rxBytes:0n,txBytes:0n,dropped:0,localPort:0,resolving:false,socket:null,bound:false,closing:false};
    live.add(s);this.slots.set(s.id,s);
    if(kind===2){
      const socket=s.socket=dgram.createSocket('udp4');
      socket.on('error',e=>this.fail(s,mapped(e)));
      socket.on('close',()=>{s.socket=null;this.release(s);});
      socket.on('listening',()=>{s.bound=true;if(s.closing||s.state===7||s.state===6){s.bound=false;socket.close();return;}s.localPort=socket.address().port;s.state=4;});
      socket.on('message',(data,peer)=>{if(s.closing||s.state===7||s.state===6)return;if(data.length>1200||s.rx.length===2){s.dropped++;return;}s.rx.push({data:Buffer.from(data),peer});s.rxBytes+=BigInt(data.length);});
      socket.bind(0,'0.0.0.0');
    }else{
      this.timer(s,performance.now()+ms);
      this.resolve(s,name,ip=>{
        s.phase=3;s.state=3;const socket=s.socket=new net.Socket({readableHighWaterMark:2048,writableHighWaterMark:2048});
        socket.on('error',e=>this.fail(s,mapped(e)));
        socket.on('close',()=>{s.socket=null;this.release(s);});
        socket.on('connect',()=>{if(s.closing||s.state===7||s.state===6){socket.destroy();return;}clearTimeout(s.timer);s.state=4;s.localPort=socket.localPort;this.readTcp(s);});
        socket.on('readable',()=>this.readTcp(s));
        socket.on('end',()=>{if(s.closing||s.state===6||s.state===7)return;if(s.txQueued)this.fail(s,-21);else{s.state=5;clearTimeout(s.timer);}});
        socket.connect(port,ip);
      });
    }
    return s.id;
  }
  readTcp(s) {
    if(s.closing||s.state===6||s.state===7||!s.socket)return;
    const used=s.rx.reduce((sum,x)=>sum+x.data.length,0),n=Math.min(2048-used,s.socket.readableLength);
    if(n>0){const data=s.socket.read(n);if(data){s.rx.push({data});s.rxBytes+=BigInt(data.length);}}
  }
  send(h,p,n,hp,hn,port) {
    if(this.gate())return this.gate();[h,p,n,hp,hn,port]=[h,p,n,hp,hn,port].map(x=>x>>>0);
    if(n>2048)return -20;const data=n?this.bytes(p,n):Buffer.alloc(0),s=this.slots.get(h);if(!s)return -10;
    let name;if(s.kind===2){if(n>1200)return -20;if(!port||port>65535)return -1;name=this.hostName(hp,hn);}else if(hp||hn||port)return -1;
    if(s.state===6||s.state===7)return s.error;if(s.state===5)return -21;if(s.state!==4)return -15;
    if(s.kind===1){
      const count=Math.min(n,2048-s.txQueued);if(n&&!count)return -15;if(!count)return 0;
      const copy=Buffer.from(data.subarray(0,count));if(!s.txQueued)this.timer(s,performance.now()+5000);s.txQueued+=count;s.phase=4;
      s.socket.write(copy,e=>{if(s.closing||s.state===6||s.state===7)return;if(e){this.fail(s,mapped(e));return;}s.txQueued-=count;s.txBytes+=BigInt(count);if(!s.txQueued)clearTimeout(s.timer);else this.timer(s,performance.now()+5000);});return count;
    }
    if(s.tx.length===2)return -15;
    s.tx.push({data:Buffer.from(data),name,port,deadline:performance.now()+5000});s.txQueued=s.tx.length;if(s.tx.length===1)this.sendUdp(s);return n;
  }
  sendUdp(s) {
    const q=s.tx[0];if(!q||s.closing||s.state===6||s.state===7)return;this.timer(s,q.deadline);
    this.resolve(s,q.name,ip=>{s.state=4;s.phase=4;if(performance.now()>=q.deadline){this.fail(s,-8);return;}
      s.socket.send(q.data,q.port,ip,e=>{if(s.closing||s.state===6||s.state===7)return;if(e){this.fail(s,mapped(e));return;}s.txBytes+=BigInt(q.data.length);s.tx.shift();s.txQueued=s.tx.length;clearTimeout(s.timer);if(s.tx.length)this.sendUdp(s);});});
  }
  recv(h,p,cap,out,size) {
    if(this.gate())return this.gate();[h,p,cap,out,size]=[h,p,cap,out,size].map(x=>x>>>0);
    if(size<32||cap>2048)return -1;const packet=this.bytes(out,32),data=cap?this.bytes(p,cap):null;
    if(cap&&p<out+32&&out<p+cap)return -1;
    const s=this.slots.get(h);packet.fill(0);packet.writeUInt32LE(32);packet.writeUInt32LE(1,4);if(!s)return -10;if(s.kind===1&&!cap)return -1;
    if(s.kind===1)this.readTcp(s);
    if(!s.rx.length)return s.state===6||s.state===7?s.error:s.state===5?0:-15;
    if(s.kind===2){const q=s.rx[0];packet.writeUInt32LE(q.data.length,8);if(cap<q.data.length)return -20;s.rx.shift();if(q.data.length)q.data.copy(data);packet.writeUInt32LE(q.peer.port,12);packet.write(q.peer.address,16,15,'ascii');return q.data.length;}
    let count=0;while(count<cap&&s.rx.length){const q=s.rx[0],n=Math.min(q.data.length,cap-count);q.data.copy(data,count,0,n);count+=n;if(n===q.data.length)s.rx.shift();else q.data=q.data.subarray(n);}
    packet.writeUInt32LE(count,8);this.readTcp(s);return count;
  }
  info(p,size) {
    if(this.gate())return this.gate();p>>>=0;size>>>=0;if(size<44)return -1;
    const out=this.bytes(p,44),rows=Object.values(require('node:os').networkInterfaces()).flat().filter(x=>x&&x.family==='IPv4');
    const addr=rows.find(x=>!x.internal)||rows[0];out.fill(0);out.writeUInt32LE(44);out.writeUInt32LE(1,4);out.writeUInt32LE(addr?15:0,8);if(addr)out.write(addr.address,12,15,'ascii');
    [2,2048,1200,2].forEach((v,i)=>out.writeUInt32LE(v,28+i*4));return 0;
  }
  status(h,p,size) {
    if(this.gate())return this.gate();[h,p,size]=[h,p,size].map(x=>x>>>0);if(size<56)return -1;const out=this.bytes(p,56),s=this.slots.get(h);if(!s)return -10;
    out.fill(0);[56,1,s.kind,s.state,s.phase,s.error,s.txQueued,s.kind===2?s.rx.length:s.rx.reduce((a,x)=>a+x.data.length,0),s.dropped,s.localPort].forEach((v,i)=>out.writeUInt32LE(v>>>0,i*4));out.writeBigUInt64LE(s.txBytes,40);out.writeBigUInt64LE(s.rxBytes,48);return 0;
  }
  cancel(h) {if(this.gate())return this.gate();const s=this.slots.get(h>>>0);if(!s)return -10;this.fail(s,-19);s.phase=s.state===7?6:s.phase;return 0;}
  imports() {return {aster_network_get_info:this.info.bind(this),aster_network_open:this.open.bind(this),aster_network_send:this.send.bind(this),aster_network_recv:this.recv.bind(this),aster_network_status:this.status.bind(this),aster_network_cancel:this.cancel.bind(this),aster_network_close:h=>this.gate()||this.close(this.slots.get(h>>>0))};}
}
module.exports={Network};
