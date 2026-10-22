'use strict';
// Bounded state for a browser that connects after the WASM APP has started.
// One-shots are intentionally not replayed; looping voices restart their intro.
class AudioReplay {
  constructor() { this.loads=new Map();this.loops=new Map();this.music=[];this.paused=false;this.volume=undefined; }
  accept(m) {
    if (m.volume!==undefined) this.volume=m.volume;
    if (m.op==='effect-load') {this.loads.set(m.handle,m);this.loops.delete(m.handle);}
    if (m.op==='effect-unload') {this.loads.delete(m.handle);this.loops.delete(m.handle);}
    if (m.op==='effect') {
      if (m.desc?.flags&1) this.loops.set(m.handle,{...m,desc:{...m.desc}});
      else this.loops.delete(m.handle);
    }
    if (m.op==='effect-params' && this.loops.has(m.handle)) {
      const v=this.loops.get(m.handle);v.desc={...v.desc,...m.params};
    }
    if (m.op==='effect-stop') this.loops.delete(m.handle);
    if (m.op==='effect-suspend') this.paused=!!m.paused;
    if (m.op==='start') this.music=[m];
    else if (m.op==='stop') {this.music=[];this.loops.clear();}
    else if (['volume','pause','resume','seek'].includes(m.op) && this.music.length) {
      this.music.push(m);if(this.music.length>50)this.music.splice(1,1);
    }
  }
  messages() {
    return [...this.loads.values(),...this.music,...this.loops.values(),
      {type:'audio',op:'effect-suspend',paused:this.paused},
      ...(this.volume===undefined?[]:[{type:'audio',op:'volume',volume:this.volume}])];
  }
}
module.exports={AudioReplay};
