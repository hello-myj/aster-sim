'use strict';
// ABI 3.12. Real RFC6455 WebSocket/WSS over the same two transport slots and
// one verified-TLS lease shared with TCP/UDP/HTTP/MQTT; one client per device.
// Public semantics mirror the firmware service and use the public state space
// (CONNECTING=1 TLS=2 UPGRADE=3 READY=4 CLOSED=6 FAILED=7 CANCELLED=8; the
// transient internal CLOSING=5 grace is not observable in the simulator). A
// bounded receive queue holds whole messages; the socket is paused as soon as
// one is undrained so TCP backpressure reaches the peer instead of the client
// allocating for a remote-declared length. Empty message is distinct from no
// message. A terminal handle tears down the socket and frees the two-slot
// transport, but keeps its handle and the device-wide WS client quota until
// close or APP stop. Stop/trap cleanup releases everything.
const net=require('node:net'),tls=require('node:tls'),dns=require('node:dns'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {live,allocate}=require('./network-budget');
const {WebSocket}=require('ws');
const STATUS=48,MESSAGE=4124,DATA=28,QUEUE_MAX=8;
// Device-wide single WebSocket client, shared across APP host instances (the
// diagnostic CLI the simulator does not model). Held from a successful connect
// until that handle is closed or the host stops.
let wsClient=null;
const takeWs=owner=>wsClient?null:(wsClient=owner,owner);
const releaseWs=owner=>{if(wsClient===owner)wsClient=null;};
const fail=e=>Object.assign(Error('ws'),{code:e});
const mapped=e=>({EINVAL:-1,EMSGSIZE:-20,EPROTO:-26,ENOTFOUND:-22,EAI_AGAIN:-22,ECONNRESET:-23,ECONNREFUSED:-24,EPIPE:-21,ENETUNREACH:-25,EHOSTUNREACH:-25,ETIMEDOUT:-8}[e]??-7);
const certMap={CERT_HAS_EXPIRED:1,CERT_REVOKED:2,ERR_TLS_CERT_ALTNAME_INVALID:4,UNABLE_TO_VERIFY_LEAF_SIGNATURE:8,
  SELF_SIGNED_CERT_IN_CHAIN:8,DEPTH_ZERO_SELF_SIGNED_CERT:8,UNABLE_TO_GET_ISSUER_CERT_LOCALLY:8,CERT_NOT_YET_VALID:16};
const utf8=b=>{try{new TextDecoder('utf-8',{fatal:true}).decode(b);return true;}catch{return false;}};
function parse(text){
  if(!text||Buffer.byteLength(text)>1024||/[\x00-\x20\x7f-\xff\\]/.test(text))throw fail('EINVAL');
  const m=/^(ws|wss):\/\/([a-z0-9][a-z0-9.-]*)(?::([0-9]+))?((?:\/[^\x00-\x20\x7f\x23]*)?)$/i.exec(text);
  if(!m)throw fail('EINVAL');
  const u={tls:/^wss$/i.test(m[1]),host:m[2],port:m[3]!==undefined?(+m[3]):0,path:m[4]||'/'};
  if(u.host.length>253||/^[.-]|[.-]$|\.\./.test(u.host)||u.host.includes(':'))throw fail('EINVAL');
  if(m[3]!==undefined&&(u.port<1||u.port>65535))throw fail('EINVAL');
  if(!u.port)u.port=u.tls?443:80;
  if(net.isIP(u.host)===4){const a=+u.host.split('.')[0];if(!a||a>=224)throw fail('EINVAL');}
  return u;
}
class Ws {
  constructor(host){this.host=host;this.slots=new Map();
    this.ca=host.options.networkCA?fs.readFileSync(host.options.networkCA):fs.readFileSync(path.join(__dirname,'isrg-root-x1.pem'));}
  gate(){return !this.host?-12:!this.host.permissions.has('net')?-4:!this.host.features.has(20)?-3:0;}
  bytes(p,n){return this.host.network.bytes(p,n);}
  static terminal(s){return s.state>=6;}
  mark(s,st){if(s.state===st)return;s.state=st;this.host.netEvent(s.id,5,st);}
  drop(s){if(s.freed)return;s.freed=true;live.delete(s);}
  fault(s,error){if(s.closing||Ws.terminal(s))return;
    /* Completed messages stay deliverable through the terminal state, exactly
     * as the firmware recv checks the buffered message before the error. */
    this.mark(s,7);s.error=error;s.sending=undefined;s.pending=false;
    try{s.client?.terminate();}catch{}s.socket=null;this.drop(s);}
  connect(p,n,timeout){
    if(this.gate())return this.gate();[p,n,timeout]=[p,n,timeout].map(x=>x>>>0);
    if(!n||n>1024||!timeout||timeout<100||timeout>30000)return -1;
    let u;try{u=parse(this.bytes(p,n).toString('ascii'));}catch(e){return mapped(e.code);}
    if(u.tls&&!this.host.features.has(17))return -3;
    if(takeWs(this)!==this)return -11; /* one WebSocket client device-wide */
    if(u.tls&&[...live].some(s=>s.httpTls)){releaseWs(this);return -5;} /* shared TLS lease */
    const id=allocate();if(!id){releaseWs(this);return -11;} /* both transport slots in use */
    const s={id,u,ws:true,httpTls:u.tls,timeout,state:1,error:0,cert:0,pending:false,
      received:0,sent:0,close_code:0,queue:[],resolving:false,resolver:null,
      socket:null,client:null,closing:false,freed:false,
      deadline:Date.now()+timeout,lastRx:Date.now(),pingAt:0,flushAt:0,timer:null};
    live.add(s);this.slots.set(id,s);s.timer=setInterval(()=>this.tick(s),25);s.timer.unref();this.begin(s);return id;
  }
  begin(s){
    if(s.closing||Ws.terminal(s))return;
    this.mark(s,1);s.deadline=Date.now()+s.timeout;s.lastRx=Date.now();
    const lookup=(hostname,options,done)=>{
      if(hostname==='localhost'){done(null,options.all?[{address:'127.0.0.1',family:4}]:'127.0.0.1',4);return;}
      if(net.isIP(hostname)){done(null,options.all?[{address:hostname,family:4}]:hostname,4);return;}
      s.resolving=true;s.resolver=new dns.Resolver();s.resolver.resolve4(hostname,(e,ips)=>{
        s.resolving=false;s.resolver=null;
        if(s.closing||Ws.terminal(s)){this.drop(s);done(fail('ECANCELED'));return;}
        if(e){done(e);return;}const ip=ips?.[0],a=ip?+ip.split('.')[0]:0;
        if(!a||a>=224){done(fail('EHOSTUNREACH'));return;}
        done(null,options.all?[{address:ip,family:4}]:ip,4);});};
    const target=`ws${s.u.tls?'s':''}://${s.u.host}:${s.u.port}${s.u.path}`;
    const options={family:4,lookup,maxPayload:65535,perMessageDeflate:false,
      ...(s.u.tls?{ca:this.ca,rejectUnauthorized:true,minVersion:'TLSv1.2',maxVersion:'TLSv1.2',
        ...(net.isIP(s.u.host)?{}:{servername:s.u.host}),
        checkServerIdentity:(h,c)=>tls.checkServerIdentity(s.u.host,c)}:{})};
    const client=s.client=new WebSocket(target,options);
    client.on('socket',socket=>{s.socket=socket;
      if(s.u.tls)socket.once('connect',()=>{if(!s.closing&&s.state===1)this.mark(s,2);});
      socket.once(s.u.tls?'secureConnect':'connect',()=>{if(!s.closing&&s.state<4)this.mark(s,s.u.tls?2:3);});});
    client.on('open',()=>{if(s.closing||Ws.terminal(s))return;this.mark(s,4);s.error=0;s.lastRx=Date.now();});
    client.on('message',(data,isBinary)=>{s.lastRx=Date.now();
      if(s.closing||Ws.terminal(s))return;
      const buffer=Buffer.from(data),opcode=isBinary?2:1;
      if(!isBinary&&!utf8(buffer)){this.fault(s,-26);return;}
      if(buffer.length>4096){this.fault(s,-20);return;} /* never buffer for remote length */
      if(s.queue.length>=QUEUE_MAX){this.fault(s,-11);return;} /* bounded queue, explicit */
      s.queue.push({opcode,data:buffer});s.received++;
      /* Pause on the first undrained message, like the firmware stopping its
       * transport read; frames already inside Node's chunk are absorbed by
       * the bounded queue, then TCP backpressure reaches the peer. */
      if(s.socket)s.socket.pause();});
    client.on('ping',d=>{s.lastRx=Date.now();try{client.pong(d);}catch{}});
    client.on('pong',()=>{s.lastRx=Date.now();s.pingAt=0;});
    client.on('close',code=>{s.socket=null;this.drop(s);
      if(s.closing||Ws.terminal(s))return;
      if(code===1009)this.fault(s,-20);
      else if(code===1002||code===1007||code===1008)this.fault(s,-26);
      else if(code===1006)this.fault(s,-23);
      else{this.mark(s,6);s.error=0;s.close_code=code||1005;s.queue=s.queue.filter(()=>false);}});
    client.on('unexpected-response',(_req,res)=>{res.destroy();this.fault(s,-26);});
    client.on('error',e=>{if(s.closing||Ws.terminal(s))return;
      const cert=certMap[e.code];
      if(cert||/CERT|ISSUER|INVALID_CA|SELF_SIGNED/.test(e.code||'')){s.cert=cert||64;this.fault(s,-28);return;}
      if(/^ERR_(SSL|TLS)_/.test(e.code||'')){this.fault(s,-27);return;}
      /* Node ws surfaces frame/upgrade violations as typed errors before the
       * socket close; map the protocol family to the stable domain. */
      if(e.code==='WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'){this.fault(s,-20);return;}
      if(typeof e.code==='string'&&e.code.startsWith('WS_ERR_')){this.fault(s,-26);return;}
      if(s.state<4&&/Sec-WebSocket-Accept|Invalid WebSocket|Invalid HTTP|Invalid character/i.test(e.message||'')){this.fault(s,-26);return;}
      this.fault(s,s.state<4?mapped(e.code):(e.code==='ECONNRESET'?-23:mapped(e.code)));});
  }
  tick(s){
    if(s.closing||Ws.terminal(s))return;const now=Date.now();
    if(s.state<4&&now>=s.deadline){this.fault(s,-8);return;}
    if(s.sending&&now-s.flushAt>=10000){s.sending=undefined;s.pending=false;this.fault(s,-8);}
    if(s.state===4){
      if(s.pingAt&&now-s.pingAt>=10000){this.fault(s,-8);return;}
      if(!s.pingAt&&now-s.lastRx>=15000){
        try{s.client?.ping(crypto.randomBytes(4));s.pingAt=now;}catch{this.fault(s,-23);}}}
  }
  send(h,opcode,p,n){
    if(this.gate())return this.gate();[h,opcode,p,n]=[h,opcode,p,n].map(x=>x>>>0);
    if(opcode!==1&&opcode!==2)return -1;if(n>4096)return -20;if(!n&&p)return -1;
    const data=n?Buffer.from(this.bytes(p,n)):Buffer.alloc(0);
    if(opcode===1&&!utf8(data))return -26;
    const s=this.slots.get(h);if(!s)return -10;
    if(s.state!==4)return -23; /* firmware ENOTCONN for any non-READY state */
    if(s.sending)return -15;   /* one bounded outgoing slot; retry on a later event */
    s.sending={opcode,data};s.pending=true;s.flushAt=Date.now();
    this.write(s);return 0;
  }
  write(s){
    if(!s.sending||!s.client||s.client.readyState!==WebSocket.OPEN)return;
    const {opcode,data}=s.sending;
    try{s.client.send(data,{binary:opcode===2},e=>{
      if(s.closing||Ws.terminal(s)){s.sending=undefined;s.pending=false;return;}
      if(e){s.sending=undefined;s.pending=false;this.fault(s,-23);return;}
      s.sending=undefined;s.pending=false;s.sent++;});}
    catch{s.sending=undefined;s.pending=false;this.fault(s,-23);}}
  status(h,p,size){
    if(this.gate())return this.gate();[h,p,size]=[h,p,size].map(x=>x>>>0);
    if(size<STATUS)return -1;const out=this.bytes(p,STATUS),s=this.slots.get(h);if(!s)return -10;
    out.fill(0);
    [STATUS,1,s.state,s.state>=6?s.error:0,s.queue.length?1:0,s.sending?1:0,
      s.received,s.sent,s.close_code,s.cert,0,0]
      .forEach((v,i)=>out.writeUInt32LE(v>>>0,i*4));return 0;}
  recv(h,p,size){
    if(this.gate())return this.gate();[h,p,size]=[h,p,size].map(x=>x>>>0);
    if(size<MESSAGE)return -1;const s=this.slots.get(h);if(!s)return -10;
    const out=this.bytes(p,MESSAGE);
    if(s.queue.length){
      const {opcode,data}=s.queue.shift();
      if(!s.queue.length&&s.socket)s.socket.resume(); /* drained, peer intake continues */
      out.fill(0);[MESSAGE,1,opcode,data.length,0,0,0].forEach((v,i)=>out.writeUInt32LE(v,i*4));
      if(data.length)data.copy(out,DATA);return 0;}
    if(s.state===6)return -21; /* CLOSED and drained: stable EPIPE */
    if(s.state>=7)return s.error||-26;
    return -15;}
  cancel(h){if(this.gate())return this.gate();const s=this.slots.get(h>>>0);if(!s)return -10;
    if(s.state>=6)return 0; /* firmware: terminal cancel is an accepted no-op */
    s.state=8;s.error=-19;s.sending=undefined;s.pending=false;
    try{s.client?.terminate();}catch{}s.socket=null;this.drop(s);return 0;}
  close(s){if(!s)return -10;s.closing=true;this.slots.delete(s.id);clearInterval(s.timer);
    s.resolver?.cancel();s.queue=[];s.sending=undefined;s.pending=false;
    const client=s.client;s.socket=null;releaseWs(this);
    if(client&&client.readyState===WebSocket.OPEN){try{client.close(1000);}catch{}
      const timer=setTimeout(()=>{try{client.terminate();}catch{}},1500);timer.unref();}
    else if(client){try{client.terminate();}catch{}}
    this.drop(s);return 0;}
  stop(){for(const s of [...this.slots.values()])this.close(s);this.host=null;releaseWs(this);}
  imports(){return {aster_ws_connect:(p,n,t)=>this.connect(p,n,t),
    aster_ws_status:(h,p,s)=>this.status(h,p,s),
    aster_ws_send:(h,o,p,n)=>this.send(h,o,p,n),
    aster_ws_recv:(h,p,s)=>this.recv(h,p,s),
    aster_ws_cancel:h=>this.cancel(h),
    aster_ws_close:h=>this.gate()||this.close(this.slots.get(h>>>0))};}
}
module.exports={Ws,parse};
