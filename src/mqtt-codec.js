'use strict';
// Bounded MQTT 3.1.1 wire codec. No MQTT 5 properties or QoS 2.
const bad=(code='EPROTO')=>Object.assign(Error(code),{code});
const utf8=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
function text(bytes,filter=null){
  let s;try{s=utf8.decode(bytes);}catch{throw bad('EINVAL');}
  for(const c of s){const n=c.codePointAt(0);if(n<32||(n>=127&&n<=159)||(n>=0xfdd0&&n<=0xfdef)||(n&65535)>=65534)throw bad('EINVAL');}
  if(filter!==null){if(!bytes.length||bytes.length>128)throw bad('EINVAL');
    if(!filter&&/[+#]/.test(s))throw bad('EINVAL');
    if(filter){const levels=s.split('/');levels.forEach((v,i)=>{if(v.includes('+')&&v!=='+'||v.includes('#')&&(v!=='#'||i!==levels.length-1))throw bad('EINVAL');});}}
  return s;
}
function field(b){const h=Buffer.alloc(2);h.writeUInt16BE(b.length);return Buffer.concat([h,b]);}
function packet(type,body){if(body.length>1532)throw bad('EMSGSIZE');let n=body.length,a=[type];do{let b=n%128;n=Math.floor(n/128);a.push(b|(n?128:0));}while(n);return Buffer.concat([Buffer.from(a),body]);}
function connect(o){
  let flags=2|(o.user!==null?128:0)|(o.password.length?64:0);
  const fields=[field(Buffer.from(o.client))];
  if(o.willTopic){flags|=4|(o.willQos<<3)|(o.willRetain?32:0);fields.push(field(Buffer.from(o.willTopic)),field(o.will));}
  if(o.user!==null)fields.push(field(Buffer.from(o.user)));
  if(o.password.length)fields.push(field(o.password));
  const h=Buffer.from([0,4,77,81,84,84,4,flags,o.keepalive>>8,o.keepalive&255]);
  return packet(0x10,Buffer.concat([h,...fields]));
}
function publish(topic,data,qos,retain,id){const h=Buffer.from([id>>8,id&255]);return packet(0x30|(qos<<1)|(retain?1:0),Buffer.concat([field(Buffer.from(topic)),...(qos?[h]:[]),data]));}
function subscription(topic,qos,id,remove){return packet(remove?0xa2:0x82,Buffer.concat([Buffer.from([id>>8,id&255]),field(Buffer.from(topic)),...(remove?[]:[Buffer.from([qos])])]));}
function decode(b){
  if(b.length<2)return null;
  let len=0,m=1,h=1;
  for(;;){if(h>=b.length)return null;const x=b[h++];len+=(x&127)*m;
    if(!(x&128)){if(h>2&&x===0)throw bad();break;}if(h===5)throw bad();m*=128;}
  if(h+len>1536)throw bad('EMSGSIZE');
  const type=b[0]>>4,flags=b[0]&15;
  if(type!==3&&flags||![2,3,4,9,11,13].includes(type)||type===2&&len!==2||[4,11].includes(type)&&len!==2||type===9&&len!==3||type===13&&len)throw bad();
  if(b.length<h+len)return null;const body=b.subarray(h,h+len),p={type,length:h+len,body};
  if(type===2){if(len!==2||body[0]!==0||body[1]>5)throw bad();p.code=body[1];}
  else if(type===3){p.qos=(flags>>1)&3;p.retain=!!(flags&1);p.dup=!!(flags&8);if(p.qos>1||!p.qos&&p.dup||len<2)throw bad();
    const n=body.readUInt16BE(0);if(!n||n>128)throw bad('EMSGSIZE');if(len<2+n+(p.qos?2:0))throw bad();
    try{p.topic=text(body.subarray(2,2+n),false);}catch{throw bad();}
    p.id=p.qos?body.readUInt16BE(2+n):0;if(p.qos&&!p.id)throw bad();p.data=body.subarray(2+n+(p.qos?2:0));if(p.data.length>1024)throw bad('EMSGSIZE');}
  else if([4,9,11].includes(type)){if(len!==(type===9?3:2)||(p.id=body.readUInt16BE(0))===0)throw bad();if(type===9&&![0,1,128].includes(body[2]))throw bad();p.code=body[2];}
  else if(type===13){if(len)throw bad();}
  else throw bad();return p;
}
module.exports={bad,text,connect,publish,subscription,decode};
