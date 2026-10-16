'use strict';
const FEATURES = { display:0,touch:1,mouse:2,keyboard:3,camera:4,'audio-in':5,'audio-out':6,wifi:7,bluetooth:8,accelerometer:9,gyroscope:10,filesystem:11,rtc:12,psram:13,framebuffer:14,'storage.app':11,network:15,http:16,tls:17,'audio-stream':18,mqtt:19 };
function validateReplay(value) {
  const integer=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
  if (!value || value.version!==1 || !integer(value.frames,1,1000000) || !integer(value.step_ms,1,1000) || !integer(value.seed,0,0xffffffff)) throw Error('Replay requires version=1, frames, step_ms and u32 seed');
  if (value.epoch_ms!==undefined && !integer(value.epoch_ms,0,8640000000000000-value.frames*value.step_ms)) throw Error('Invalid replay epoch_ms');
  const faults=value.faults||{};
  if (Object.keys(faults).some(k=>!['storage_bytes','allocation_fail_at','missing_features'].includes(k))) throw Error('Unknown replay fault');
  for (const key of ['storage_bytes','allocation_fail_at']) if(faults[key]!==undefined&&!integer(faults[key],key==='storage_bytes'?0:1,0x7fffffff))throw Error('Invalid replay fault '+key);
  if(faults.missing_features!==undefined&&(!Array.isArray(faults.missing_features)||faults.missing_features.some(x=>FEATURES[x]===undefined)))throw Error('Unknown missing feature');
  if (!Array.isArray(value.events)||value.events.length>100000) throw Error('Replay events must be an array, max 100000');
  let prior=-1;
  for(const [index,e] of value.events.entries()){
    if(!e||typeof e!=='object')throw Error('Invalid replay event '+index);
    if(!integer(e.frame,0,value.frames-1)||e.frame<prior)throw Error('Replay event frames must be ordered and inside the run');prior=e.frame;
    if(e.type==='touch'){if(!integer(e.x,0,2047)||!integer(e.y,0,2047)||![1,2,3].includes(e.action))throw Error('Invalid replay touch');}
    else if(e.type==='key'){if(!integer(e.code,1,767)||typeof e.pressed!=='boolean')throw Error('Invalid replay key');}
    else if(e.type==='sensor'){if(!['accel','gyro'].some(k=>e[k]!==undefined)||['accel','gyro'].some(k=>e[k]!==undefined&&(!Array.isArray(e[k])||e[k].length!==3||!e[k].every(Number.isFinite))))throw Error('Invalid replay sensor');}
    else if(e.type==='sensor-noise'){if(!Number.isFinite(e.amplitude)||e.amplitude<0||e.amplitude>1000)throw Error('Invalid sensor noise amplitude');}
    else if(e.type==='pause'){if(typeof e.paused!=='boolean')throw Error('Replay pause needs explicit paused state');}
    else throw Error('Unsupported replay input '+e.type);
  }
  return value;
}
class Replay {
  constructor(value){this.config=validateReplay(value);this.frame=0;this.cursor=0;this.ms=0;this.rng=value.seed>>>0;}
  random(){this.rng=(Math.imul(this.rng,1664525)+1013904223)>>>0;return this.rng/4294967296;}
  step(host){
    this.ms=this.frame*this.config.step_ms;
    while(this.cursor<this.config.events.length&&this.config.events[this.cursor].frame===this.frame){
      let event=this.config.events[this.cursor++];
      if(event.type==='sensor-noise')event={type:'sensor',gyro:[0,0,0].map(()=> (this.random()*2-1)*event.amplitude)};
      if(event.type==='pause')host.setPaused(event.paused);else host.input(event);
    }
    host.tick();this.frame++;
  }
}
module.exports={Replay,validateReplay,FEATURES};
