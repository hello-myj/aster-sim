'use strict';
const {spawn}=require('node:child_process'),path=require('node:path'),fs=require('node:fs');
const root=path.resolve(__dirname,'..'),local=path.join(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
const child=spawn(process.env.ASTER_SIM_PYTHON||(fs.existsSync(local)?local:process.platform==='win32'?'python':'python3'),[path.join(root,'desktop/main.py'),...process.argv.slice(2)],{stdio:'inherit'});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});
