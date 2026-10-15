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
let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){let s=b.slice(0,i);b=b.slice(i+1);let r=JSON.parse(s);if(r.type==='control_request')console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:r.request_id,response:{}}}));if(r.type==='user'){const id=r.session_id||'native-id';console.log(JSON.stringify({type:'system',subtype:'init',session_id:id,version:'2.9.321'}));if(r.message&&r.message.content==='background'){console.log(JSON.stringify({type:'system',subtype:'task_started',task_id:'bg1',is_backgrounded:true,session_id:id}));setTimeout(()=>console.log(JSON.stringify({type:'system',subtype:'task_notification',task_id:'bg1',status:'completed',session_id:id})),1200);}setTimeout(()=>console.log(JSON.stringify({type:'result',session_id:id,result:'done'})),300);}}});
`;
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-test-'));
  const cli = path.join(dir, 'claude'); fs.writeFileSync(cli, fakeCode, { mode: 0o700 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, cli };
}
async function service(t, extraEnv = {}) {
  const { dir, cli } = fixture(t), socket = path.join(dir, 'app.sock'), file = path.join(dir, 'descriptor.json');
  const child = cp.spawn(process.execPath, [path.join(__dirname, '../server.cjs'), dir, socket, file], {
    env: { ...process.env, HOME: dir, SLURM_JOB_ID: '99111', CLAUDE_BACKEND_CLI: cli, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  // Interactive stream-json: client EOF is a detach, never native shutdown.
  client.send({ op: 'eof' }); await new Promise(r => setTimeout(r, 300));
  assert.ok(alive(started.pid)); assert.equal(C.readJson(path.join(started.journalDir, 'session.json')).status, 'detached');
});
test('one-shot (non-streaming) EOF still ends the native process', async t => {
  const s = await service(t), client = connect(s.socket); t.after(() => client.conn.destroy()); await once(client.conn, 'connect');
  client.send({ op: 'spawn', project: s.dir, args: [s.cli, '--print'], env: {}, hostname: os.hostname() });
  await client.wait('started'); client.send({ op: 'eof' }); assert.equal((await client.wait('exit')).code, 0);
});
test('computer off: wrapper stdin closes then the wrapper dies; busy or idle streaming sessions survive', async t => {
  const s = await service(t);
  for (const content of ['work', null]) {
    const wrapper = cp.spawn(process.execPath, [path.join(__dirname, '../wrapper.cjs'), s.file, s.cli, '--input-format', 'stream-json', '--output-format', 'stream-json'], { env: { ...process.env, HOME: s.dir }, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { if (wrapper.exitCode === null) wrapper.kill('SIGKILL'); });
    let out = ''; wrapper.stdout.on('data', c => { out += c; });
    const marker = content ? '"init"' : 'boot';
    wrapper.stdin.write(JSON.stringify(content ? { type: 'user', session_id: 'native-' + content, message: { role: 'user', content } } : { type: 'control_request', request_id: 'boot', request: { subtype: 'initialize' } }) + '\n');
    const deadline = Date.now() + 5000;
    while (!out.includes(marker)) { if (Date.now() > deadline) throw new Error('wrapper produced no output'); await new Promise(r => setTimeout(r, 50)); }
    wrapper.stdin.end(); await new Promise(r => setTimeout(r, 200)); wrapper.kill('SIGKILL'); await once(wrapper, 'exit');
  }
  await new Promise(r => setTimeout(r, 1000));
  const observer = connect(s.socket); t.after(() => observer.conn.destroy()); await once(observer.conn, 'connect');
  observer.send({ op: 'probe' }); const { sessions } = await observer.wait('ready');
  assert.equal(sessions.length, 2);
  for (const session of sessions) { assert.equal(session.status, 'detached'); assert.ok(alive(session.pid)); }
});
const input = value => ({ op: 'input', data: Buffer.from(JSON.stringify(value) + '\n').toString('base64') });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitExited(journalDir, ms = 5000) {
  const receipt = path.join(journalDir, 'session.json');
  await new Promise((resolve, reject) => {
    const check = () => { try { if (C.readJson(receipt).status === 'exited') { clearTimeout(timer); watcher.close(); resolve(); } } catch { /* Atomic rename transient. */ } };
    const timer = setTimeout(() => { watcher.close(); reject(new Error('session did not exit')); }, ms);
    const watcher = fs.watch(journalDir, check); check();
  });
}
test('client loss keeps the native process; a resumed window reattaches to it', async t => {
  const s = await service(t), client = connect(s.socket); await once(client.conn, 'connect');
  client.send({ op: 'spawn', project: s.dir, args: [s.cli], env: {}, hostname: os.hostname() });
  const started = await client.wait('started');
  client.send(input({ type: 'user', session_id: 'native-id', message: { role: 'user', content: 'work' } }));
  await client.wait('stdout'); client.conn.destroy();
  const resumed = connect(s.socket); t.after(() => resumed.conn.destroy()); await once(resumed.conn, 'connect');
  resumed.send({ op: 'spawn', project: s.dir, args: [s.cli, '--resume=native-id'], env: {}, hostname: os.hostname() });
  const again = await resumed.wait('started');
  assert.equal(again.reattached, true); assert.equal(again.pid, started.pid);
  resumed.send(input({ type: 'control_request', request_id: 'second-init', request: { subtype: 'initialize' } }));
  const deadline = Date.now() + 5000;
  while (!resumed.frames.some(f => f.op === 'stdout' && Buffer.from(f.data, 'base64').toString().includes('second-init'))) {
    if (Date.now() > deadline) throw new Error('No reattached control response'); await new Promise(r => setTimeout(r, 50));
  }
  // A second live window may not steal an attached session.
  const competing = connect(s.socket); t.after(() => competing.conn.destroy()); await once(competing.conn, 'connect');
  competing.send({ op: 'spawn', project: s.dir, args: [s.cli, '--resume', 'native-id'], env: {}, hostname: os.hostname() });
  assert.match((await competing.wait('error')).error, /attached to another window/);
  resumed.send({ op: 'eof' }); assert.equal((await resumed.wait('exit')).code, 0);
  assert.match(fs.readFileSync(path.join(started.journalDir, 'stdout.log'), 'utf8'), /"result":"done"/);
});
test('window reload TERM/HUP detaches instead of killing native work', async t => {
  const s = await service(t), client = connect(s.socket); t.after(() => client.conn.destroy()); await once(client.conn, 'connect');
  client.send({ op: 'spawn', project: s.dir, args: [s.cli], env: {}, hostname: os.hostname() });
  const started = await client.wait('started');
  client.send({ op: 'signal', signal: 'SIGTERM' }); client.send({ op: 'detach' });
  await new Promise(r => setTimeout(r, 300));
  assert.ok(alive(started.pid));
  assert.equal(C.readJson(path.join(started.journalDir, 'session.json')).status, 'detached');
  const observer = connect(s.socket); t.after(() => observer.conn.destroy()); await once(observer.conn, 'connect');
  observer.send({ op: 'probe' }); assert.equal((await observer.wait('ready')).sessions[0].status, 'detached');
});
test('an idle detached session ends after the grace period, then a fresh resume starts', async t => {
  const s = await service(t, { CLAUDE_BACKEND_DETACH_GRACE_SECONDS: '0.3' }), client = connect(s.socket); await once(client.conn, 'connect');
  client.send({ op: 'spawn', project: s.dir, args: [s.cli], env: {}, hostname: os.hostname() });
  const started = await client.wait('started');
  client.send(input({ type: 'user', session_id: 'native-id', message: { role: 'user', content: 'work' } }));
  await client.wait('stdout'); client.conn.destroy();
  await waitExited(started.journalDir);
  const resumed = connect(s.socket); t.after(() => resumed.conn.destroy()); await once(resumed.conn, 'connect');
  resumed.send({ op: 'spawn', project: s.dir, args: [s.cli, '--resume', 'native-id'], env: {}, hostname: os.hostname() });
  const fresh = await resumed.wait('started'); assert.notEqual(fresh.pid, started.pid); assert.equal(fresh.reattached, undefined);
  resumed.send({ op: 'eof' }); assert.equal((await resumed.wait('exit')).code, 0);
});
test('a detached background task keeps the session alive past the grace period', async t => {
  const s = await service(t, { CLAUDE_BACKEND_DETACH_GRACE_SECONDS: '0.2' }), client = connect(s.socket); await once(client.conn, 'connect');
  client.send({ op: 'spawn', project: s.dir, args: [s.cli], env: {}, hostname: os.hostname() });
  const started = await client.wait('started');
  client.send(input({ type: 'user', session_id: 'native-id', message: { role: 'user', content: 'background' } }));
  await client.wait('stdout'); client.conn.destroy();
  await new Promise(r => setTimeout(r, 900));
  assert.ok(alive(started.pid), 'background task must hold the detached session');
  await waitExited(started.journalDir);
});
test('SIGTERM to the real wrapper process detaches and leaves native work running', async t => {
  const s = await service(t);
  const wrapper = cp.spawn(process.execPath, [path.join(__dirname, '../wrapper.cjs'), s.file, s.cli], { env: { ...process.env, HOME: s.dir }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (wrapper.exitCode === null) wrapper.kill('SIGKILL'); });
  let out = ''; wrapper.stdout.on('data', c => { out += c; });
  wrapper.stdin.write(JSON.stringify({ type: 'user', session_id: 'native-id', message: { role: 'user', content: 'work' } }) + '\n');
  const deadline = Date.now() + 5000;
  while (!out.includes('"init"')) { if (Date.now() > deadline) throw new Error('wrapper produced no output'); await new Promise(r => setTimeout(r, 50)); }
  wrapper.kill('SIGTERM'); const [code] = await once(wrapper, 'exit'); assert.equal(code, 143);
  await new Promise(r => setTimeout(r, 300));
  const observer = connect(s.socket); t.after(() => observer.conn.destroy()); await once(observer.conn, 'connect');
  observer.send({ op: 'probe' }); const [session] = (await observer.wait('ready')).sessions;
  assert.equal(session.status, 'detached'); assert.ok(alive(session.pid));
});
test('native failure code is propagated and the supervisor stays available', async t => {
  const s = await service(t), client = connect(s.socket); t.after(() => client.conn.destroy()); await once(client.conn, 'connect');
  client.send({ op: 'spawn', project: s.dir, args: [s.cli, '--exit-seven'], env: {}, hostname: os.hostname() }); assert.equal((await client.wait('exit')).code, 7);
  const observer = connect(s.socket); t.after(() => observer.conn.destroy()); await once(observer.conn, 'connect'); observer.send({ op: 'probe' }); assert.equal((await observer.wait('ready')).status, 'ready');
});
