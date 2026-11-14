'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {DesktopCatalog}=require('../src/desktop-catalog'),{Host}=require('../src/host'),{packageFixture}=require('./fixtures');
test('desktop registry persists code/resources and rejects a broken update before switching',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aster-desktop-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'fixture.ast'),resources=path.join(root,'resources');fs.writeFileSync(file,packageFixture());fs.mkdirSync(resources);fs.writeFileSync(path.join(resources,'hello.txt'),'assets survive restart');
 let catalog=new DesktopCatalog(path.join(root,'card'));const progress=[];assert.equal(catalog.import(file,resources,p=>progress.push(p)),'test.fixture');
 assert.equal(progress[0].phase,'check');assert(progress.some(p=>p.phase==='prepare'));assert(progress.some(p=>p.phase==='copy'&&p.file==='hello.txt'));assert.equal(progress.at(-1).phase,'commit');assert.equal(progress.at(-1).done,progress.at(-1).total);
 catalog=new DesktopCatalog(path.join(root,'card'));assert.equal(catalog.list()[0].assets.get('hello.txt').toString(),'assets survive restart');
 const index=fs.readFileSync(catalog.index);fs.writeFileSync(file,Buffer.from('corrupt'));assert.throws(()=>catalog.import(file));assert.deepEqual(fs.readFileSync(catalog.index),index);
 catalog.uninstall('test.fixture');assert.equal(new DesktopCatalog(path.join(root,'card')).list().length,0);
});

test('desktop firmware fonts preserve bitmap coverage, baseline and integer advance',t=>{
 const {FirmwareFonts}=require('../src/firmware-fonts'),{createCanvas}=require('@napi-rs/canvas');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aster-cpfont-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const bpp of [2,4]){
  const data=Buffer.alloc(94);data.write('CPFONT');data.writeUInt16LE(4,8);data[10]=bpp===2?1:0;data.writeUInt32LE(1,36);data.writeUInt32LE(1,40);data[44]=26;data.writeInt16LE(21,45);data.writeUInt32LE(64,56);
  data.writeUInt32LE(65,64);data.writeUInt32LE(65,68);data[76]=2;data[77]=2;data.writeUInt16LE(48,78);data.writeInt16LE(1,80);data.writeInt16LE(2,82);data.writeUInt16LE(bpp===2?1:2,84);data[92]=bpp===2?0x1b:0x05;data[93]=0xaf;
  fs.writeFileSync(path.join(root,'ui_20.cpfont'),data);const font=new FirmwareFonts(root);
  assert.equal(font.measure(0,'AA\nA'),6);assert.equal(font.measure(20,'A\u200cA'),6);
  const canvas=createCanvas(12,12),ctx=canvas.getContext('2d');font.draw(ctx,20,'A',2,5,0xffff);
  const image=ctx.getImageData(3,2,2,2).data;assert.deepEqual([image[3],image[7],image[11],image[15]],[0,85,170,255]);
  data.writeUInt32LE(999,88);fs.writeFileSync(path.join(root,'ui_20.cpfont'),data);assert.throws(()=>new FirmwareFonts(root).measure(20,'A'),/bitmap/);
 }
});
test('hardware profiles report requested identity and accept five independent touch slots',t=>{
 const h=new Host({manifest:{id:'test.desktop',permissions:[]},assets:new Map()},{maxTouchPoints:5,deviceProfile:{board:'osptek-p4-st7102',arch:3,platform:'desktop',soc:'esp32p4'}});
 h.memory=new WebAssembly.Memory({initial:1});h.heap=4096;h.eventPtr=128;h.call=()=>0;t.after(()=>h.stop());const api=h.imports();
 h.bytes(512,128).fill(0);h.u32(512,128);h.u32(516,1);assert.equal(api.aster_system_get_info(512,128),0);assert.equal(h.string(540,16).split('\0')[0],'osptek-p4-st7102');assert.equal(h.u32(604),3);
 for(let slot=0;slot<5;slot++)h.input({type:'touch',action:1,slot,x:slot*10,y:20});assert.equal(api.aster_input_touch(1024,5),5);
 h.input({type:'touch',action:3,slot:3,x:30,y:20});assert.equal(api.aster_input_touch(1024,5),4);
 h.input({type:'touch',action:1,slot:5,x:50,y:20});assert.equal(api.aster_input_touch(1024,5),4);
});
