'use strict';
// Run inside a separate CPU allocation. Only synthetic workspace/state and
// read-only probes are used; existing backends and user turns are preserved.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const C = require('./common.cjs');
const { consumeJsonl } = require('./jsonl.cjs');
const { measure } = require('./benchmark.cjs');
const { relay } = require('./relay.cjs');
const { PassThrough } = require('node:stream');

async function check(output) {
  if (!process.env.SLURM_JOB_ID) throw new Error('Run in a CPU Slurm allocation');
  output = path.resolve(output); fs.mkdirSync(output, { recursive: true, mode: 0o700 }); fs.chmodSync(output, 0o700);
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-live-')); fs.chmodSync(runtime, 0o700);
  const projects = ['first', 'second'].map(name => { const p = path.join(runtime, name); fs.mkdirSync(p); return p; });
  const children = [];
  const start = (file, args) => {
    const fd = fs.openSync(path.join(output, path.basename(file) + '-' + children.length + '.log'), 'a', 0o600);
    const child = spawn(process.execPath, [path.join(__dirname, file), ...args], { stdio: ['ignore', fd, fd] });
    fs.closeSync(fd); child.on('error', error => console.error(error.message)); children.push(child); return child;
  };
  const wait = async predicate => {
    const deadline = Date.now() + 180000;
    while (true) {
      try { const value = await predicate(); if (value) return value; } catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
      if (Date.now() > deadline) throw new Error('Live readiness timeout');
      if (children.some(child => child.exitCode !== null && child.exitCode !== 0)) throw new Error('Live service failed; inspect the retained private service log');
      await delay(250);
    }
  };
  const result = { versions: {}, checks: {} };
  try {
    const descriptorFile = path.join(output, 'private-backend.json'), durable = C.privateDirectory(path.join(output, 'durable'));
    start('sqlite-store.cjs', [projects[0], path.join(runtime, 'codex.sock'), descriptorFile, durable]);
    const descriptor = await wait(() => { const d = C.readJson(descriptorFile); return d.status === 'ready' && d; });
    const rpc = await C.rpcClient(descriptor.socket);
    try {
      for (const project of projects) {
        const thread = await rpc.request('thread/start', { cwd: project, ephemeral: true });
        if (C.canonical(thread.thread.cwd) !== project) throw new Error('Live thread started in the wrong project');
      }
      result.checks.twoProjects = true;
    } finally { rpc.close(); }
    const input = new PassThrough(), outputStream = new PassThrough();
    const relaying = relay({ descriptor, project: projects[1], input, output: outputStream, root: path.join(runtime, 'proof'), hook: 'live-default-cwd' });
    const thread = new Promise((resolve, reject) => consumeJsonl(outputStream, record => {
      if (record.id === 1) {
        input.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
        input.write(JSON.stringify({ id: 2, method: 'thread/start', params: { ephemeral: true } }) + '\n');
      }
      if (record.id === 2) record.error ? reject(new Error(record.error.message)) : resolve(record.result.thread);
    }, reject));
    input.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'live_project_probe', version: '1' } } }) + '\n');
    const timer = setTimeout(() => input.destroy(new Error('Default cwd probe timeout')), 30000);
    try {
      if (C.canonical((await thread).cwd) !== projects[1]) throw new Error('Relay default cwd used the backend project');
      result.checks.relayDefaultProject = true;
    } finally { clearTimeout(timer); input.end(); await relaying; }
    result.benchmark = await measure(descriptor, projects[0], path.join(output, 'benchmark'));
    result.checks.localSqlite = descriptor.sqliteHome.startsWith(runtime);
    const H = require('./harness.cjs');
    for (const harness of ['pi', 'claude-code']) {
      const native = start('harness.cjs', ['serve', harness, projects[0], 'native', '--version']);
      const deadline = setTimeout(() => native.kill('SIGTERM'), 30000);
      const [code] = await once(native, 'exit'); clearTimeout(deadline);
      if (code !== 0) throw new Error(`${harness} native tmux lifecycle failed`);
    }
    result.checks.nativeTmuxExit = true;
    for (const [harness, args] of [['opencode', ['native', '--pure']], ['pi', ['rpc', '--offline', '--no-extensions', '--no-context-files', '--no-tools']], ['claude-code', ['rpc', '--tools', '', '--strict-mcp-config', '--mcp-config', '{}']]]) {
      start('harness.cjs', ['serve', harness, projects[0], ...args]);
      const d = await wait(() => { try { return H.select(harness, projects[0], process.env.SLURM_JOB_ID); } catch { return false; } });
      if (harness === 'opencode') {
        const auth = C.readJson(d.authFile);
        const response = await fetch(`${d.url}/global/health`, { headers: { Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}` }, signal: AbortSignal.timeout(10000) });
        const health = await response.json(); if (!health.healthy) throw new Error('OpenCode health failed');
        result.versions.opencode = health.version; result.checks.opencode = true;
        if (H.select(harness, projects[1], process.env.SLURM_JOB_ID).clientProject !== projects[1]) throw new Error('OpenCode shared-project selection failed');
        result.checks.opencodeProjects = true;
      } else if (harness === 'pi') {
        const probe = () => new Promise((resolve, reject) => {
          const client = net.createConnection(d.socket); const timer = setTimeout(() => { client.destroy(); reject(new Error('Pi state timeout')); }, 30000);
          consumeJsonl(client, record => {
            if (record.attached) client.write(JSON.stringify({ id: 'state', type: 'get_state' }) + '\n');
            if (record.record?.id === 'state') { clearTimeout(timer); client.destroy(); record.record.success ? resolve() : reject(new Error(record.record.error)); }
          }, reject);
          client.once('connect', () => client.write(JSON.stringify({ action: 'attach' }) + '\n'));
        });
        await probe(); await probe(); result.checks.piReconnect = true;
      } else {
        // Keep stdin open and confirm that the native stream-json process lives
        // independently of an observer. No model request or tool approval.
        const client = net.createConnection(d.socket);
        await once(client, 'connect'); client.write(JSON.stringify({ action: 'attach', readOnly: true }) + '\n');
        await once(client, 'data'); client.destroy();
        C.processIdentity(d.childPid); result.checks.claudeStreamProcess = true;
      }
    }
  } finally {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null) return;
      const done = once(child, 'exit'); child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
      await done; clearTimeout(timer);
    }));
    fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
  }
  if (!result.checks.twoProjects || !result.checks.localSqlite || !result.checks.piReconnect || !result.checks.opencode || !result.checks.claudeStreamProcess) throw new Error('Live checks incomplete');
  console.log('LIVE_CHECKS_PASS', JSON.stringify(result));
}
module.exports = { check };
if (require.main === module) check(process.argv[2] || 'tmp/live-checks').catch(error => { console.error(error.stack); process.exitCode = 1; });
