'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { once } = require('node:events');
const C = require('../common.cjs');
const { createExecutableStore } = require('../executable.cjs');

// A real ELF fixture exercises executable identity and deletion, not a script
// that happens to print a Claude version. No real provider or user service runs.
const nativeCode = `#include <stdio.h>
#include <string.h>
#include <unistd.h>
#ifndef VERSION
#define VERSION "2.9.321"
#endif
int main(int argc, char **argv) {
  for (int i = 1; i < argc; ++i)
    if (!strcmp(argv[i], "--version")) { puts(VERSION " (Claude Code)"); return 0; }
  char line[8192];
  while (fgets(line, sizeof(line), stdin)) { fputs(line, stdout); fflush(stdout); }
  return 0;
}
`;
function compile(dir, version = '2.9.321') {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const source = path.join(dir, 'fixture.c'), cli = path.join(dir, 'claude');
  fs.writeFileSync(source, nativeCode);
  cp.execFileSync('cc', [source, '-o', cli, `-DVERSION="${version}"`]);
  return cli;
}
function connect(socket) {
  const conn = net.createConnection(socket), frames = [];
  conn.on('error', () => {});
  const send = C.channel(conn, frame => frames.push(frame));
  const wait = async predicate => {
    const deadline = Date.now() + 5000;
    while (!frames.some(predicate)) {
      if (Date.now() > deadline) throw new Error('Missing backend frame: ' + JSON.stringify(frames));
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return frames.find(predicate);
  };
  return { conn, send, wait };
}
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('script/npm launchers retain their path and native stores reject unsafe runtimes', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-copy-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cli = path.join(dir, 'cli.js');
  fs.writeFileSync(cli, '#!/usr/bin/env node\nrequire("./adjacent-package");\n', { mode: 0o700 });
  const snapshot = createExecutableStore(dir);
  assert.deepEqual(snapshot(cli), { cli, sourceCli: cli });
  const link = path.join(dir, 'alias'); fs.symlinkSync(dir, link);
  assert.throws(() => createExecutableStore(link), /Not a private directory/);
  const publicDir = path.join(dir, 'public'); fs.mkdirSync(publicDir, { mode: 0o755 });
  assert.throws(() => createExecutableStore(publicDir), /Not a private directory/);
  fs.chmodSync(cli, 0o600);
  assert.throws(() => snapshot(cli), /regular executable/);
});

test('copy errors and concurrent source changes fail closed and discard partial snapshots', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-copy-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'native');
  fs.writeFileSync(source, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4]), { mode: 0o700 });
  const snapshot = createExecutableStore(dir), originalRead = fs.readSync;
  t.after(() => { fs.readSync = originalRead; });
  fs.readSync = function (...args) {
    const count = originalRead.apply(this, args);
    if (args[1].length === 1024 * 1024) fs.appendFileSync(source, 'changed');
    return count;
  };
  assert.throws(() => snapshot(source), /Source changed during snapshot/);
  fs.readSync = function (...args) {
    if (args[1].length === 1024 * 1024) throw new Error('fixture read failure');
    return originalRead.apply(this, args);
  };
  assert.throws(() => snapshot(source), /fixture read failure/);
  fs.readSync = originalRead;
  const store = path.join(dir, fs.readdirSync(dir).find(name => name.startsWith('claude-executables-')));
  assert.deepEqual(fs.readdirSync(store), [], 'neither failure publishes or retains partial executable bytes');
  const result = snapshot(source);
  assert.equal(hash(result.cli), hash(source));
  const unchanged = snapshot(source);
  assert.equal(unchanged.cli, result.cli);
  assert.equal(fs.statSync(result.cli).nlink, 1);
});

