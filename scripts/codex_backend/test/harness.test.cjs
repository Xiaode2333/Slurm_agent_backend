'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');
const { consumeJsonl } = require('../jsonl.cjs');
const { broker } = require('../harness-broker.cjs');
const { spec, root: harnessRoot } = require('../harness.cjs');
const C = require('../common.cjs');

test('adapters preserve native interfaces and do not invent tool approvals', () => {
  assert.deepEqual(spec('opencode', 'native').args, ['serve', '--hostname', '127.0.0.1', '--port', '0']);
  assert.deepEqual(spec('pi', 'rpc', ['--session', 'existing']).args, ['--mode', 'rpc', '--session', 'existing']);
  assert.deepEqual(spec('claude-code', 'rpc').args, ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']);
  assert.equal(spec('pi', 'native').transport, 'tmux');
  assert.equal(spec('claude-code', 'native').transport, 'tmux');
  assert.throws(() => spec('unknown', 'native'), /Harness/);
  assert.throws(() => spec('opencode', 'rpc'), /HTTP/);
});

test('JSONL parser preserves split UTF-8 and Unicode separators', () => {
  const stream = new PassThrough(), values = [], errors = [];
  consumeJsonl(stream, v => values.push(v), e => errors.push(e));
  const value = { text: '中文\u2028still one\u2029record' };
  const bytes = Buffer.from(JSON.stringify(value) + '\r\n');
  for (const byte of bytes) stream.write(Buffer.from([byte]));
  stream.end(); assert.deepEqual(values, [value]); assert.deepEqual(errors, []);
});

async function client(socket, readOnly = false, from = 0) {
  const connection = net.createConnection(socket), records = [], waiters = [];
  consumeJsonl(connection, record => { records.push(record); for (const waiter of [...waiters]) if (waiter.predicate(record)) { waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(record); } }, () => {});
  const wait = predicate => {
    const found = records.find(predicate); if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => { const waiter = { predicate, resolve }; waiter.timer = setTimeout(() => reject(new Error('Client record timeout')), 3000); waiters.push(waiter); });
  };
  connection.once('connect', () => connection.write(JSON.stringify({ action: 'attach', readOnly, from }) + '\n'));
  return { connection, records, wait };
}

test('broker survives client loss, replays events and rejects competing input', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['-e', `
let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const v=JSON.parse(b.slice(0,i));b=b.slice(i+1);setTimeout(()=>console.log(JSON.stringify({echo:v})),30)}});
`], { stdio: ['pipe', 'pipe', 'ignore'] });
  const socket = path.join(root, 'rpc.sock'), journal = path.join(root, 'events.jsonl');
  const service = await broker(child, socket, journal);
  t.after(async () => { child.kill(); await service.done; await service.close(); });
  const first = await client(socket); t.after(() => first.connection.destroy());
  await first.wait(v => v.attached);
  first.connection.write(JSON.stringify({ id: 'one', type: 'prompt', message: 'synthetic' }) + '\n');
  const competing = await client(socket); t.after(() => competing.connection.destroy());
  assert.match((await competing.wait(v => v.error)).error, /controller/);
  const observer = await client(socket, true); t.after(() => observer.connection.destroy());
  await observer.wait(v => v.attached);
  observer.connection.write(JSON.stringify({ id: 'forbidden', type: 'extension_ui_response' }) + '\n');
  assert.match((await observer.wait(v => v.error)).error, /Read-only/);
  const closed = new Promise(resolve => first.connection.once('close', resolve)); first.connection.destroy(); await closed;
  await observer.wait(v => v.record?.echo?.id === 'one');
  assert.equal(child.exitCode, null);
  const next = await client(socket); t.after(() => next.connection.destroy());
  await next.wait(v => v.attached);
  assert.equal((await next.wait(v => v.record?.echo?.id === 'one')).seq, 1);
  next.connection.write(JSON.stringify({ id: 'two', type: 'get_state' }) + '\n');
  assert.equal((await next.wait(v => v.record?.echo?.id === 'two')).seq, 2);
  assert.equal(fs.statSync(journal).mode & 0o777, 0o600);
  assert.equal(observer.records.some(v => v.record?.echo?.id === 'forbidden'), false);
});

test('attach sends its handshake before buffered native stdin and disconnects only the client', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-attach-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['-e', `
let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){console.log(JSON.stringify({echo:JSON.parse(b.slice(0,i))}));b=b.slice(i+1)}});
`], { stdio: ['pipe', 'pipe', 'ignore'] });
  const socket = path.join(root, 'rpc.sock');
  const service = await broker(child, socket, path.join(root, 'events.jsonl'));
  t.after(async () => { child.kill(); await service.done; await service.close(); });
  const jobId = `attach-test-${require('node:crypto').randomUUID()}`;
  const registered = path.join(harnessRoot(), 'services', jobId + '.json');
  t.after(() => fs.rmSync(registered, { force: true }));
  C.writeJson(registered, {
    harness: 'pi', project: root, hostname: os.hostname(), jobId, status: 'ready', transport: 'jsonl',
    socket, pid: process.pid, startTicks: C.processIdentity(process.pid),
  });
  const attaching = spawn(process.execPath, [path.resolve(__dirname, '../harness.cjs'), 'attach', 'pi', root], {
    env: { ...process.env, AGENT_BACKEND_JOB: jobId }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => attaching.kill());
  const records = [];
  consumeJsonl(attaching.stdout, value => records.push(value), error => assert.fail(error));
  const completed = new Promise(resolve => attaching.once('exit', resolve));
  attaching.stdin.end(JSON.stringify({ id: 'buffered', type: 'get_state' }) + '\n');
  assert.equal(await completed, 0);
  assert.equal(records[0]?.attached, true);
  assert.equal(records.some(record => record.error), false);
  assert.equal(child.exitCode, null);
  const observer = await client(socket, true); t.after(() => observer.connection.destroy());
  assert.equal((await observer.wait(v => v.record?.echo?.id === 'buffered')).record.echo.type, 'get_state');
});
