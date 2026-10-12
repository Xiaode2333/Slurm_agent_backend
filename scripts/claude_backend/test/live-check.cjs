'use strict';
// Read-only native CLI/SDK validation; no user prompt or model request is sent.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const C = require('../common.cjs');
const T = require('../transport.cjs');
async function waitDescriptor(file, timeout = 120000) {
  C.privateDirectory(path.dirname(file));
  return new Promise((resolve, reject) => {
    const inspect = () => { try { if (C.readJson(file).status === 'ready') { clearTimeout(timer); watcher.close(); fs.unwatchFile(file, inspect); resolve(); } } catch { /* Wait for atomic publication. */ } };
    const watcher = fs.watch(path.dirname(file), inspect);
    // NFS changes made on another node may not trigger the local inotify watcher.
    fs.watchFile(file, { interval: 1000 }, inspect);
    const timer = setTimeout(() => { watcher.close(); fs.unwatchFile(file, inspect); reject(new Error('Backend readiness timed out')); }, timeout);
    inspect();
  });
}
async function native(file, args, input, env = {}) {
  const connection = T.stream(file); await connection.opened;
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', version;
    const timer = setTimeout(() => { connection.close(); reject(new Error(`Native check timeout: ${stderr}`)); }, 120000);
    const send = value => connection.input.write(JSON.stringify(value) + '\n');
    C.channel(connection.output, value => {
      if (value.op === 'started') { version = value.version; if (input) send({ op: 'input', data: Buffer.from(input).toString('base64') }); send({ op: 'eof' }); }
      else if (value.op === 'stdout') stdout += Buffer.from(value.data, 'base64').toString('utf8');
      else if (value.op === 'stderr') stderr += Buffer.from(value.data, 'base64').toString('utf8');
      else if (value.op === 'exit') { clearTimeout(timer); connection.close(); if (value.code !== 0) reject(new Error(`Native Claude exited ${value.code}: ${stderr}`)); else resolve({ stdout, stderr, version }); }
      else if (value.op === 'error') { clearTimeout(timer); connection.close(); reject(new Error(value.error)); }
    });
    connection.output.once('error', reject);
    send({ op: 'spawn', args, project: C.readJson(file).project, hostname: require('node:os').hostname(), env: { ...process.env, ...env } });
  });
}
async function check(file, bundled) {
  await waitDescriptor(file);
  const health = await T.probe(file); console.log(`LIVE_SUPERVISOR job=${health.jobId} node=${health.hostname} version=${health.version}`);
  const executable = bundled || health.cli;
  const status = await native(file, [executable, 'auth', 'status', '--json']);
  const auth = JSON.parse(status.stdout);
  console.log(`LIVE_AUTH version=${status.version} loggedIn=${auth.loggedIn}`);
  if (!auth.loggedIn) throw new Error('Claude Code is not authenticated');
  const requestId = crypto.randomUUID();
  const input = JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize' } }) + '\n';
  const result = await native(file, [executable, '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json'], input, { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' });
  const response = result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(r => r.type === 'control_response' && r.response?.request_id === requestId);
  if (response?.response?.subtype !== 'success') throw new Error('Native initialize did not succeed');
  console.log(`LIVE_NATIVE_INITIALIZE version=${result.version} requestMatched=true exit=0`);
}
module.exports = { check, native, waitDescriptor };
if (require.main === module) check(...process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
