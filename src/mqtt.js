'use strict';
// ABI 3.11. MQTT 3.1.1 with bounded queues, shared admission and real sockets.
const net=require('node:net'),tls=require('node:tls'),dns=require('node:dns');
const fs=require('node:fs'),path=require('node:path');
const {live,allocate}=require('./network-budget'),codec=require('./mqtt-codec');
const fail=codec.bad;
const mapped=e=>({EINVAL:-1,EMSGSIZE:-20,EPROTO:-26,ENOTFOUND:-22,EAI_AGAIN:-22,ECONNRESET:-23,ECONNREFUSED:-24,EPIPE:-21,ENETUNREACH:-25,EHOSTUNREACH:-25,ETIMEDOUT:-8}[e.code]||-7);
class Mqtt {
  constructor(host){this.host=host;this.slots=new Map();this.ca=fs.readFileSync(host.options.networkCA||path.join(__dirname,'isrg-root-x1.pem'));}
  gate(){return !this.host?-12:!this.host.permissions.has('net')?-4:!this.host.features.has(19)?-3:0;}
  bytes(p,n){return this.host.network.bytes(p>>>0,n>>>0);}
  text(p,n,max,optional=false){if(!n){if(optional&&!p)return null;throw fail('EINVAL');}if(n>max)throw fail('EINVAL');return codec.text(this.bytes(p,n));}
  blob(p,n,max){if(n>max||!n&&p)throw fail('EINVAL');return n?Buffer.from(this.bytes(p,n)):Buffer.alloc(0);}
  connect(p,size){
    if(this.gate())return this.gate();p>>>=0;size>>>=0;if(size<80)return -1;
    const b=Buffer.from(this.bytes(p,80)),v=Array.from({length:20},(_,i)=>b.readUInt32LE(i*4));
    if(v[0]!==80||v[1]!==1||v[2]&~7||!v[3]||v[3]>65535||v[4]<100||v[4]>30000||v[5]<5||v[5]>300||v[6]>1||v[7])return -1;
    const o={host:this.text(v[8],v[9],253),client:this.text(v[10],v[11],64),user:this.text(v[12],v[13],128,true),password:this.blob(v[14],v[15],128),
      willTopic:this.text(v[16],v[17],128,true),will:this.blob(v[18],v[19],256),tls:!!(v[2]&1),reconnect:!!(v[2]&2),willRetain:!!(v[2]&4),willQos:v[6],port:v[3],timeout:v[4],keepalive:v[5]};
    if(!/^[A-Za-z0-9.-]+$/.test(o.host)||o.password.length&&o.user===null||!o.willTopic&&(o.will.length||o.willQos||o.willRetain))return -1;
    if(net.isIP(o.host)===4){const a=+o.host.split('.')[0];if(!a||a>=224)return -1;}
    if(o.willTopic)codec.text(Buffer.from(o.willTopic),false);
    if(o.tls&&!this.host.features.has(17))return -3;
    if(o.tls&&[...live].some(s=>s.httpTls))return -5;
    const id=allocate();if(!id)return -11;
    const s={id,o,httpTls:o.tls,state:1,error:0,cert:0,connack:0,reconnects:0,backoff:1000,input:Buffer.alloc(0),messages:[],operations:[],filters:new Map(),completions:[],seq:0,pid:0,received:0,sent:0,last:0,lastKind:0,lastError:0,socket:null,closing:false,ping:0,lastTx:Date.now()};
    this.slots.set(id,s);live.add(s);s.timer=setInterval(()=>this.tick(s),25);s.timer.unref();this.begin(s);return id;
  }
  release(s){if(s.closing&&!s.socket&&!s.resolving){clearInterval(s.timer);live.delete(s);}}
  finish(s,error,permanent=false){
    if(s.closing||s.state>=6)return;
    s.error=error;while(s.operations.length)this.complete(s,error);
    for(const f of s.filters.values())f.active=false;
    s.input=Buffer.alloc(0);s.ping=0;s.socket?.destroy();s.resolver?.cancel();
    if(s.o.reconnect&&!permanent){s.state=5;s.retry=Date.now()+s.backoff;s.backoff=Math.min(30000,s.backoff*2);}else s.state=6;
  }
  begin(s){
    if(s.closing||s.socket||s.resolving)return;
    s.state=1;s.deadline=Date.now()+s.o.timeout;s.input=Buffer.alloc(0);s.ping=0;
    const lookup=(hostname,options,done)=>{
      s.resolving=true;s.resolver=new dns.Resolver();s.resolver.resolve4(hostname,(e,ips)=>{s.resolving=false;s.resolver=null;
        if(s.closing||s.state>=5){this.release(s);done(fail('ECANCELED'));return;}
        if(e){done(e);return;}const ip=ips?.[0],a=+ip?.split('.')[0];if(!ip||!a||a>=224){done(fail('EHOSTUNREACH'));return;}
        done(null,options.all?[{address:ip,family:4}]:ip,4);});};
    const options={host:s.o.host,port:s.o.port,family:4,lookup,highWaterMark:1536,
      ...(s.o.tls?{ca:this.ca,rejectUnauthorized:true,minVersion:'TLSv1.2',maxVersion:'TLSv1.2',...(net.isIP(s.o.host)?{}:{servername:s.o.host}),checkServerIdentity:(_h,c)=>tls.checkServerIdentity(s.o.host,c)}:{})};
    const socket=s.socket=(s.o.tls?tls.connect:net.connect)(options);
    socket.setNoDelay(true);
    if(s.o.tls)socket.on('connect',()=>{if(!s.closing&&s.state===1)s.state=2;});
    socket.once(s.o.tls?'secureConnect':'connect',()=>{if(s.closing||s.state>=5)return; s.state=3;this.write(s,codec.connect(s.o));});
    socket.on('readable',()=>this.tick(s));socket.on('drain',()=>this.tick(s));
    socket.on('end',()=>this.finish(s,-23));
    socket.on('error',e=>{if(s.closing)return;
      const cert={CERT_HAS_EXPIRED:1,CERT_REVOKED:2,ERR_TLS_CERT_ALTNAME_INVALID:4,UNABLE_TO_VERIFY_LEAF_SIGNATURE:8,SELF_SIGNED_CERT_IN_CHAIN:8,DEPTH_ZERO_SELF_SIGNED_CERT:8,UNABLE_TO_GET_ISSUER_CERT_LOCALLY:8,CERT_NOT_YET_VALID:16}[e.code];
      if(cert||/CERT|ISSUER|INVALID_CA|SELF_SIGNED/.test(e.code||'')){s.cert=cert||64;this.finish(s,-28,true);}
      else this.finish(s,/^ERR_(SSL|TLS)_/.test(e.code||'')?-27:mapped(e));});
    socket.on('close',()=>{if(s.socket===socket)s.socket=null;if(!s.closing&&s.state<5)this.finish(s,-23);this.release(s);});
  }
  write(s,b){if(!s.socket||s.socket.destroyed||s.socket.writableLength)return false;s.socket.write(b);s.lastTx=Date.now();return true;}
  complete(s,error){const o=s.operations.shift();if(!o)return;
    if(o.kind===2||o.kind===3){const f=s.filters.get(o.topic);if(!error){if(o.kind===3)s.filters.delete(o.topic);else{f.confirmed=true;f.active=true;}}else if(!f?.confirmed)s.filters.delete(o.topic);}
    if(!o.auto){s.last=o.seq;s.lastKind=o.kind;s.lastError=error;s.completions.push([o.seq,error]);if(s.completions.length>4)s.completions.shift();}
  }
  enqueue(s,kind,topic,qos,data,retain,auto=false){if(s.state!==4)return -23;if(s.operations.length>=2)return -15;if(s.seq===0x7fffffff)return -11;
    const id=s.pid=s.pid%65535+1,seq=++s.seq;
    const wire=kind===1?codec.publish(topic,data,qos,retain,id):codec.subscription(topic,qos,id,kind===3);
    s.operations.push({kind,topic,qos,wire,id,seq,auto,sent:0});return seq;
  }
  packet(s,p){
    if(s.state===3){if(p.type!==2)throw fail();s.connack=p.code;if(p.code){this.finish(s,-4,true);return true;}s.state=4;s.error=0;s.backoff=1000;return true;}
    if(s.state!==4||p.type===2)throw fail();
    if(p.type===13){if(!s.ping)throw fail();s.ping=0;return true;}
    if(p.type===3){if(s.messages.length===2||p.qos&&s.socket.writableLength)return false;
      if(p.qos&&!this.write(s,Buffer.from([0x40,2,p.id>>8,p.id&255])))return false;
      s.messages.push({topic:Buffer.from(p.topic),data:Buffer.from(p.data),qos:p.qos,flags:(p.retain?1:0)|(p.dup?2:0)});s.received++;return true;}
    const o=s.operations[0];if(!o?.sent||o.id!==p.id)throw fail();
    if(p.type===4&&o.kind===1&&o.qos===1){s.sent++;this.complete(s,0);}
    else if(p.type===9&&o.kind===2){if(p.code!==128&&p.code>o.qos)throw fail();if(p.code!==128)s.filters.get(o.topic).qos=p.code;
      if(p.code===128&&o.auto)this.finish(s,-4,true);else this.complete(s,p.code===128?-4:0);}
    else if(p.type===11&&o.kind===3)this.complete(s,0);else throw fail();return true;
  }
  tick(s){
    if(s.closing||s.state>=6)return;const now=Date.now();
    if(s.state===5){if(now>=s.retry&&!s.socket&&!s.resolving){s.reconnects++;this.begin(s);}return;}
    if(s.state<4&&now>=s.deadline){this.finish(s,-8);return;}
    try{
      // Pause packet consumption on bounded APP queue pressure; do not overwrite.
      for(let i=0;i<4;i++){
        const p=codec.decode(s.input);
        if(p){if(!this.packet(s,p))break;s.input=Buffer.from(s.input.subarray(p.length));continue;}
        const n=Math.min(1536-s.input.length,s.socket?.readableLength||0);if(!n)break;
        const b=s.socket.read(n);if(!b)break;s.input=Buffer.concat([s.input,b]);
      }
      if(s.state!==4)return;
      for(const [topic,f] of s.filters){if(f.confirmed&&!f.active&&!s.operations.some(o=>o.topic===topic)&&s.operations.length<2)this.enqueue(s,2,topic,f.qos,null,false,true);}
      const o=s.operations[0];
      if(o?.sent&&now-o.sent>=10000||s.ping&&now-s.ping>=s.o.keepalive*1000){this.finish(s,-8);return;}
      if(o&&!o.sent&&this.write(s,o.wire)){o.sent=now;if(o.kind===1&&!o.qos){s.sent++;this.complete(s,0);}}
      if(!s.ping&&now-s.lastTx>=s.o.keepalive*1000&&this.write(s,Buffer.from([0xc0,0])))s.ping=now;
    }catch(e){this.finish(s,mapped(e),true);}
  }
  status(h,p,size){if(this.gate())return this.gate();if((size>>>0)<64)return -1;const out=this.bytes(p,64),s=this.slots.get(h>>>0);if(!s)return -10;
    out.fill(0);[64,1,s.state,s.error,s.reconnects,s.messages.length,s.operations.length,[...s.filters.values()].filter(f=>f.active).length,s.received,s.sent,s.connack,s.last,s.lastKind,s.lastError,s.cert,0].forEach((v,i)=>out.writeUInt32LE(v>>>0,i*4));return 0;}
  publish(h,p,n,d,length,qos,retain){if(this.gate())return this.gate();[h,p,n,d,length,qos,retain]=[h,p,n,d,length,qos,retain].map(x=>x>>>0);if(length>1024)return -20;if(qos>1||retain>1)return -1;
    const topic=this.text(p,n,128);codec.text(Buffer.from(topic),false);const data=this.blob(d,length,1024),s=this.slots.get(h);return s?this.enqueue(s,1,topic,qos,data,retain):-10;}
  subscribe(h,p,n,qos,remove=false){if(this.gate())return this.gate();qos>>>=0;if(qos>1)return -1;const topic=this.text(p>>>0,n>>>0,128);codec.text(Buffer.from(topic),true);const s=this.slots.get(h>>>0);if(!s)return -10;
    if(s.state!==4)return -23;if(s.operations.length===2)return -15;
    if(s.operations.some(o=>o.kind!==1&&o.topic===topic))return -5;
    if(remove&&!s.filters.has(topic))return -6;
    if(!remove&&!s.filters.has(topic)&&s.filters.size>=4)return -11;
    const old=s.filters.get(topic),rc=this.enqueue(s,remove?3:2,topic,qos,null,false);
    if(rc>0&&!remove)s.filters.set(topic,{qos:old?.confirmed?old.qos:qos,confirmed:!!old?.confirmed,active:!!old?.active});return rc;}
  operation(h,seq,p){if(this.gate())return this.gate();const out=this.bytes(p,4),s=this.slots.get(h>>>0);if(!s)return -10;seq>>>=0;if(!seq)return -1;
    if(s.operations.some(o=>o.seq===seq&&!o.auto))return -15;const v=s.completions.find(v=>v[0]===seq);if(!v)return -6;out.writeInt32LE(v[1]);return 0;}
  recv(h,p,size){if(this.gate())return this.gate();if((size>>>0)<1176)return -1;const out=this.bytes(p,1176),s=this.slots.get(h>>>0);if(!s)return -10;const m=s.messages.shift();if(!m)return s.state>=6?s.error:-15;
    out.fill(0);[1176,1,m.data.length,m.topic.length,m.qos,m.flags].forEach((v,i)=>out.writeUInt32LE(v,i*4));m.topic.copy(out,24);m.data.copy(out,152);this.tick(s);return 0;}
  cancel(h){if(this.gate())return this.gate();const s=this.slots.get(h>>>0);if(!s)return -10;this.finish(s,-19,true);s.state=7;s.error=-19;return 0;}
  close(s){if(!s)return -10;s.closing=true;this.slots.delete(s.id);clearInterval(s.timer);s.resolver?.cancel();s.messages=[];s.operations=[];
    const socket=s.socket;if(socket&&!socket.destroyed){if(s.state===4)socket.end(Buffer.from([0xe0,0]));else socket.destroy();const timer=setTimeout(()=>socket.destroy(),1500);timer.unref();socket.once('close',()=>clearTimeout(timer));}
    this.release(s);return 0;}
  stop(){for(const s of [...this.slots.values()])this.close(s);this.host=null;}
  imports(){return {aster_mqtt_connect:this.connect.bind(this),aster_mqtt_status:this.status.bind(this),aster_mqtt_publish:this.publish.bind(this),aster_mqtt_subscribe:this.subscribe.bind(this),aster_mqtt_unsubscribe:(h,p,n)=>this.subscribe(h,p,n,0,true),aster_mqtt_operation:this.operation.bind(this),aster_mqtt_recv:this.recv.bind(this),aster_mqtt_cancel:this.cancel.bind(this),aster_mqtt_close:h=>this.gate()||this.close(this.slots.get(h>>>0))};}
}
module.exports={Mqtt};
