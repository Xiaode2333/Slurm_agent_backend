'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { PassThrough, Writable } = require('node:stream');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');
const C = require('../common.cjs');
const { relay, normalizeRequest } = require('../relay.cjs');
const { findHelper } = require('../connect.cjs');
const { recoverBackfill } = require('../server.cjs');

test('cold CLI version startup does not abort a healthy backend', t => {
  const childProcess = require('node:child_process');
  const commonPath = require.resolve('../common.cjs');
  const original = require.cache[commonPath];
  t.after(() => { require.cache[commonPath] = original; });
  let output = `codex-cli ${C.CLI_VERSION}\n`;
  t.mock.method(childProcess, 'execFileSync', (file, args, options) => {
    assert.equal(file, C.CLI);
    assert.deepEqual(args, ['--version']);
    // A healthy cold shared-filesystem launch can exceed the old ten-second limit.
    if (options.timeout < 15000) throw Object.assign(new Error('cold startup timed out'), { code: 'ETIMEDOUT' });
    return output;
  });
  delete require.cache[commonPath];
  const cold = require('../common.cjs');
  assert.equal(cold.checkCli(), C.CLI_VERSION);
  output = 'codex-cli incompatible\n';
  assert.throws(() => cold.checkCli(), /Unsupported CLI/);
});

test('runtime selects managed Node 22 when the terminal PATH contains another version', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outdated = path.join(root, 'old'); fs.mkdirSync(outdated);
  const managed = path.join(root, '.local/share/prime-agent-node/current/bin'); fs.mkdirSync(managed, { recursive: true });
  fs.writeFileSync(path.join(outdated, 'node'), '#!/bin/bash\necho v24.0.0\n', { mode: 0o700 });
  fs.writeFileSync(path.join(managed, 'node'), '#!/bin/bash\necho v22.23.2\n', { mode: 0o700 });
  const runtime = path.resolve(__dirname, '../runtime.sh');
  const chosen = require('node:child_process').execFileSync('/bin/bash', ['-c', 'source "$1"; printf "%s" "$node_bin"', 'bash', runtime], {
    env: { ...process.env, HOME: root, PATH: outdated + ':/usr/bin:/bin' }, encoding: 'utf8',
  });
  assert.equal(chosen, path.join(managed, 'node'));
});

test('bound launcher preserves literal descriptor paths and arguments without shell expansion', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-launcher-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const component = path.join(root, "component with 'quotes'"); fs.mkdirSync(component);
  fs.writeFileSync(path.join(component, 'launcher.sh'), '#!/usr/bin/env bash\nprintf "%s\\n" "$CODEX_BACKEND_DESCRIPTOR_FILE" "$@"\n', { mode: 0o700 });
  const descriptor = path.join(root, "literal $(touch injected) 'file.json");
  const launcher = C.connectionLauncher(component, descriptor, root);
  const result = require('node:child_process').execFileSync(launcher, ['app-server', 'literal $(touch injected)', 'a b'], { encoding: 'utf8', cwd: root });
  assert.deepEqual(result.trimEnd().split('\n'), [descriptor, 'app-server', 'literal $(touch injected)', 'a b']);
  assert.equal(fs.existsSync(path.join(root, 'injected')), false);
  assert.equal(C.connectionLauncher(component, descriptor, root), launcher);
});

test('interrupted bootstrap recovery retains indexed history and the rollout watermark', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bootstrap-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(root, 'state_5.sqlite'));
  db.exec("CREATE TABLE backfill_state(id INTEGER PRIMARY KEY,status TEXT,last_watermark TEXT); INSERT INTO backfill_state VALUES(1,'running','keep-watermark'); CREATE TABLE threads(id TEXT); INSERT INTO threads VALUES('existing-thread')");
  db.close(); recoverBackfill(root);
  const after = new DatabaseSync(path.join(root, 'state_5.sqlite'));
  assert.equal(after.prepare('SELECT status FROM backfill_state').get().status, 'pending');
  assert.equal(after.prepare('SELECT last_watermark FROM backfill_state').get().last_watermark, 'keep-watermark');
  assert.equal(after.prepare('SELECT id FROM threads').get().id, 'existing-thread');
  after.exec("UPDATE backfill_state SET status='complete'"); after.close();
  recoverBackfill(root);
  const complete = new DatabaseSync(path.join(root, 'state_5.sqlite'), { readOnly: true });
  assert.equal(complete.prepare('SELECT status FROM backfill_state').get().status, 'complete'); complete.close();
});

