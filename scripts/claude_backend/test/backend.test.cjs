'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const cp = require('node:child_process');
const { once } = require('node:events');
const C = require('../common.cjs');
const { launchSpec, launchEnvironment, nativeSessionId } = require('../server.cjs');
const { fingerprint, remoteCommand } = require('../transport.cjs');
const fakeCode = `#!/usr/bin/env node
if(process.argv.includes('--version')){console.log('2.9.321 (Claude Code)');process.exit(0);}
if(process.argv.includes('--exit-seven'))process.exit(7);
if(process.argv.includes('status')){console.log(JSON.stringify({args:process.argv.slice(2),job:process.env.SLURM_JOB_ID,entry:process.env.CLAUDE_CODE_ENTRYPOINT}));process.exit(0);}
let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){let s=b.slice(0,i);b=b.slice(i+1);let r=JSON.parse(s);if(r.type==='control_request')console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:r.request_id,response:{}}}));if(r.type==='user'){console.log(JSON.stringify({type:'system',subtype:'init',session_id:r.session_id||'native-id',version:'2.9.321'}));setTimeout(()=>console.log(JSON.stringify({type:'result',session_id:r.session_id||'native-id',result:'done'})),300);}}});
`;
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-test-'));
  const cli = path.join(dir, 'claude'); fs.writeFileSync(cli, fakeCode, { mode: 0o700 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, cli };
}
async function service(t) {
  const { dir, cli } = fixture(t), socket = path.join(dir, 'app.sock'), file = path.join(dir, 'descriptor.json');
  const child = cp.spawn(process.execPath, [path.join(__dirname, '../server.cjs'), dir, socket, file], {
    env: { ...process.env, HOME: dir, SLURM_JOB_ID: '99111', CLAUDE_BACKEND_CLI: cli }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stderr.on('data', c => { stderr += c; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No ready receipt ${stderr}`)), 10000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`service exited ${code}: ${stderr}`)); });
    child.stdout.on('data', c => { stdout += c; if (stdout.includes('CLAUDE_BACKEND_READY')) { clearTimeout(timer); resolve(); } });
  });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } });
  return { dir, cli, socket, file, child };
}
function connect(socket) {
  const conn = net.createConnection(socket); const frames = [], waiters = [];
  conn.on('error', () => {});
  const send = C.channel(conn, value => { frames.push(value); for (const wake of waiters.splice(0)) wake(); });
  const wait = async op => {
    const deadline = Date.now() + 5000;
    while (!frames.some(f => f.op === op)) {
      await Promise.race([new Promise(resolve => waiters.push(resolve)), new Promise((_, reject) => setTimeout(() => reject(new Error(`No ${op}`)), Math.max(1, deadline - Date.now())).unref())]);
    }
    return frames.find(f => f.op === op);
  };
  return { conn, frames, send, wait };
}
test('bundled extension CLI wins, versions are discovered and explicit mismatch fails', t => {
  const { cli, dir } = fixture(t);
  assert.equal(launchSpec({ args: [cli, '--version'], project: dir }, '/does/not/exist').version, '2.9.321');
  assert.deepEqual(launchSpec({ args: [cli, '--version'], project: dir }, cli).args, ['--version']);
  const bad = path.join(dir, 'bad'); fs.writeFileSync(bad, '#!/bin/sh\necho invalid\n', { mode: 0o700 });
  assert.throws(() => C.cliVersion(bad), /Unrecognized/);
});
test('explicit version pins and mismatched extension binaries fail without replacing running workers', t => {
  const { cli, dir } = fixture(t);
  const previousCli = process.env.CLAUDE_BACKEND_CLI, previousVersion = process.env.CLAUDE_BACKEND_VERSION;
  t.after(() => { if (previousCli === undefined) delete process.env.CLAUDE_BACKEND_CLI; else process.env.CLAUDE_BACKEND_CLI = previousCli; if (previousVersion === undefined) delete process.env.CLAUDE_BACKEND_VERSION; else process.env.CLAUDE_BACKEND_VERSION = previousVersion; });
  process.env.CLAUDE_BACKEND_CLI = cli; process.env.CLAUDE_BACKEND_VERSION = '2.0.0';
  assert.throws(() => launchSpec({args: [cli], project: dir}, cli), /pin mismatch/);
  delete process.env.CLAUDE_BACKEND_VERSION;
  const bundled = path.join(dir, 'new-claude'); fs.writeFileSync(bundled, '#!/bin/sh\necho "2.10.0 (Claude Code)"\n', {mode: 0o700});
  assert.throws(() => launchSpec({args: [bundled], project: dir}, cli), /differs from extension/);
});
test('native session identity parses the actual SDK equals-form flags', () => {
  assert.equal(nativeSessionId(['--resume=session-id']), 'session-id');
  assert.equal(nativeSessionId(['--session-id=new-session']), 'new-session');
  assert.equal(nativeSessionId(['-r', 'short-id']), 'short-id');
  assert.equal(nativeSessionId(['--model=sonnet']), undefined);
});
test('worker allocation variables remain authoritative and cross-node IDE loopback is removed', () => {
  const env = launchEnvironment({ SLURM_JOB_ID: 'spoof', HOME: '/spoof', PATH: '/spoof', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', CLAUDE_CODE_SSE_PORT: '123', ANTHROPIC_BASE_URL: 'https://fixture' }, false);
  assert.equal(env.SLURM_JOB_ID, process.env.SLURM_JOB_ID); assert.equal(env.HOME, process.env.HOME); assert.equal(env.PATH, process.env.PATH);
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, 'claude-vscode'); assert.equal(env.ANTHROPIC_BASE_URL, 'https://fixture'); assert.equal(env.CLAUDE_CODE_SSE_PORT, undefined);
});
test('SSH command preserves argument boundaries and rejects invalid identity', () => {
  const d = { schema: 'claude_backend_v1', status: 'ready', hostname: 'worker.example', jobId: '123', socket: '/tmp/a.sock', component: "/home/user/space's component", node: '/bin/node', project: '/project', pid: 2, startTicks: '3' };
  assert.match(remoteCommand(d, "/home/space's descriptor.json", 'bridge'), /'\\''/);
  assert.notEqual(fingerprint(d), fingerprint({ ...d, startTicks: '4' }));
  assert.throws(() => remoteCommand({ ...d, hostname: '-evil' }, '/file', 'bridge'), /Invalid/);
});
test('private registries reject symlinks and stale PID identities', t => {
  const { dir } = fixture(t); const file = path.join(dir, 'state.json'); C.writeJson(file, { okay: true });
  const link = path.join(dir, 'link'); fs.symlinkSync(file, link); assert.throws(() => C.readJson(link), /private/);
  assert.throws(() => C.validate({ schema: 'claude_backend_v1', status: 'ready', hostname: os.hostname(), jobId: '1', socket: '/tmp/file', component: dir, pid: process.pid, startTicks: 'wrong' }), /Stale/);
});
test('native initialize JSONL passes unchanged; status does not launch a Claude process', async t => {
  const s = await service(t), client = connect(s.socket); t.after(() => client.conn.destroy());
  await once(client.conn, 'connect'); client.send({ op: 'probe' }); assert.deepEqual((await client.wait('ready')).sessions, []);
  client.send({ op: 'spawn', project: s.dir, args: [s.cli, '--print', '--input-format', 'stream-json', '--output-format', 'stream-json'], env: {}, hostname: os.hostname() });
  const started = await client.wait('started'); assert.equal(started.version, '2.9.321');
  client.send({ op: 'input', data: Buffer.from('{"type":"control_request","request_id":"real-id","request":{"subtype":"initialize"}}\n').toString('base64') });
  const out = Buffer.from((await client.wait('stdout')).data, 'base64').toString();
  assert.deepEqual(JSON.parse(out), { type: 'control_response', response: { subtype: 'success', request_id: 'real-id', response: {} } });
  client.send({ op: 'eof' }); assert.equal((await client.wait('exit')).code, 0);
});
test('client loss preserves submitted turn, journals its result, then permits native resume', async t => {
  const s = await service(t), client = connect(s.socket); await once(client.conn, 'connect');
  client.send({ op: 'spawn', project: s.dir, args: [s.cli], env: {}, hostname: os.hostname() });
  const started = await client.wait('started');
  client.send({ op: 'input', data: Buffer.from('{"type":"user","session_id":"native-id","message":{"role":"user","content":"work"}}\n').toString('base64') });
  await client.wait('stdout'); client.conn.destroy();
  const observer = connect(s.socket); t.after(() => observer.conn.destroy()); await once(observer.conn, 'connect');
  observer.send({ op: 'spawn', project: s.dir, args: [s.cli, '--resume=native-id'], env: {}, hostname: os.hostname() });
  assert.match((await observer.wait('error')).error, /still active/);
  // Watch append-only journal completion rather than treating a disconnected client as completion.
  const receipt = path.join(started.journalDir, 'session.json');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { watcher.close(); reject(new Error('orphan did not finish')); }, 5000);
    const watcher = fs.watch(started.journalDir, () => {
      try { if (C.readJson(receipt).status === 'exited') { clearTimeout(timer); watcher.close(); resolve(); } } catch { /* Atomic rename transient. */ }
    });
  });
  assert.match(fs.readFileSync(path.join(started.journalDir, 'stdout.log'), 'utf8'), /"result":"done"/);
  const resumed = connect(s.socket); t.after(() => resumed.conn.destroy()); await once(resumed.conn, 'connect');
  resumed.send({ op: 'spawn', project: s.dir, args: [s.cli, '--resume', 'native-id'], env: {}, hostname: os.hostname() }); await resumed.wait('started'); resumed.send({ op: 'eof' }); assert.equal((await resumed.wait('exit')).code, 0);
});
test('native failure code is propagated and the supervisor stays available', async t => {
  const s = await service(t), client = connect(s.socket); t.after(() => client.conn.destroy()); await once(client.conn, 'connect');
  client.send({ op: 'spawn', project: s.dir, args: [s.cli, '--exit-seven'], env: {}, hostname: os.hostname() }); assert.equal((await client.wait('exit')).code, 7);
  const observer = connect(s.socket); t.after(() => observer.conn.destroy()); await once(observer.conn, 'connect'); observer.send({ op: 'probe' }); assert.equal((await observer.wait('ready')).status, 'ready');
});
