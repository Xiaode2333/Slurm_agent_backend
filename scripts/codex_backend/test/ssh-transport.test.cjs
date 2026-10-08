'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');
const { WebSocketServer } = require('ws');
const C = require('../common.cjs');
const T = require('../ssh-transport.cjs');
const { relay } = require('../relay.cjs');

test('SSH verification pins process identity and rejects shell/option injection', t => {
  for (const host of ['-oProxyCommand=sh', 'node;touch injected', 'user@node', '$(id)', '../node']) {
    assert.throws(() => T.sshHost(host), /hostname/);
  }
  assert.equal(T.sshHost('backend.example.org'), 'backend.example.org');
  assert.ok(T.SSH_OPTIONS.includes('BatchMode=yes'));
  assert.ok(T.SSH_OPTIONS.includes('StrictHostKeyChecking=yes'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-verify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'backend.json');
  C.writeJson(file, { schema: 'codex_backend_v1', id: 'changed' });
  assert.throws(() => T.verify(file, 'old-fingerprint'), /changed/);
  assert.throws(() => C.validateDescriptor({ ...C.readJson(file), status: 'ready', hostname: os.hostname(),
    cli: C.CLI, version: C.CLI_VERSION, project: root, pid: process.pid, startTicks: 'old' }, root), /stale/);
});

test('cross-node SSH Unix forwarding supports real RPC, relay receipts and reuse without starting a backend', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-transport-test-'));
  const socket = path.join(root, 'backend.sock');
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const seen = [];
  wss.on('connection', ws => ws.on('message', bytes => {
    const m = JSON.parse(bytes); seen.push(m);
    if (m.method === 'initialize') ws.send(JSON.stringify({ id: m.id, result: { userAgent: `codex_vscode/${C.CLI_VERSION}` } }));
    if (m.method === 'thread/list') ws.send(JSON.stringify({ id: m.id, result: { data: [{ id: 'existing-thread' }], nextCursor: null } }));
  }));
  await new Promise(resolve => server.listen(socket, resolve)); fs.chmodSync(socket, 0o600);
  const descriptor = { schema: 'codex_backend_v1', id: 'remote-existing', status: 'ready', hostname: 'remote.example',
    jobId: '42', project: root, cli: C.CLI, version: C.CLI_VERSION, socket,
    pid: process.pid, startTicks: C.processIdentity(process.pid) };
  const file = path.join(root, 'backends', 'remote.json'); C.writeJson(file, descriptor);
  const fakeSsh = path.join(root, 'fake-ssh.cjs');
  fs.writeFileSync(fakeSsh, `const net=require('net'),fs=require('fs');
const args=process.argv.slice(2); const [local,remote]=args[args.indexOf('-L')+1].split(':');
const sockets=new Set(); const server=net.createServer(a=>{const b=net.createConnection(remote); sockets.add(a);sockets.add(b); a.pipe(b).pipe(a); a.on('error',()=>b.destroy());b.on('error',()=>a.destroy());});
server.listen(local,()=>fs.chmodSync(local,0o600)); process.on('SIGTERM',()=>{for(const s of sockets)s.destroy();server.close(()=>process.exit());});`);
  let forward;
  const verifyRemote = (f, d) => {
    assert.equal(f, file); assert.equal(T.fingerprint(d), T.fingerprint(descriptor));
    C.validateDescriptor(d, root, d.hostname);
    return d;
  };
  const spawnSsh = (command, args, options) => {
    assert.equal(command, 'ssh'); assert.ok(args.includes('ExitOnForwardFailure=yes'));
    assert.ok(args.includes('StreamLocalBindMask=0177'));
    forward = spawn(process.execPath, [fakeSsh, ...args], options); return forward;
  };
  t.after(() => {
    forward?.kill('SIGTERM');
    for (const ws of wss.clients) ws.terminate(); wss.close(); server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const selected = await T.ensure(file, { root, verifyRemote, spawnSsh });
  t.after(() => fs.rmSync(path.dirname(selected.descriptor.socket), { recursive: true, force: true }));
  assert.equal(selected.descriptor.transport.kind, 'ssh-unix-v1');
  assert.equal(selected.descriptor.hostname, 'remote.example');
  assert.equal(selected.descriptor.pid, descriptor.pid);
  const reused = await T.ensure(file, { root, verifyRemote, spawnSsh: () => { throw new Error('must reuse'); } });
  assert.equal(reused.descriptor.transport.pid, forward.pid);
  assert.equal(C.selectBackend({ root, project: root, env: {} }).file, selected.file);
  const input = new PassThrough(), output = new PassThrough(); output.resume();
  const run = relay({ descriptor: selected.descriptor, root, input, output, hook: 'cross-node-window' });
  input.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex_vscode' } } }) + '\n');
  input.write(JSON.stringify({ id: 2, method: 'thread/list', params: {} }) + '\n');
  const receipt = await C.waitForFile(C.receiptPath(root, selected.descriptor.socket, 'cross-node-window'), r => r.listCompleted, 5000);
  assert.equal(receipt.hostname, os.hostname()); assert.equal(receipt.backendPid, descriptor.pid);
  assert.deepEqual(receipt.threadIds, ['existing-thread']); input.end(); await run;
  assert.equal(seen.some(m => ['thread/start', 'turn/start', 'turn/interrupt'].includes(m.method)), false);
  assert.throws(() => C.validateDescriptor({ ...selected.descriptor, transport: { ...selected.descriptor.transport, startTicks: 'stale' } }, root), /stale/);
  C.writeJson(file, { ...descriptor, startTicks: 'replaced' });
  assert.throws(() => C.validateDescriptor(selected.descriptor, root), /stale/);
  await assert.rejects(T.ensure(file, { root, verifyRemote: () => { throw new Error('remote process stopped'); }, spawnSsh }), /stopped/);
});

test('unreachable remote verification never starts a forwarding process or a fallback backend', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-denied-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'remote.json');
  C.writeJson(file, { hostname: 'remote.example' });
  await assert.rejects(T.ensure(file, { root,
    verifyRemote: () => { throw new Error('SSH authentication denied'); },
    spawnSsh: () => { assert.fail('must not launch anything'); },
  }), /denied/);
});