async function fixture(t, handle) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-backend-test-'));
  const socket = path.join(root, 'app.sock');
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const seen = [];
  wss.on('connection', ws => ws.on('message', bytes => {
    const message = JSON.parse(bytes); seen.push(message);
    if (message.id === undefined || !message.method) return;
    let result;
    if (message.method === 'initialize') result = { userAgent: `codex_vscode/${C.CLI_VERSION}` };
    else result = handle ? handle(message, ws) : { data: [], nextCursor: null };
    if (result !== undefined) ws.send(JSON.stringify({ id: message.id, result }));
  }));
  await new Promise(resolve => server.listen(socket, resolve));
  fs.chmodSync(socket, 0o600);
  const descriptor = { schema: 'codex_backend_v1', id: 'test', hostname: os.hostname(), jobId: '42',
    project: root, cli: C.CLI, version: C.CLI_VERSION, socket, pid: process.pid,
    startTicks: C.processIdentity(process.pid), status: 'ready' };
  t.after(() => {
    for (const ws of wss.clients) ws.terminate();
    wss.close(); server.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, socket, descriptor, seen, wss };
}

test('backend discovery selects allocation and rejects ambiguous, stale, or incompatible descriptors', async t => {
  const f = await fixture(t);
  const file = path.join(f.root, 'backends', 'one.json'); C.writeJson(file, f.descriptor);
  assert.equal(C.selectBackend({ root: f.root, project: f.root, env: { SLURM_JOB_ID: '42' } }).file, file);
  C.writeJson(path.join(f.root, 'backends', 'two.json'), { ...f.descriptor, jobId: '43' });
  assert.throws(() => C.selectBackend({ root: f.root, project: f.root, env: {} }), /found 2/);
  assert.equal(C.selectBackend({ root: f.root, project: f.root, env: { SLURM_JOB_ID: '42' } }).descriptor.jobId, '42');
  assert.throws(() => C.selectBackend({ root: f.root, project: f.root, env: { SLURM_JOB_ID: 'tunnel-job' } }), /found 2/);
  C.writeJson(file, { ...f.descriptor, status: 'failed' });
  assert.throws(() => C.selectBackend({ root: f.root, project: f.root, env: { SLURM_JOB_ID: '42' } }), /found 0/);
  assert.equal(C.selectBackend({ root: f.root, project: f.root, env: { SLURM_JOB_ID: 'tunnel-job' } }).descriptor.jobId, '43');
  C.writeJson(file, f.descriptor);
  for (const change of [{ startTicks: 'invalid' }, { version: '0.0.0' }, { hostname: 'other' }, { status: 'failed' }]) {
    assert.throws(() => C.validateDescriptor({ ...f.descriptor, ...change }, f.root), /descriptor/);
  }
  fs.chmodSync(file, 0o644); assert.throws(() => C.readJson(file), /private file/);
});

test('default source filters include appServer; explicit filters and unrelated paths remain intact', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-path-')); t.after(() => fs.rmSync(root, { recursive: true }));
  fs.symlinkSync(root, path.join(root, 'alias'));
  const implicit = normalizeRequest({ method: 'thread/list', id: 1, params: { cwd: path.join(root, 'alias'), sourceKinds: [] } }, root);
  assert.deepEqual(implicit.params.sourceKinds, ['cli', 'vscode', 'appServer']); assert.equal(implicit.params.cwd, root);
  const explicit = { method: 'thread/list', id: 2, params: { cwd: '/unrelated', sourceKinds: ['exec'], cursor: 'next' } };
  assert.deepEqual(normalizeRequest(explicit, root), explicit);
  assert.deepEqual(normalizeRequest({ id: 9, result: { answers: {} } }, root), { id: 9, result: { answers: {} } });
  const expanded = normalizeRequest({ method: 'thread/list', params: { cwd: root } }, root, [root, path.join(root, 'alias')]);
  assert.deepEqual(expanded.params.cwd, [root, path.join(root, 'alias')]);
  for (const method of ['thread/start', 'thread/resume', 'turn/start', 'command/exec']) {
    const command = normalizeRequest({ method, params: { cwd: path.join(root, 'alias') } }, root, [root, path.join(root, 'alias')]);
    assert.equal(command.params.cwd, root); // These schemas require a single directory.
  }
});

