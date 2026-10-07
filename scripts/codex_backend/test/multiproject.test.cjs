'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const C = require('../common.cjs');
const { normalizeRequest } = require('../relay.cjs');
const { selectionFor, selectionForLaunch } = require('../dispatcher.cjs');
const store = require('../sqlite-store.cjs');

test('multiple projects select one backend without changing its descriptor', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-multi-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, 'first'), second = path.join(root, 'second');
  fs.mkdirSync(first); fs.mkdirSync(second);
  const socket = path.join(root, 'app.sock'), server = net.createServer();
  await new Promise(resolve => server.listen(socket, resolve)); fs.chmodSync(socket, 0o600);
  t.after(() => server.close());
  const descriptor = { schema: 'codex_backend_v1', status: 'ready', id: 'shared', project: first, socket,
    cli: C.CLI, version: C.CLI_VERSION, hostname: os.hostname(), jobId: '42', pid: process.pid, startTicks: C.processIdentity(process.pid) };
  const file = path.join(root, 'backends', 'one.json'); C.writeJson(file, descriptor);
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(C.selectBackend({ root, project: first, env: {} }).descriptor.id, 'shared');
  assert.equal(C.selectBackend({ root, project: second, env: {} }).descriptor.id, 'shared');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.throws(() => C.validateDescriptor(descriptor, second), /descriptor/);
  assert.equal(C.validateDescriptor(descriptor, second, os.hostname(), { allowShared: true }), descriptor);
  C.writeJson(path.join(root, 'backends', 'two.json'), { ...descriptor, jobId: '43' });
  assert.throws(() => C.selectBackend({ root, project: second, env: {} }), /found 2/);
  assert.equal(C.selectBackend({ root, project: second, env: { CODEX_BACKEND_JOB: '43' } }).descriptor.jobId, '43');
});

test('dispatcher bindings isolate extension hosts and ignore stale process identities', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dispatch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(selectionFor(process.pid, root), undefined);
  const value = { project: '/first', descriptor: '/first.json', component: '/component' };
  C.writeJson(C.windowPath(root), value);
  assert.deepEqual(selectionFor(process.pid, root), value);
  assert.equal(selectionFor(process.ppid, root), undefined);
  fs.renameSync(C.windowPath(root), path.join(root, 'windows', `${process.pid}-old.json`));
  assert.equal(selectionFor(process.pid, root), undefined);
});

test('a restored chat view waits for the helper decision before launching a CLI', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-startup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pending = selectionForLaunch(['app-server'], process.pid, root, 2000);
  const binding = { descriptor: '/selected.json', project: '/second', component: '/installed' };
  setTimeout(() => C.writeJson(C.windowPath(root), binding), 30);
  assert.deepEqual(await pending, binding);
  C.writeJson(C.windowPath(root), { local: true });
  assert.deepEqual(await selectionForLaunch(['app-server'], process.pid, root), { local: true });
});

test('history reads use the index by default and preserve explicit repair and writes', () => {
  const base = { method: 'thread/list', id: 3, params: { cwd: '/project', sourceKinds: ['cli'], cursor: 'next' } };
  assert.equal(normalizeRequest(base, '/project').params.useStateDbOnly, true);
  assert.equal(normalizeRequest({ ...base, params: { ...base.params, useStateDbOnly: false } }, '/project').params.useStateDbOnly, false);
  assert.equal(normalizeRequest({ method: 'thread/start', params: { ephemeral: true } }, '/second').params.cwd, '/second');
  assert.equal(normalizeRequest({ method: 'command/exec', params: { command: ['pwd'] } }, '/second').params.cwd, '/second');
  assert.equal(normalizeRequest({ method: 'thread/resume', params: { threadId: 'existing' } }, '/second').params.cwd, undefined);
  for (const method of ['thread/start', 'thread/resume', 'turn/start', 'command/exec']) {
    const normalized = normalizeRequest({ method, params: { cwd: '/project' } }, '/project', ['/project', '/alias']);
    assert.equal(normalized.params.cwd, '/project');
    assert.equal(normalized.params.useStateDbOnly, undefined);
  }
});

test('SQLite backups retain WAL-backed state and restore the durable namespace', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const durable = C.privateDirectory(path.join(root, 'durable')), local = C.privateDirectory(path.join(root, 'local'));
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(local, 'state_5.sqlite'));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE history(id TEXT); INSERT INTO history VALUES('retained')");
  await store.sync(local, durable);
  const copy = new DatabaseSync(path.join(durable, 'snapshots/state_5.sqlite'), { readOnly: true });
  assert.equal(copy.prepare('SELECT id FROM history').get().id, 'retained'); copy.close(); db.close();
  const restored = path.join(root, 'restored'); await store.restore(durable, restored);
  const after = new DatabaseSync(path.join(restored, 'state_5.sqlite'), { readOnly: true });
  assert.equal(after.prepare('SELECT id FROM history').get().id, 'retained'); after.close();
});
