#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const { WebSocketServer, WebSocket } = require('ws');
const compatibility = require('./sdk-compat.json');
const { validateReplay } = require('./replay');
const version = '0.2.0';
const help = `aster-sim ${version} — Aster ABI 3.8 WASM APP simulator
Usage: aster-sim APP.ast [--resolution 240x320] [options]
  --width N --height N    Window size; manifest orientation applies. This is the glass.
  --scale N              Window display scale (default 2; APP pixels unchanged)
  --headless --frames N  Run N frames without a window (CI; default 120)
  --screenshot FILE.png  Save final screen on exit
  --state DIR            Opt-in disk storage (default: session memory only)
  --apps DIR             Additional .ast packages for appmgr switching
  --camera FILE          Image as virtual RGB565 camera (max 320x240)
  --pcm-input FILE       Raw 44100 Hz stereo S16LE recording fixture
  --network              Enable real IPv4 TCP/UDP (permission net required)
  --wifi                 Enable simulated Wi-Fi station (no host network changes)
  --no-audio             Report audio-out unavailable
  --no-open              Serve GUI without automatically opening Edge
  --replay FILE.json     Fixed clock/seed/input replay, headless; fresh memory storage
  --diagnostics FILE.json  Save runtime, traps, ABI counts, frame timings and state hashes
  --port N               Local HTTP port (default random)
  --watchdog N           Abort blocked WASM after N seconds (default 10)
  --manifest FILE        Manifest for raw .wasm (default adjacent manifest.json)
  --pubkey FILE          Ed25519 public key for signed .ast
  --version              Show simulator and supported SDK contract version
  --help                 Show help
Only WASM is executed; any Xtensa AOT payload in .ast is ignored.
`;
function parse(argv) {
  const opts = { width: 240, height: 320, scale: 2, port: 0, watchdog: 10, files: [] };
  const booleans = { '--headless': 'headless', '--no-open': 'noOpen', '--no-audio': 'noAudio', '--wifi': 'wifi', '--network': 'network' };
  const values = { '--width': 'width', '--height': 'height', '--scale': 'scale', '--port': 'port', '--frames': 'frames', '--watchdog': 'watchdog', '--state': 'state', '--apps': 'apps', '--camera': 'camera', '--pcm-input': 'pcmInput', '--screenshot': 'screenshot', '--manifest': 'manifest', '--pubkey': 'pubkey', '--replay': 'replayFile', '--diagnostics': 'diagnosticsFile' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]; if (arg === '--version') return { version: true };
    if (arg === '--help' || arg === '-h') return { help: true };
    if (booleans[arg]) { opts[booleans[arg]] = true; continue; }
    if (arg === '--resolution') { const match = /^(\d+)[xX](\d+)$/.exec(argv[++i] || ''); if (!match) throw Error('Resolution must be WIDTHxHEIGHT'); opts.width = Number(match[1]); opts.height = Number(match[2]); continue; }
    if (values[arg]) { if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw Error(`Missing value for ${arg}`); const key = values[arg], value = argv[++i]; opts[key] = ['width', 'height', 'scale', 'port', 'frames', 'watchdog'].includes(key) ? Number(value) : path.resolve(value); continue; }
    if (arg.startsWith('-')) throw Error(`Unknown option: ${arg}`); if (opts.files.length) throw Error('Pass one APP; use --apps for catalog'); opts.files.push(path.resolve(arg));
  }
  if (!opts.files.length) throw Error('APP path required; use --help');
  for (const name of ['width', 'height']) if (!Number.isInteger(opts[name]) || opts[name] < 16 || opts[name] > 2048) throw Error(`${name} must be 16..2048`);
  if (!Number.isFinite(opts.scale) || opts.scale < 0.25 || opts.scale > 8) throw Error('scale must be 0.25..8');
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw Error('Invalid port');
  if (!Number.isFinite(opts.watchdog) || opts.watchdog < 1 || opts.watchdog > 300) throw Error('watchdog must be 1..300 seconds');
  if (opts.frames !== undefined && (!Number.isInteger(opts.frames) || opts.frames < 1)) throw Error('frames must be a positive integer');
  if(opts.replayFile){if(opts.state||opts.apps)throw Error('Replay uses one APP and fresh memory storage; --state/--apps are not supported');if(fs.statSync(opts.replayFile).size>8*1024*1024)throw Error('Replay file exceeds 8 MiB');opts.replay=validateReplay(JSON.parse(fs.readFileSync(opts.replayFile,'utf8')));opts.frames=opts.frames??opts.replay.frames;if(opts.frames>opts.replay.frames)throw Error('Replay --frames exceeds scenario length');opts.headless=true;}
  if (opts.headless && !opts.frames) opts.frames = 120;
  if (opts.apps) for (const f of fs.readdirSync(opts.apps)) if (f.endsWith('.ast')) { const p = path.resolve(opts.apps, f); if (!opts.files.includes(p)) opts.files.push(p); }
  return opts;
}
function openWindow(url, opts) {
  const candidates = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean).map(base => path.join(base, 'Microsoft/Edge/Application/msedge.exe'));
  const edge = candidates.find(fs.existsSync);
  if (edge) {
    const child = spawn(edge, [`--app=${url}`, `--window-size=${Math.ceil(opts.width * opts.scale + 400)},${Math.ceil(opts.height * opts.scale + 100)}`], { detached: true, stdio: 'ignore', windowsHide: true }); child.on('error', e => console.error(e.message)); child.unref();
  } else console.log('Open the local GUI URL in a browser.');
}
async function main(opts) {
  if(opts.diagnosticsFile)fs.mkdirSync(path.dirname(opts.diagnosticsFile),{recursive:true});
  const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const provenance={simulator:version,sdk:compatibility.sdkCommit,sdkWorkingTree:!!compatibility.sdkWorkingTree,abi:compatibility.abi,nodeVersion:process.version,platform:process.platform,arch:process.arch,dependencyLockSha256:hash(path.join(__dirname,'../package-lock.json')),sources:Object.fromEntries(fs.readdirSync(__dirname).filter(f=>f.endsWith('.js')).sort().map(f=>[f,hash(path.join(__dirname,f))])),packages:Object.fromEntries(opts.files.map(f=>{const target=fs.existsSync(f)&&fs.statSync(f).isDirectory()?path.join(f,'app.wasm'):f;return [f,fs.existsSync(target)&&fs.statSync(target).isFile()?hash(target):null];})),scenarioSha256:opts.replayFile?hash(opts.replayFile):null,peripheralInputs:Object.fromEntries(['camera','pcmInput','manifest'].filter(k=>opts[k]&&fs.existsSync(opts[k])).map(k=>[k,hash(opts[k])]))};
  let info, frame, lastDiagnostics=null, done = false, worker, last = Date.now(), audioReplay = [], effectReplay = new Map();
  const token = crypto.randomBytes(24).toString('hex');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (url.pathname === '/audio.js') { res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(fs.readFileSync(path.join(__dirname, '../web/audio.js'))); return; }
    if (url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' blob: data:; media-src blob:; connect-src 'self'");
      res.end(fs.readFileSync(path.join(__dirname, '../web/index.html'))); return;
    }
    res.writeHead(404).end();
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost'), origin = `http://127.0.0.1:${server.address().port}`;
    if (url.pathname !== '/ws' || url.searchParams.get('token') !== token || req.headers.origin !== origin) { socket.destroy(); return; }
    sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws, req));
  });
  const broadcast = msg => { const data = JSON.stringify(msg); for (const ws of sockets.clients) if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 2 * 1024 * 1024) ws.send(data); };
  const cleanup = async code => { if (done) return; done = true; clearInterval(watchdog); await worker?.terminate(); for (const ws of sockets.clients) ws.close(); sockets.close(); server.close(); process.exitCode = Math.max(0, Math.min(255, code)); };
  sockets.on('connection', ws => {
    if (info) ws.send(JSON.stringify(info)); if (frame) ws.send(JSON.stringify({ type: 'frame', data: frame }));
    for (const msg of effectReplay.values()) ws.send(JSON.stringify(msg));
    for (const msg of audioReplay) ws.send(JSON.stringify(msg));
    ws.on('message', b => { try { const msg = JSON.parse(b.toString()); if (msg.type === 'stop') { worker.postMessage(msg); return; } if (['touch', 'key', 'sensor', 'pause', 'reset', 'audio-feedback'].includes(msg.type)) worker.postMessage(msg); } catch { ws.close(1003); } });
  });
  if (!opts.headless) { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(opts.port, '127.0.0.1', resolve); }); const url = `http://127.0.0.1:${server.address().port}/#${token}`; console.log(`aster-sim GUI: ${url}`); if (!opts.noOpen) openWindow(url, opts); }
  const watchdog = setInterval(() => { if (Date.now() - last > opts.watchdog * 1000) { const error=`WASM callback blocked >${opts.watchdog}s; terminated`;console.error(error);if(opts.diagnosticsFile)fs.writeFileSync(opts.diagnosticsFile,JSON.stringify({error,code:1,diagnostics:lastDiagnostics,...provenance},null,2)+'\n'); cleanup(1); } }, 500);
  worker = new Worker(path.join(__dirname, 'worker.js'), { workerData: opts });
  worker.on('message', msg => {
    if(msg.diagnostics)lastDiagnostics=msg.diagnostics;
    if (['heartbeat', 'ready', 'done'].includes(msg.type)) last = Date.now();
    if (msg.type === 'ready') { info = { ...msg, scale: opts.scale, wifi: !!opts.wifi }; console.log(`Running ${msg.manifest.id}: ${msg.width}x${msg.height}, WASM (AOT ${msg.hasAot ? 'ignored' : 'absent'})`); }
    if (msg.type === 'log') console.log(`[${msg.ms}ms/${msg.level}] ${msg.message}`);
    if (msg.type === 'frame') { frame = Buffer.from(msg.data).toString('base64'); msg.data = frame; }
    if (msg.type === 'audio' && msg.data) msg.data = Buffer.from(msg.data).toString('base64');
    if (msg.type === 'audio' && msg.op === 'effect-load') effectReplay.set(msg.handle, msg);
    if (msg.type === 'audio' && msg.op === 'effect-unload') effectReplay.delete(msg.handle);
    if (msg.type === 'audio') { if (msg.op === 'start') audioReplay = [msg]; else if (msg.op === 'stop') audioReplay = []; else if (['volume', 'pause', 'resume', 'seek'].includes(msg.op) && audioReplay.length) { audioReplay.push(msg); if (audioReplay.length > 50) audioReplay.splice(1, 1); } }
    if (msg.type === 'done') { if(opts.diagnosticsFile)fs.writeFileSync(opts.diagnosticsFile,JSON.stringify({...msg,...provenance},null,2)+'\n'); if (msg.error) console.error(msg.error); console.log(`Exit ${msg.code}; frames=${msg.frames || 0}, presents=${msg.presents || 0}`); broadcast(msg); cleanup(msg.code); return; }
    broadcast(msg.type === 'ready' ? info : msg);
  });
  worker.on('error', e => { console.error(e.stack); cleanup(1); });
  worker.on('exit', code => { if (!done && code) cleanup(code); });
  process.once('SIGINT', () => worker.postMessage({ type: 'stop' }));
}
if (require.main === module) { try { const opts = parse(process.argv.slice(2)); if (opts.help) console.log(help); else if (opts.version) console.log(JSON.stringify({ simulator: version, abi: compatibility.abi, sdkCommit: compatibility.sdkCommit, sdkWorkingTree: !!compatibility.sdkWorkingTree, apiSha256: compatibility.contractHashes['contract/api.json'] }, null, 2)); else main(opts).catch(e => { console.error(e.stack); process.exitCode = 1; }); } catch (e) { console.error(e.message); process.exitCode = 1; } }
module.exports = { parse, main };