test('probe follows pagination and reports live backend states instead of stale list status', async t => {
  const f = await fixture(t, message => {
    if (message.method === 'thread/list') return message.params.cursor ?
      { data: [{ id: 'headless', status: { type: 'idle' } }], nextCursor: null } :
      { data: [{ id: 'cli', status: { type: 'idle' } }], nextCursor: 'page2' };
    if (message.method === 'thread/loaded/list') return { data: ['headless'] };
    if (message.method === 'thread/read') return { thread: { id: 'headless', status: { type: 'active', activeFlags: ['waitingOnUserInput'] } } };
  });
  const result = await C.inspectBackend(f.descriptor);
  assert.deepEqual(result.activeIds, ['headless']); assert.equal(result.threads.length, 2);
  assert.equal(f.seen.filter(m => m.method === 'thread/list').length, 2);
});

test('relay handles split UTF-8, fragmented big frames and bidirectional server requests without stdout diagnostics', async t => {
  const f = await fixture(t, (message, ws) => {
    if (message.method === 'thread/list') {
      ws.send(JSON.stringify({ id: 900, method: 'item/commandExecution/requestApproval', params: { text: '审批' } }));
      const response = Buffer.from(JSON.stringify({ id: message.id,
        result: { data: [{ id: 'running', preview: '中文😀' + 'x'.repeat(256 * 1024) }], nextCursor: null } }));
      const cut = response.indexOf(Buffer.from('😀')) + 2;
      ws.send(response.subarray(0, cut), { binary: false, fin: false });
      ws.send(response.subarray(cut), { binary: false, fin: true });
    }
  });
  const input = new PassThrough(), output = new PassThrough();
  const lines = []; let buffer = '';
  output.on('data', chunk => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) { const pos = buffer.indexOf('\n'); lines.push(JSON.parse(buffer.slice(0, pos))); buffer = buffer.slice(pos + 1); }
  });
  const run = relay({ descriptor: f.descriptor, root: f.root, input, output, hook: 'window' });
  input.write(JSON.stringify({ id: 'init', method: 'initialize', params: { clientInfo: { name: 'codex_vscode' } } }) + '\n');
  const receipt = C.receiptPath(f.root, f.socket, 'window');
  await C.waitForFile(receipt, value => value.initialized, 3000);
  const request = Buffer.from(JSON.stringify({ id: 2, method: 'thread/list', params: { sourceKinds: [], searchTerm: '中文😀' } }) + '\n');
  for (const byte of request) input.write(Buffer.from([byte]));
  await C.waitForFile(receipt, value => value.listCompleted, 3000);
  input.write(JSON.stringify({ id: 900, result: { decision: 'accept' } }) + '\n');
  input.write(JSON.stringify({ id: 3, method: 'turn/interrupt', params: { threadId: 'running', turnId: 'original-turn' } }) + '\n');
  input.end(); await run;
  assert.ok(lines.find(m => m.id === 2).result.data[0].preview.startsWith('中文😀'));
  assert.ok(lines.find(m => m.method === 'item/commandExecution/requestApproval'));
  assert.equal(f.seen.find(m => m.id === 2).params.searchTerm, '中文😀');
  assert.deepEqual(f.seen.find(m => m.id === 900), { id: 900, result: { decision: 'accept' } });
  assert.deepEqual(f.seen.filter(m => /interrupt|stop|start$/.test(m.method || '')),
    [{ id: 3, method: 'turn/interrupt', params: { threadId: 'running', turnId: 'original-turn' } }]);
});

test('backend loss terminates relay promptly without replay or fallback process', async t => {
  const f = await fixture(t); const input = new PassThrough(), output = new PassThrough(); output.resume();
  const run = relay({ descriptor: f.descriptor, root: f.root, input, output, hook: '' });
  run.catch(() => {});
  input.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex_vscode' } } }) + '\n');
  await C.waitForFile(C.receiptPath(f.root, f.socket, ''), value => value.initialized, 3000);
  for (const ws of f.wss.clients) ws.terminate();
  await assert.rejects(run, /disconnect|closed/i);
  assert.equal(f.seen.filter(m => m.method === 'initialize').length, 1);
  assert.equal(f.seen.filter(m => /interrupt|stop/.test(m.method || '')).length, 0);
});

