'use strict';
// ABI 3.9. Real Node HTTP/TLS; bounded public queue, no retained guest views.
const http=require('node:http'),https=require('node:https'),dns=require('node:dns'),net=require('node:net');
const fs=require('node:fs'),path=require('node:path');
const {live,allocate}=require('./network-budget');
const token=/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const own=/^(host|content-length|transfer-encoding|connection|accept-encoding|expect|upgrade)$/i;
const error=code=>Object.assign(Error(code),{code});
const mapped=e=>({ENOTFOUND:-22,EAI_AGAIN:-22,ECONNRESET:-23,ECONNREFUSED:-24,EPIPE:-21,ENETUNREACH:-25,EHOSTUNREACH:-25,ETIMEDOUT:-8}[e.code] || (e.code?.startsWith('HPE_')?-26:-7));
function url(text) {
  if(!text||Buffer.byteLength(text)>1024||/[\x00-\x20\x7f-\xff\\]/.test(text)||!/^https?:\/\//i.test(text))throw error('EINVAL');
  let u;try{u=new URL(text);}catch{throw error('EINVAL');}
  if(u.username||u.password||!u.hostname||u.hostname.includes(':')||!/^[a-z0-9.-]+$/i.test(u.hostname)||u.hostname.length>253)throw error('EINVAL');
  if(net.isIP(u.hostname)===4){const a=+u.hostname.split('.')[0];if(a===0||a>=224)throw error('EINVAL');}
  if(u.port==='0')throw error('EINVAL');return u;
}
class Http {
  constructor(host) {this.host=host;this.slots=new Map();this.ca=host.options.networkCA?fs.readFileSync(host.options.networkCA):fs.readFileSync(path.join(__dirname,'isrg-root-x1.pem'));}
  gate(){return !this.host?-12:!this.host.permissions.has('net')?-4:!this.host.features.has(16)?-3:0;}
  bytes(p,n){return this.host.network.bytes(p,n);}
  text(p,n,max,optional=false){if(!n){if(optional&&!p)return '';throw error('EINVAL');}if(n>max)throw error('EINVAL');const b=this.bytes(p,n);if(b.includes(0)||[...b].some(x=>x>127))throw error('EINVAL');return b.toString('ascii');}
  finish(s,state,err=0){if(s.closing||s.state>=6)return;s.state=state;s.error=err;clearTimeout(s.timer);if(state!==6){s.resolver?.cancel();s.req?.destroy();}}
  release(s){if(s.closing&&!s.socket&&!s.resolving&&!s.pending)live.delete(s);}
  close(s){if(!s)return -10;s.closing=true;this.slots.delete(s.id);clearTimeout(s.timer);s.queue=Buffer.alloc(0);s.resolver?.cancel();s.req?.destroy();this.release(s);return 0;}
  stop(){for(const s of [...this.slots.values()])this.close(s);this.host=null;}
  request(method,up,un,hp,hn,bp,bn,timeout,limit){
    if(this.gate())return this.gate();[method,up,un,hp,hn,bp,bn,timeout,limit]=[method,up,un,hp,hn,bp,bn,timeout,limit].map(x=>x>>>0);
    if(![1,2,3].includes(method)||!timeout||timeout>600000||!limit||limit>67108864||bn>2048||(method!==3&&bn)||(!bn&&bp))return -1;
    const u=url(this.text(up,un,1024)),text=this.text(hp,hn,2048,true),headers=[];
    if(text){if(!text.endsWith('\r\n'))return -1;const rows=text.slice(0,-2).split('\r\n');if(rows.length>32)return -20;
      for(const row of rows){const colon=row.indexOf(':'),name=row.slice(0,colon),raw=row.slice(colon+1);if(colon<=0||!token.test(name)||own.test(name)||/[\x00-\x08\x0a-\x1f\x7f]/.test(raw))return -1;headers.push(name,raw.trim());}}
    if(u.protocol==='https:'&&!this.host.features.has(17))return -3;
    if(u.protocol==='https:'&&[...live].some(s=>s.httpTls))return -5;
    const body=bn?Buffer.from(this.bytes(bp,bn)):Buffer.alloc(0),id=allocate();if(!id)return -11;
    const s={id,u,method:['','GET','HEAD','POST'][method],custom:headers,body,limit,state:1,status:0,error:0,redirects:0,headers:null,
      queue:Buffer.alloc(0),received:0n,length:0n,hasLength:false,cert:0,httpTls:u.protocol==='https:',req:null,socket:null,res:null,closing:false,resolving:false};
    live.add(s);this.slots.set(id,s);s.timer=setTimeout(()=>this.finish(s,7,-8),timeout);s.timer.unref();this.begin(s);return id;
  }
  begin(s){
    if(s.closing||s.state>=6)return;
    const secure=s.u.protocol==='https:';s.state=1;
    const lookup=(hostname,options,done)=>{
      s.resolving=true;s.resolver=new dns.Resolver();s.resolver.resolve4(hostname,(e,ips)=>{
        s.resolving=false;s.resolver=null;const ip=ips?.[0];
        if(s.closing||s.state>=6){this.release(s);done(error('ECANCELED'));return;}
        if(e){done(e);return;}const a=+ip.split('.')[0];if(a===0||a>=224){done(error('EHOSTUNREACH'));return;}
        done(null,options.all?[{address:ip,family:4}]:ip,4);
      });
    };
    const options={method:s.method,agent:false,family:4,lookup,maxHeaderSize:2048,
      headers:['Host',s.u.hostname+':'+(s.u.port||(secure?443:80)),'Connection','close','Accept-Encoding','identity','Content-Length',String(s.body.length),...s.custom],
      ...(secure?{ca:this.ca,rejectUnauthorized:true,minVersion:'TLSv1.2',maxVersion:'TLSv1.2'}:{})};
    s.pending=true;
    const req=s.req=(secure?https:http).request(s.u,options,res=>{
      if(s.closing||s.state>=6){res.destroy();return;}
      if(res.rawHeaders.length/2>32){this.finish(s,7,-20);return;}
      const location=res.headers.location,code=res.statusCode;
      if([301,302,303,307,308].includes(code)&&location!==undefined){
        if(!location){this.finish(s,7,-26);return;}
        if(s.redirects===3){this.finish(s,7,-30);return;}
        let next;try{if(/[\x00-\x20\x7f-\xff\\]/.test(location))throw error('EINVAL');next=url(new URL(location,s.u).href);}catch{this.finish(s,7,-26);return;}
        if(secure&&next.protocol!=='https:'){this.finish(s,7,-4);return;}
        if(next.protocol==='https:'&&!s.httpTls){if(!this.host.features.has(17)){this.finish(s,7,-3);return;}if([...live].some(x=>x!==s&&x.httpTls)){this.finish(s,7,-5);return;}s.httpTls=true;}
        if(next.origin!==s.u.origin)s.custom=[];
        if(code===303&&s.method!=='HEAD'||[301,302].includes(code)&&s.method==='POST'){s.method='GET';s.body=Buffer.alloc(0);}
        s.u=next;s.redirects++;s.redirectPending=true;res.destroy();req.destroy();return;
      }
      s.res=res;s.status=code;s.headers=[];for(let i=0;i<res.rawHeaders.length;i+=2)s.headers.push([res.rawHeaders[i],res.rawHeaders[i+1]]);
      if(s.headers.some(([k,v])=>!token.test(k)||/[^\x09\x20-\x7e]/.test(v))){this.finish(s,7,-26);return;}
      s.hasLength=res.headers['content-length']!==undefined;s.length=s.hasLength?BigInt(res.headers['content-length']):0n;
      if([204,304].includes(code)){s.hasLength=true;s.length=0n;}
      if(s.method!=='HEAD'&&s.hasLength&&s.length>BigInt(s.limit)){this.finish(s,7,-20);return;}
      s.state=5;
      res.on('readable',()=>this.pump(s));
      res.on('end',()=>{if(res.rawTrailers.length/2+s.headers.length>32){this.finish(s,7,-20);return;}
        for(let i=0;i<res.rawTrailers.length;i+=2){const k=res.rawTrailers[i],v=res.rawTrailers[i+1];if(!token.test(k)||/^(content-length|transfer-encoding|host|connection|trailer)$/i.test(k)||/[^\x09\x20-\x7e]/.test(v)){this.finish(s,7,-26);return;}s.headers.push([k,v]);}
        if(s.headers.reduce((n,[k,v])=>n+k.length+v.length,0)>2048){this.finish(s,7,-20);return;}
        this.finish(s,6);});
      res.on('error',()=>this.finish(s,7,-26));res.on('aborted',()=>this.finish(s,7,-26));this.pump(s);
    });
    req.on('socket',socket=>{s.socket=socket;socket.on('connect',()=>{if(s.state<6)s.state=secure?2:3;});
      if(secure)socket.on('secureConnect',()=>{if(s.state<6)s.state=3;});
      socket.on('close',()=>{if(s.socket===socket)s.socket=null;if(s.redirectPending){s.redirectPending=false;this.begin(s);}this.release(s);});});
    // ClientRequest assigns/emits its socket asynchronously. Keep admission
    // until close even when the APP closes before that event was delivered.
    req.on('close',()=>{if(s.req===req)s.pending=false;this.release(s);});
    let interim=0;req.on('information',()=>{if(++interim>4)this.finish(s,7,-26);});
    req.on('upgrade',res=>{res.destroy?.();this.finish(s,7,-26);});
    req.on('error',e=>{if(s.redirectPending||s.closing)return;
      const cert={CERT_HAS_EXPIRED:1,CERT_REVOKED:2,ERR_TLS_CERT_ALTNAME_INVALID:4,UNABLE_TO_VERIFY_LEAF_SIGNATURE:8,SELF_SIGNED_CERT_IN_CHAIN:8,DEPTH_ZERO_SELF_SIGNED_CERT:8,UNABLE_TO_GET_ISSUER_CERT_LOCALLY:8,CERT_NOT_YET_VALID:16}[e.code];
      if(cert||/CERT|ISSUER|INVALID_CA|SELF_SIGNED/.test(e.code||'')){s.cert=cert||64;this.finish(s,7,-28);}else this.finish(s,7,e.code?.startsWith('ERR_SSL_')||e.code?.startsWith('ERR_TLS_')?-27:mapped(e));
    });
    req.on('finish',()=>{if(s.state<6&&(!secure||s.socket?.authorized))s.state=4;});
    req.end(s.body);
  }
  pump(s){if(s.closing||s.state>=6||!s.res)return;const n=Math.min(2048-s.queue.length,s.res.readableLength);if(n<=0){if(s.queue.length<2048)s.res.read(0);return;}
    const data=s.res.read(n);if(!data)return;if(s.received+BigInt(data.length)>BigInt(s.limit)){this.finish(s,7,-20);return;}
    s.queue=Buffer.concat([s.queue,data]);s.received+=BigInt(data.length);
  }
  status(h,p,size){if(this.gate())return this.gate();h>>>=0;p>>>=0;size>>>=0;if(size<56)return -1;const out=this.bytes(p,56),s=this.slots.get(h);if(!s)return -10;
    out.fill(0);[56,1,s.state,s.status,s.error,s.redirects,s.queue.length,(s.headers?1:0)|(s.hasLength?2:0)|(s.u.protocol==='https:'?4:0),s.cert,0].forEach((v,i)=>out.writeUInt32LE(v>>>0,i*4));out.writeBigUInt64LE(s.received,40);out.writeBigUInt64LE(s.length,48);return 0;}
  read(h,p,cap){if(this.gate())return this.gate();h>>>=0;p>>>=0;cap>>>=0;if(!cap||cap>2048)return -1;const out=this.bytes(p,cap),s=this.slots.get(h);if(!s)return -10;
    this.pump(s);if(s.queue.length){const n=Math.min(cap,s.queue.length);s.queue.copy(out,0,0,n);s.queue=Buffer.from(s.queue.subarray(n));this.pump(s);return n;}return s.state===6?0:s.state>=7?s.error:-15;}
  header(h,np,nn,index,p,cap,rp){if(this.gate())return this.gate();[h,np,nn,index,p,cap,rp]=[h,np,nn,index,p,cap,rp].map(x=>x>>>0);
    const name=this.text(np,nn,2048);if(!token.test(name)||cap>2048||!cap&&p)return -1;
    const required=this.bytes(rp,4),out=cap?this.bytes(p,cap):null;if(cap&&p<rp+4&&rp<p+cap)return -1;
    const s=this.slots.get(h);if(!s)return -10;if(!s.headers)return -15;const value=s.headers.filter(([k])=>k.toLowerCase()===name.toLowerCase())[index]?.[1];if(value===undefined)return -6;
    const data=Buffer.from(value,'ascii');required.writeUInt32LE(data.length);if(cap<data.length)return -20;if(data.length)data.copy(out);return data.length;
  }
  imports(){return {aster_http_request:this.request.bind(this),aster_http_status:this.status.bind(this),aster_http_read:this.read.bind(this),aster_http_header:this.header.bind(this),aster_http_cancel:h=>{if(this.gate())return this.gate();const s=this.slots.get(h>>>0);if(!s)return -10;this.finish(s,8,-19);return 0;},aster_http_close:h=>this.gate()||this.close(this.slots.get(h>>>0))};}
}
module.exports={Http};
