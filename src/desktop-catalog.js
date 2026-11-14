'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {loadPackage,validRelative}=require('./package');

class DesktopCatalog {
  constructor(state){this.state=path.resolve(state);this.root=path.join(this.state,'installed');this.index=path.join(this.state,'registry.json');fs.mkdirSync(this.root,{recursive:true});this.entries=fs.existsSync(this.index)?JSON.parse(fs.readFileSync(this.index,'utf8')):[];if(!Array.isArray(this.entries))throw Error('Invalid desktop registry');}
  generation(entry){if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(entry.id)||entry.id.includes('..')||!/^[a-f0-9]{24}$/.test(entry.generation))throw Error('Invalid registry entry');return path.join(this.root,entry.id,entry.generation);}
  list(){return this.entries.map(e=>{const dir=this.generation(e),pkg=loadPackage(path.join(dir,'app.wasm'));this.readAssets(path.join(dir,'assets'),pkg.assets);return pkg;});}
  readAssets(base,assets,prefix='',depth=0){if(!fs.existsSync(base))return;if(depth>16)throw Error('Resource depth limit');for(const ent of fs.readdirSync(base,{withFileTypes:true})){const name=prefix+ent.name;if(!validRelative(name)||ent.isSymbolicLink())throw Error('Invalid resource path');const file=path.join(base,ent.name);if(ent.isDirectory())this.readAssets(file,assets,name+'/',depth+1);else if(ent.isFile()){if(assets.has(name))throw Error('Duplicate asset');assets.set(name,fs.readFileSync(file));}}}
  commit(pkg,program,progress=()=>{}){
    const manifest=Buffer.from(JSON.stringify(pkg.manifest));
    const total=pkg.wasm.length+manifest.length+[...pkg.assets.values()].reduce((n,b)=>n+b.length,0);let done=0;
    progress({phase:'copy',done,total,file:'app.wasm'});
    const write=(file,data,name)=>{const fd=fs.openSync(file,'w');try{for(let offset=0;offset<data.length;){const n=fs.writeSync(fd,data,offset,Math.min(262144,data.length-offset));if(!n)throw Error('Resource write stalled');offset+=n;done+=n;progress({phase:'copy',done,total,file:name});}}finally{fs.closeSync(fd);}};
    const entry={id:pkg.manifest.id,generation:crypto.randomBytes(12).toString('hex')},dir=this.generation(entry);fs.mkdirSync(path.join(dir,'assets'),{recursive:true});
    write(path.join(dir,'app.wasm'),pkg.wasm,'app.wasm');write(path.join(dir,'manifest.json'),manifest,'manifest.json');
    for(const [name,data] of pkg.assets){if(!validRelative(name))throw Error('Invalid asset path');const file=path.join(dir,'assets',name);fs.mkdirSync(path.dirname(file),{recursive:true});write(file,data,name);}
    if(program?.subarray(0,4).toString()==='ASTP'){const off=program.readUInt32LE(40),len=program.readUInt32LE(44);if(len)fs.writeFileSync(path.join(dir,'icon.bin'),program.subarray(off,off+len));}
    progress({phase:'commit',done,total,file:''});const entries=this.entries.filter(e=>e.id!==entry.id).concat(entry);this.writeIndex(entries);this.exportIcons();
  }
  writeIndex(entries){const temp=this.index+'.tmp';fs.writeFileSync(temp,JSON.stringify(entries));fs.renameSync(temp,this.index);this.entries=entries;}
  exportIcons(){for(const entry of this.entries){const source=path.join(this.generation(entry),'icon.bin'),dir=path.join(this.state,'shared/sd/aster/apps',entry.id);fs.mkdirSync(dir,{recursive:true});if(fs.existsSync(source))fs.copyFileSync(source,path.join(dir,'icon.bin'));}}
  import(file,resources,progress=()=>{}){progress({phase:'check',file:path.basename(file)});const pkg=loadPackage(file);if(resources){if(!fs.statSync(resources).isDirectory())throw Error('Resource directory is not a directory');progress({phase:'prepare',file:resources});this.readAssets(path.resolve(resources),pkg.assets);}this.commit(pkg,fs.readFileSync(file),progress);return pkg.manifest.id;}
  uninstall(id){if(!this.entries.some(e=>e.id===id))throw Error('APP not installed');this.writeIndex(this.entries.filter(e=>e.id!==id));}
}
module.exports={DesktopCatalog};
