'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const cp = require('node:child_process');
const { once } = require('node:events');
const { createReconnect } = require('../reconnect.cjs');
const C = require('../common.cjs');

test('bounded replay preserves sequence and fails closed after eviction', () => {
  const r = createReconnect(200);
  const one = r.output({ op: 'stdout', data: 'one' }), two = r.output({ op: 'stderr', data: 'two' });
  assert.equal(one.seq, 1); assert.equal(two.seq, 2); assert.deepEqual(r.replay(1), [two]);
  r.acknowledge(1); assert.throws(() => r.replay(0), /expired/);
  r.output({ op: 'stdout', data: 'x'.repeat(300) });
  assert.throws(() => r.replay(2), /expired/); assert.deepEqual(r.replay(3), []);
  assert.throws(() => r.acknowledge(4), /Invalid/); assert.throws(() => r.replay(-1), /invalid/);
});
test('input deduplication survives lost acknowledgements and rejects gaps', () => {
  const r = createReconnect(); let calls = 0;
  assert.equal(r.input(1, () => calls++), 1); assert.equal(r.input(1, () => calls++), 1);
  assert.throws(() => r.input(3, () => calls++), /sequence/); assert.equal(calls, 1);
  assert.throws(() => r.input(2, () => { throw new Error('not submitted'); }), /not submitted/);
  assert.equal(r.input(2, () => calls++), 2); assert.equal(calls, 2);
});
const fakeCli = `#!/usr/bin/env node
const fs=require('node:fs');
if(process.argv.includes('--version')){console.log('2.1.311 (Claude Code)');process.exit(0);}
let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);fs.appendFileSync('native-input.log',line+'\\n');
setTimeout(()=>{process.stdout.write(JSON.stringify({type:'result',result:'中文:'+process.pid})+'\\n');setTimeout(()=>process.exit(7),30);},line.includes('slow')?1000:80);
}});
`;
async function until(predicate, message) {
  const deadline = Date.now() + 8000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(message); await new Promise(r => setTimeout(r, 20)); }
}
async function service(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reconnect-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cli = path.join(dir, 'claude'), socket = path.join(dir, 'server.sock'), descriptor = path.join(dir, 'descriptor.json');
  fs.writeFileSync(cli, fakeCli, { mode: 0o700 });
  const server = cp.spawn(process.execPath, [process.env.CLAUDE_TEST_SERVER || path.resolve(__dirname, '../server.cjs'), dir, socket, descriptor], {
    env: { ...process.env, HOME: dir, SLURM_JOB_ID: '123', CLAUDE_BACKEND_CLI: cli }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; server.stdout.on('data', b => { log += b; }); server.stderr.on('data', b => { log += b; });
  t.after(async () => { if (server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); } });
  await until(() => log.includes('CLAUDE_BACKEND_READY'), 'No isolated supervisor: ' + log);
  return { dir, cli, socket, descriptor };
}
for (const failure of ['input_ack', 'input_ack-active', 'stdout', 'started', 'unavailable']) test(`real wrapper recovers ${failure} loss without duplicate input/output or a new native PID`, async t => {
  const s = await service(t), proxyPath = path.join(s.dir, 'proxy.sock');
  let dropped = false, spawns = 0, connects = 0;
  const sockets = new Set();
  const proxy = net.createServer(front => {
    connects++; sockets.add(front);
    const back = net.createConnection(s.socket); sockets.add(back);
    for (const socket of [front, back]) { socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); }
    if (failure === 'unavailable' && connects > 1) { front.destroy(); back.destroy(); return; }
    const sendBack = C.channel(front, frame => { if (frame.op === 'spawn') spawns++; back.write(JSON.stringify(frame) + '\n'); });
    C.channel(back, frame => {
      if (!dropped && frame.op === (failure === 'unavailable' ? 'input_ack' : failure.replace('-active', ''))) { dropped = true; front.destroy(); back.destroy(); }
      else sendBack(frame);
    });
    front.on('close', () => back.destroy()); back.on('close', () => front.destroy());
  });
  await new Promise(resolve => proxy.listen(proxyPath, resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); proxy.close(); });
  const runner = `const net=require('node:net');const T=require(${JSON.stringify(path.resolve(__dirname, '../transport.cjs'))});
T.stream=()=>{const socket=net.createConnection(${JSON.stringify(proxyPath)});return {input:socket,output:socket,close:()=>socket.destroy(),opened:new Promise((r,j)=>{socket.once('connect',r);socket.once('error',j)})}};
require(${JSON.stringify(path.resolve(__dirname, '../wrapper.cjs'))}).run(${JSON.stringify(s.descriptor)},[${JSON.stringify(s.cli)}],${JSON.stringify(s.dir)}).then(c=>process.exitCode=c).catch(e=>{console.error(e.message);process.exitCode=1});`;
  const wrapper = cp.spawn(process.execPath, ['-e', runner], { env: { ...process.env, HOME: s.dir }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (wrapper.exitCode === null) wrapper.kill('SIGKILL'); });
  let out = '', err = ''; wrapper.stdout.on('data', b => { out += b; }); wrapper.stderr.on('data', b => { err += b; });
  const ended = once(wrapper, 'exit');
  if (failure !== 'started') {
    await until(() => fs.existsSync(path.join(s.dir, '.local/state/claude-backend/receipts')) && fs.readdirSync(path.join(s.dir, '.local/state/claude-backend/receipts')).length, 'wrapper has no started receipt');
    wrapper.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: failure.endsWith('-active') ? 'slow' : 'once' } }) + '\n');
  }
  const [code] = await Promise.race([ended, new Promise((_, reject) => setTimeout(() => reject(new Error('wrapper stuck: ' + err)), 10000).unref())]);
  assert.equal(spawns, 1, 'recovery must never launch a second native process');
  if (failure === 'started') {
    assert.equal(code, 1); assert.equal(connects, 1, 'unknown launch outcome must not be retried'); assert.match(err, /not a native Claude exit/); return;
  }
  if (failure === 'unavailable') {
    assert.equal(code, 1); assert.equal(connects, 5, 'only four reconnect attempts'); assert.match(err, /not a native Claude exit/); return;
  }
  assert.equal(code, 7, err); assert.ok(connects >= 2); assert.match(err, /transport restored/);
  assert.equal(fs.readFileSync(path.join(s.dir, 'native-input.log'), 'utf8').trim().split('\n').length, 1);
  const receiptsDir = path.join(s.dir, '.local/state/claude-backend/receipts');
  const receipt = C.readJson(path.join(receiptsDir, fs.readdirSync(receiptsDir)[0]));
  assert.deepEqual(out.trim().split('\n').map(JSON.parse), [{ type: 'result', result: '中文:' + receipt.pid }]);
  assert.equal(receipt.connected, false);
});
test('wrong reconnect token/identity cannot steal a session or launch a process', async t => {
  const s = await service(t), first = net.createConnection(s.socket); t.after(() => first.destroy()); await once(first, 'connect');
  let started; const send = C.channel(first, value => { if (value.op === 'started') started = value; });
  send({ op: 'spawn', protocol: 'resume-v1', args: [s.cli], project: s.dir, env: {} }); await until(() => started, 'no native identity');
  const second = net.createConnection(s.socket); second.on('error', () => {}); t.after(() => second.destroy()); await once(second, 'connect');
  let error; const sendSecond = C.channel(second, value => { if (value.op === 'error') error = value.error; });
  sendSecond({ op: 'reconnect', id: started.id, pid: started.pid, startTicks: started.startTicks, token: 'wrong', afterSeq: 0 });
  await until(() => error, 'wrong token was not rejected'); assert.match(error, /identity changed/);
  send({ op: 'input', seq: 1, data: Buffer.from('{"type":"user"}\n').toString('base64') });
  await until(() => fs.existsSync(path.join(s.dir, 'native-input.log')), 'original session lost ownership');
});