test('relay preserves event order while slow stdout applies backpressure', async t => {
  const count = 40;
  const f = await fixture(t, (message, ws) => {
    if (message.method === 'thread/list') {
      for (let i = 0; i < count; i++) ws.send(JSON.stringify({ method: 'progress', params: { i, data: 'x'.repeat(128 * 1024) } }));
      return { data: [], nextCursor: null };
    }
  });
  const input = new PassThrough(); const events = [];
  const output = new Writable({ highWaterMark: 1, write(chunk, encoding, callback) {
    const message = JSON.parse(chunk.toString());
    if (message.method === 'progress') events.push(message.params.i);
    setTimeout(callback, 2);
  } });
  const run = relay({ descriptor: f.descriptor, root: f.root, input, output, hook: 'slow' });
  input.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex_vscode' } } }) + '\n');
  await C.waitForFile(C.receiptPath(f.root, f.socket, 'slow'), value => value.initialized, 3000);
  input.write(JSON.stringify({ id: 2, method: 'thread/list', params: {} }) + '\n');
  await C.waitForFile(C.receiptPath(f.root, f.socket, 'slow'), value => value.listCompleted, 5000);
  input.end(); await run;
  assert.deepEqual(events, Array.from({ length: count }, (_, i) => i));
});

test('partial JSONL input fails clearly', async t => {
  const f = await fixture(t); const input = new PassThrough(), output = new PassThrough(); output.resume();
  const run = relay({ descriptor: f.descriptor, root: f.root, input, output });
  input.end('{"id":'); await assert.rejects(run, /Incomplete/);
});

test('helper discovery isolates windows and ignores dead extension hosts', async t => {
  const f = await fixture(t); const item = { hostname: os.hostname(), projects: [f.root], hook: 'a', socket: f.socket,
    pid: process.pid, startTicks: C.processIdentity(process.pid) };
  C.writeJson(path.join(f.root, 'helpers', 'a.json'), item);
  C.writeJson(path.join(f.root, 'helpers', 'dead.json'), { ...item, startTicks: 'stale' });
  assert.equal(findHelper(f.root, 'a', f.root).hook, 'a'); assert.equal(findHelper(f.root, 'b', f.root), undefined);
  C.writeJson(path.join(f.root, 'helpers', 'duplicate.json'), item);
  assert.throws(() => findHelper(f.root, 'a', f.root), /Multiple/);
  const claim = path.join(f.root, 'helpers', C.hash('terminal:a') + '.json');
  C.writeJson(claim, { ...item, sessionId: 'reloaded-window' });
  assert.equal(findHelper(f.root, 'a', f.root).sessionId, 'reloaded-window');
  C.writeJson(claim, { ...item, startTicks: 'stale' });
  assert.equal(findHelper(f.root, 'a', f.root), undefined);
  C.writeJson(claim, { ...item, sessionId: 'old-helper-with-initial-hook' });
  const childCode = `console.log(require(${JSON.stringify(require.resolve('../connect.cjs'))}).findHelper(${JSON.stringify(f.root)}, 'replaced-hook', ${JSON.stringify(f.root)}).sessionId)`;
  const parentCode = `process.stdout.write(require('node:child_process').execFileSync(process.execPath, ['-e', ${JSON.stringify(childCode)}], {encoding:'utf8'}))`;
  assert.equal(require('node:child_process').execFileSync(process.execPath, ['-e', parentCode], {
    encoding: 'utf8', env: { ...process.env, VSCODE_IPC_HOOK_CLI: 'a' },
  }).trim(), 'old-helper-with-initial-hook');
  C.writeJson(claim, { ...item, startTicks: 'stale' });
  const terminalClaim = path.join(f.root, 'helpers', C.hash(`terminal-process:${process.ppid}:${C.processIdentity(process.ppid)}`) + '.json');
  C.writeJson(terminalClaim, { ...item, sessionId: 'actual-terminal-owner', hooks: ['initial-hook'] });
  assert.equal(findHelper(f.root, 'hook-replaced-by-shell-integration', f.root).sessionId, 'actual-terminal-owner');
  C.writeJson(terminalClaim, { ...item, startTicks: 'stale' });
  assert.equal(findHelper(f.root, 'a', f.root), undefined);
});
