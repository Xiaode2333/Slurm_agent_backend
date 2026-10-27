'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { extensionProfile, createIdeHooks } = require('../ide-hooks.cjs');
const C = require('../common.cjs');
const hooks = () => ({
  PreToolUse: [
    { matcher: 'Edit|Write|MultiEdit', hookCallbackIds: ['hook_0'] },
    { matcher: 'Edit|Write|Read', hookCallbackIds: ['hook_1'] },
  ],
  PostToolUse: [{ matcher: 'Edit|Write|MultiEdit', hookCallbackIds: ['hook_2'] }],
});
const initialize = (h = hooks()) => ({ type: 'control_request', request_id: 'init', request: { subtype: 'initialize', hooks: h } });
const callback = (id = 'one', callbackId = 'hook_0', event = 'PreToolUse', tool = 'Write') => ({ type: 'control_request', request_id: id, request: { subtype: 'hook_callback', callback_id: callbackId, input: { hook_event_name: event, tool_name: tool, tool_input: { file_path: '/tmp/中文.txt' } } } });
const bytes = value => Buffer.from(JSON.stringify(value) + '\n');
function policy(profile = 'vscode-2.1.311') {
  const writes = [], events = [], states = [];
  return { writes, events, states, p: createIdeHooks({ profile, write: b => writes.push(JSON.parse(b)), audit: e => events.push(e), changed: s => states.push(s) }) };
}
test('known UI callbacks wait for the attached host, then finish on detach without permission decisions', () => {
  const { p, writes, events } = policy(); p.input(bytes(initialize()));
  p.output(bytes(callback())); assert.equal(writes.length, 0);
  p.detach(); assert.deepEqual(writes, [{ type: 'control_response', response: { subtype: 'success', request_id: 'one', response: { continue: true } } }]);
  p.output(bytes(callback('two', 'hook_1', 'PreToolUse', 'Read')));
  p.output(bytes(callback('three', 'hook_2', 'PostToolUse', 'Edit')));
  p.detach(); assert.equal(writes.length, 3); assert.equal(events.length, 3);
  p.attach(); p.output(bytes(callback('four'))); assert.equal(writes.length, 3);
  p.input(bytes({ type: 'control_response', response: { request_id: 'four', subtype: 'success', response: { continue: false } } }));
  p.detach(); assert.equal(writes.length, 3, 'do not overwrite a real hook response');
});
test('permissions, security/unknown hooks, MCP and dialogs are never approved', () => {
  const { p, writes } = policy(); p.input(bytes(initialize())); p.detach();
  for (const request of [
    { subtype: 'can_use_tool', tool_name: 'Write', input: {} },
    { subtype: 'mcp_message', server_name: 'claude-vscode', message: {} },
    { subtype: 'elicitation' }, { subtype: 'request_user_dialog' },
  ]) p.output(bytes({ type: 'control_request', request_id: request.subtype, request }));
  p.output(bytes(callback('unknown', 'security_hook')));
  p.output(bytes(callback('wrong-event', 'hook_0', 'PermissionRequest')));
  p.output(bytes(callback('wrong-tool', 'hook_0', 'PreToolUse', 'Bash')));
  assert.equal(writes.length, 0); assert.equal(p.state.waiting.length, 7);
});
test('unverified bundles and any changed registration keep native behavior', () => {
  for (const [profile, mutate] of [
    [null, h => h],
    ['vscode-2.1.311', h => { h.PreToolUse[0].timeout = 600; return h; }],
    ['vscode-2.1.311', h => { h.PreToolUse.push({ matcher: '*', hookCallbackIds: ['security'] }); return h; }],
    ['vscode-2.1.311', h => { h.PreToolUse[0].hookCallbackIds = ['hook_9']; return h; }],
    ['vscode-2.1.311', h => { h.PermissionRequest = []; return h; }],
  ]) {
    const { p, writes } = policy(profile); p.input(bytes(initialize(mutate(hooks())))); p.output(bytes(callback())); p.detach();
    assert.equal(p.state.registered, false); assert.equal(writes.length, 0);
  }
});
test('canceled callbacks are not answered and fragmented UTF-8/JSONL is inspected correctly', () => {
  const { p, writes } = policy();
  for (const byte of bytes(initialize())) p.input(Buffer.from([byte]));
  for (const byte of bytes(callback())) p.output(Buffer.from([byte]));
  p.output(bytes({ type: 'control_cancel_request', request_id: 'one' })); p.detach(); assert.equal(writes.length, 0);
  const all = Buffer.concat([bytes(callback('two')), bytes(callback('three', 'hook_2', 'PostToolUse', 'MultiEdit'))]);
  for (const byte of all) p.output(Buffer.from([byte]));
  assert.equal(writes.length, 2);
});
test('oversized lines cannot be parsed as a valid suffix; subsequent complete frames recover', () => {
  const { p, writes } = policy(); p.input(bytes(initialize())); p.detach();
  p.output(Buffer.from('x'.repeat(2 * 1024 * 1024 + 1))); p.output(bytes(callback('ignored')));
  assert.equal(writes.length, 0); p.output(bytes(callback('valid'))); assert.equal(writes.length, 1);
});
test('lookalike extension metadata or executable paths cannot establish a trusted profile', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ide-profile-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ publisher: 'Anthropic', name: 'claude-code', version: '2.1.311' }));
  fs.writeFileSync(path.join(dir, 'extension.js'), 'uninspected callbacks');
  const request = { args: [path.join(dir, 'resources/native-binary/claude')], env: { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' } };
  assert.equal(extensionProfile({ version: '2.1.311' }, request), null);
  assert.equal(extensionProfile({ version: '2.1.311' }, { ...request, args: ['/bin/claude'] }), null);
  assert.equal(extensionProfile({ version: '2.1.311' }, { ...request, env: {} }), null);
});
async function until(predicate, message) {
  const deadline = Date.now() + 8000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(message); await new Promise(r => setTimeout(r, 20)); }
}
function client(socket, numbered = false) {
  let seq = 0;
  const conn = net.createConnection(socket), frames = [];
  conn.on('error', () => {});
  const send = C.channel(conn, frame => frames.push(frame));
  const output = () => frames.filter(f => f.op === 'stdout').map(f => Buffer.from(f.data, 'base64').toString()).join('');
  return { conn, frames, send, output, input: v => send({ op: 'input', ...(numbered ? { seq: ++seq } : {}), data: bytes(v).toString('base64') }) };
}
const fixtureCli = `#!/usr/bin/env node
const fs=require('node:fs');
if(process.argv.includes('--version')){console.log('2.1.311 (Claude Code)');process.exit(0);}
const requests=${JSON.stringify([callback('pre', 'hook_0'), callback('save', 'hook_1', 'PreToolUse', 'Read'), callback('post', 'hook_2', 'PostToolUse', 'Write')])};
const emit=x=>console.log(JSON.stringify(x));let buffer='',next=0;
process.stdin.on('data',c=>{buffer+=c;let i;while((i=buffer.indexOf('\\n'))>=0){const s=buffer.slice(0,i);buffer=buffer.slice(i+1);const v=JSON.parse(s);fs.appendFileSync('native-input.jsonl',s+'\\n');
if(v.type==='control_request')emit({type:'control_response',response:{subtype:'success',request_id:v.request_id,response:{}}});
if(v.type==='user')emit(requests[next++]);
if(v.type==='control_response'&&['pre','save','post'].includes(v.response.request_id)){
 if(next<requests.length)emit(requests[next++]);else {emit({type:'result',result:'all IDE callbacks finished while detached',session_id:'native-fixture'});emit({type:'control_request',request_id:'permission',request:{subtype:'can_use_tool',tool_name:'Write',input:{file_path:'/unapproved'}}});}
}
}});
`;
for (const mode of ['detach', 'eof', 'socket-close', 'signal', 'settled-reconnect']) test(`real supervisor: ${mode} finishes IDE hooks offline, preserves permissions and reattaches the same PID`, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-hooks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cli = path.join(dir, 'claude'), socket = path.join(dir, 'app.sock'), file = path.join(dir, 'descriptor.json');
  fs.writeFileSync(cli, fixtureCli, { mode: 0o700 });
  // Only mock bundle provenance. All transport, native I/O, detach and receipt
  // handling run in the real supervisor with an isolated HOME/socket/worker.
  const serverFile = process.env.CLAUDE_TEST_SERVER || path.resolve(__dirname, '../server.cjs');
  const runner = `require(${JSON.stringify(serverFile)}).serve(...process.argv.slice(1), {inspectExtension:()=> 'vscode-2.1.311'}).catch(e=>{console.error(e);process.exit(1)});`;
  const server = spawn(process.execPath, ['-e', runner, dir, socket, file], { env: { ...process.env, HOME: dir, SLURM_JOB_ID: 'offline-test', CLAUDE_BACKEND_CLI: cli }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; server.stdout.on('data', b => { logs += b; }); server.stderr.on('data', b => { logs += b; });
  t.after(async () => { if (server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); } });
  await until(() => logs.includes('CLAUDE_BACKEND_READY'), 'supervisor not ready: ' + logs);
  const first = client(socket, mode === 'settled-reconnect'); t.after(() => first.conn.destroy()); await once(first.conn, 'connect');
  const spawnRequest = { op: 'spawn', ...(mode === 'settled-reconnect' ? { protocol: 'resume-v1' } : {}), project: dir, args: [cli, '--input-format=stream-json', '--resume=native-fixture'], env: {}, hostname: os.hostname() };
  first.send(spawnRequest); await until(() => first.frames.some(f => f.op === 'started'), 'native process not started');
  const started = first.frames.find(f => f.op === 'started');
  first.input(initialize()); first.input({ type: 'user', message: { role: 'user', content: 'work' } });
  await until(() => first.output().includes('"request_id":"pre"'), 'no attached PreToolUse callback');
  if (mode === 'socket-close') first.conn.destroy();
  else if (mode === 'signal') first.send({ op: 'signal', signal: 'SIGTERM' });
  else first.send({ op: mode === 'settled-reconnect' ? 'detach' : mode }); // Keep the old socket open to test stale ownership.
  const journal = path.join(started.journalDir, 'stdout.log');
  await until(() => fs.readFileSync(journal, 'utf8').includes('all IDE callbacks finished while detached'), 'detached tool pipeline stalled');
  const receipt = () => C.readJson(path.join(started.journalDir, 'session.json'));
  await until(() => receipt().ideHooks?.waiting.some(r => r.requestId === 'permission'), 'missing pending permission evidence');
  assert.equal(receipt().ideHooks.handled, 3); assert.equal(receipt().status, 'detached');
  assert.equal(fs.readFileSync(path.join(started.journalDir, 'events.jsonl'), 'utf8').trim().split('\n').length, 3);
  let native = fs.readFileSync(path.join(dir, 'native-input.jsonl'), 'utf8');
  assert.equal(native.includes('"request_id":"permission"'), false, 'no synthetic permission response');
  if (mode === 'settled-reconnect') {
    const resumed = client(socket); t.after(() => resumed.conn.destroy()); await once(resumed.conn, 'connect');
    resumed.send({ op: 'reconnect', id: started.id, pid: started.pid, startTicks: started.startTicks, token: started.reconnectToken, afterSeq: 0 });
    await until(() => resumed.frames.some(f => f.op === 'error'), 'settled IDE callbacks were unsafely replayed');
    assert.match(resumed.frames.find(f => f.op === 'error').error, /callbacks already settled/);
    assert.equal(resumed.output(), ''); return;
  }
  if (mode !== 'socket-close') {
    first.input({ type: 'control_response', response: { subtype: 'success', request_id: 'permission', response: { behavior: 'allow' } } });
    await until(() => first.frames.some(f => f.op === 'error'), 'detached client input was not rejected');
    native = fs.readFileSync(path.join(dir, 'native-input.jsonl'), 'utf8'); assert.equal(native.includes('"behavior":"allow"'), false);
  }
  const second = client(socket); t.after(() => second.conn.destroy()); await once(second.conn, 'connect'); second.send(spawnRequest);
  await until(() => second.frames.some(f => f.op === 'started'), 'no reattachment');
  assert.equal(second.frames.find(f => f.op === 'started').pid, started.pid);
  assert.equal(second.frames.find(f => f.op === 'started').reattached, true);
  second.input({ type: 'control_response', response: { subtype: 'success', request_id: 'permission', response: { behavior: 'deny', message: 'explicit test denial' } } });
  await until(() => fs.readFileSync(path.join(dir, 'native-input.jsonl'), 'utf8').includes('explicit test denial'), 'explicit native denial was not forwarded');
});
