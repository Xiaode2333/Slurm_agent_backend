'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const C = require('./common.cjs');
const SSH = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2'];
const fingerprint = d => C.hash(JSON.stringify([d.hostname, d.jobId, d.pid, d.startTicks, d.socket, d.component, d.project]));
function remoteCommand(d, file, action) {
  C.validate(d, false);
  return [d.node, path.join(d.component, 'transport.cjs'), action, file, fingerprint(d)].map(C.quote).join(' ');
}
function stream(file, { stderr = 'inherit' } = {}) {
  const d = C.readJson(file); C.validate(d, false);
  if (d.hostname === os.hostname()) {
    C.validate(d); const socket = net.createConnection(d.socket);
    return { input: socket, output: socket, close: () => socket.destroy(), opened: new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); }) };
  }
  const child = spawn('ssh', [...SSH, d.hostname, remoteCommand(d, file, 'bridge')], { stdio: ['pipe', 'pipe', stderr] });
  child.stdin.on('error', () => {});
  return { input: child.stdin, output: child.stdout, close: () => child.kill(), opened: new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }), child };
}
async function probe(file) {
  // Discovery is speculative: keep failed SSH probes quiet, but retain their
  // diagnostics for callers that explicitly probe a selected backend.
  const connection = stream(file, { stderr: 'pipe' });
  let diagnostic = '';
  connection.child?.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-16384); });
  await connection.opened;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => done(new Error('Claude backend probe timed out')), 15000);
    const done = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); connection.close();
      if (error) reject(diagnostic.trim() ? new Error(`${error.message}: ${diagnostic.trim()}`, { cause: error }) : error);
      else resolve(value);
    };
    const send = C.channel(connection.output, value => value.op === 'ready' ? done(null, value) : done(new Error(value.error || 'Unexpected probe response')));
    connection.output.once('error', error => done(error));
    // SSH close follows drainage of both stdout and stderr, so failed bridges
    // from older immutable components retain their complete error message.
    (connection.child || connection.output).once(connection.child ? 'close' : 'end', () => done(new Error('Claude backend closed without probe response')));
    // Separate SSH stdin/stdout, versus one duplex Unix socket.
    if (connection.input === connection.output) send({ op: 'probe' });
    else connection.input.write(JSON.stringify({ op: 'probe' }) + '\n');
  });
}
async function select(project, env = process.env) {
  project = C.canonical(project);
  const dir = path.join(C.root(), 'backends'); const candidates = [];
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!name.endsWith('.json')) continue;
    try {
      const file = path.join(dir, name), d = C.readJson(file); C.validate(d, false);
      if (env.CLAUDE_BACKEND_JOB && d.jobId !== env.CLAUDE_BACKEND_JOB) continue;
      if (env.CLAUDE_BACKEND_HOST && d.hostname !== env.CLAUDE_BACKEND_HOST) continue;
      // Resolve under this registry's guard: a retired mount must not abort
      // discovery of a healthy backend registered on the current filesystem.
      C.canonical(d.project);
      candidates.push({ file, descriptor: d });
    } catch { /* Ignore expired/invalid registries. */ }
  }
  const matching = candidates.filter(c => C.canonical(c.descriptor.project) === project);
  const preferred = matching.length ? matching : candidates;
  const local = preferred.filter(c => c.descriptor.hostname === os.hostname());
  async function live(items) {
    const result = [];
    for (let i = 0; i < items.length; i += 4) await Promise.all(items.slice(i, i + 4).map(async c => {
      try { await probe(c.file); result.push(c); } catch { /* A descriptor alone is not liveness. */ }
    }));
    return result;
  }
  let found = await live(local);
  if (!found.length) found = await live(preferred.filter(c => c.descriptor.hostname !== os.hostname()));
  if (found.length !== 1) throw new Error(`Expected one reachable Claude backend; found ${found.length}. Set CLAUDE_BACKEND_JOB or CLAUDE_BACKEND_HOST`);
  return found[0];
}
function bridge(file, expected) {
  const d = C.readJson(file); C.validate(d);
  if (fingerprint(d) !== expected) throw new Error('Claude backend identity changed');
  const socket = net.createConnection(d.socket);
  process.stdin.pipe(socket); socket.pipe(process.stdout);
  socket.on('error', error => { console.error(error.message); process.exitCode = 1; });
  socket.on('close', () => { process.stdin.unpipe(socket); process.stdin.pause(); });
}
module.exports = { SSH, fingerprint, remoteCommand, stream, probe, select, bridge };
if (require.main === module) {
  try {
    const [action, file, expected] = process.argv.slice(2);
    if (action !== 'bridge') throw new Error('Expected bridge');
    bridge(file, expected);
  } catch (error) { console.error(`Claude SSH: ${error.message}`); process.exitCode = 1; }
}