test('native launches survive extension deletion, reuse local bytes, and isolate new versions', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-elf-test-'));
  const cli = compile(path.join(dir, 'extension-old'));
  const originalHash = hash(cli), socket = path.join(dir, 'app.sock'), file = path.join(dir, 'descriptor.json');
  const child = cp.spawn(process.execPath, [path.join(__dirname, '../server.cjs'), dir, socket, file], {
    env: { ...process.env, HOME: dir, SLURM_JOB_ID: '99112', CLAUDE_BACKEND_CLI: cli }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let output = '', errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No backend ready: ' + errors)), 10000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Backend exited ${code}: ${errors}`)); });
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('CLAUDE_BACKEND_READY')) { clearTimeout(timer); resolve(); } });
  });
  const launch = async (source = cli, args = []) => {
    const client = connect(socket); t.after(() => client.conn.destroy());
    await once(client.conn, 'connect');
    client.send({ op: 'spawn', project: dir, args: [source, ...args], env: {}, hostname: os.hostname() });
    return { client, receipt: await client.wait(frame => frame.op === 'started') };
  };
  const first = await launch();
  assert.notEqual(first.receipt.cli, cli, 'must execute a private copy, not the extension binary');
  assert.equal(first.receipt.sourceCli, cli);
  assert.equal(first.receipt.cliSha256, originalHash);
  assert.equal(hash(first.receipt.cli), originalHash);
  assert.notEqual(fs.statSync(first.receipt.cli).ino, fs.statSync(cli).ino, 'a hard link is not a snapshot');
  assert.equal(fs.statSync(first.receipt.cli).mode & 0o777, 0o500);
  assert.equal(fs.statSync(path.dirname(first.receipt.cli)).mode & 0o777, 0o700);
  assert.equal(fs.readlinkSync(`/proc/${first.receipt.pid}/exe`), first.receipt.cli);
  const startup = C.readJson(file);
  assert.equal(startup.cli, first.receipt.cli, 'startup version probe also uses the local snapshot');
  assert.equal(startup.sourceCli, cli);
  const second = await launch();
  assert.equal(second.receipt.cli, first.receipt.cli, 'unchanged native bytes are copied once');

  // An in-place source modification must not alter executable pages in the copy.
  fs.truncateSync(cli, 0);
  fs.rmSync(path.dirname(cli), { recursive: true });
  assert.equal(hash(first.receipt.cli), originalHash);
  const nativeLine = JSON.stringify({ type: 'system', session_id: 'original-native', marker: 'after deletion' }) + '\n';
  first.client.send({ op: 'input', data: Buffer.from(nativeLine).toString('base64') });
  const echo = await first.client.wait(frame => frame.op === 'stdout');
  assert.equal(Buffer.from(echo.data, 'base64').toString(), nativeLine);
  first.client.send({ op: 'detach' });
  await first.client.wait(() => C.readJson(path.join(first.receipt.journalDir, 'session.json')).status === 'detached');

  // Same source pathname, different inode/version: never overwrite a live copy.
  compile(path.dirname(cli), '2.9.322');
  const next = await launch();
  assert.equal(next.receipt.version, '2.9.322');
  assert.notEqual(next.receipt.cli, first.receipt.cli);
  assert.notEqual(next.receipt.cliSha256, originalHash);
  assert.equal(hash(first.receipt.cli), originalHash);
  const resumed = await launch(cli, ['--resume=original-native']);
  assert.equal(resumed.receipt.reattached, true);
  assert.equal(resumed.receipt.pid, first.receipt.pid);
  assert.equal(resumed.receipt.cli, first.receipt.cli);
  assert.equal(resumed.receipt.version, '2.9.321', 'reattach retains the original executable');

  // Missing sources fail closed; do not silently spawn a fallback/native update.
  const broken = connect(socket); t.after(() => broken.conn.destroy()); await once(broken.conn, 'connect');
  broken.send({ op: 'spawn', project: dir, args: [path.join(dir, 'missing')], env: {}, hostname: os.hostname() });
  assert.match((await broken.wait(frame => frame.op === 'error')).error, /ENOENT/);
});
