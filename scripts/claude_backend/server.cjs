'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const C = require('./common.cjs');
const { createExecutableStore } = require('./executable.cjs');
function launchSpec(request, fallback, snapshot = cli => ({ cli, sourceCli: cli })) {
  if (!Array.isArray(request.args) || request.args.some(x => typeof x !== 'string' || x.includes('\0'))) throw new Error('Invalid Claude arguments');
  const args = [...request.args];
  // Official claudeProcessWrapper passes the extension's bundled executable first.
  const bundled = args[0] && path.isAbsolute(args[0]) ? args.shift() : null;
  const executable = snapshot(C.canonical(process.env.CLAUDE_BACKEND_CLI || bundled || fallback));
  const version = C.cliVersion(executable.cli);
  if (process.env.CLAUDE_BACKEND_VERSION && version !== process.env.CLAUDE_BACKEND_VERSION) throw new Error('Explicit Claude version pin mismatch');
  if (bundled && process.env.CLAUDE_BACKEND_CLI && C.cliVersion(snapshot(C.canonical(bundled)).cli) !== version) throw new Error('Configured Claude CLI differs from extension bundled version; update the CLI or remove CLAUDE_BACKEND_CLI');
  return { ...executable, version, args, project: C.canonical(request.project) };
}
function streamingInput(args) {
  return args.some((arg, i) => arg === '--input-format=stream-json' || (arg === '--input-format' && args[i + 1] === 'stream-json'));
}
function nativeSessionId(args) {
  for (let i = 0; i < args.length; i++) {
    if (['--resume', '-r', '--session-id'].includes(args[i])) return args[i + 1];
    const match = args[i].match(/^(?:--resume|--session-id|-r)=(.+)$/);
    if (match) return match[1];
  }
}
function launchEnvironment(client = {}, sameNode = true) {
  const env = { ...process.env };
  // Keep allocation resources, HOME, PATH and runtime ownership on the worker.
  // Forward provider/Claude settings and explicit extension environment values.
  for (const [key, value] of Object.entries(client)) {
    if (/^(CLAUDE|ANTHROPIC|AWS_|GOOGLE_|AZURE_|VERTEX_|BEDROCK_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$|SSL_CERT_FILE$|SSL_CERT_DIR$|NODE_EXTRA_CA_CERTS$)/i.test(key) && typeof value === 'string') env[key] = value;
  }
  delete env.CLAUDECODE; delete env.CLAUDE_CODE_CHILD_SESSION;
  if (!sameNode) { delete env.CLAUDE_CODE_SSE_PORT; delete env.CLAUDE_CODE_IDE_PORT; }
  return env;
}
async function serve(project, socket, file) {
  if (!process.env.SLURM_JOB_ID) throw new Error('Run inside a Slurm allocation');
  project = C.canonical(project);
  const snapshot = createExecutableStore(path.dirname(socket));
  const sourceCli = C.cliPath(), executable = snapshot(sourceCli), version = C.cliVersion(executable.cli);
  if (process.env.CLAUDE_BACKEND_VERSION && version !== process.env.CLAUDE_BACKEND_VERSION) throw new Error('Explicit Claude version pin mismatch at startup');
  const sessions = new Map(), connections = new Set();
  const descriptor = { schema: 'claude_backend_v1', project, socket, component: __dirname, node: process.execPath,
    ...executable, version, hostname: os.hostname(), jobId: process.env.SLURM_JOB_ID,
    pid: process.pid, startTicks: C.processIdentity(process.pid), status: 'starting' };
  C.writeJson(file, descriptor);
  // Detached sessions live until the allocation ends unless an idle grace is configured.
  const graceSetting = process.env.CLAUDE_BACKEND_DETACH_GRACE_SECONDS;
  const idleGrace = graceSetting ? Number(graceSetting) * 1000 : null;
  const record = session => C.writeJson(path.join(session.receipt.journalDir, 'session.json'), session.receipt);
  // A detached native process keeps stdin open so a later window can reattach.
  // With an idle grace configured, an idle detached process (no submitted
  // turn, no background task) is closed after it; native stdin EOF ends it.
  const reviewIdle = session => {
    clearTimeout(session.idleTimer); session.idleTimer = null;
    if (idleGrace === null || session.attached || session.stdinEnded || session.pending || session.tasks.size) return;
    session.idleTimer = setTimeout(() => {
      if (!session.attached && !session.pending && !session.tasks.size) { session.stdinEnded = true; session.child.stdin.end(); }
    }, idleGrace);
    session.idleTimer.unref();
  };
  const detach = (session, connection) => {
    if (!session || session.attached !== connection || session.receipt.status === 'exited') return;
    session.attached = null; session.send = null; session.receipt.status = 'detached'; session.receipt.detachedAt = new Date().toISOString();
    session.child.stdout.resume(); session.child.stderr.resume();
    record(session); reviewIdle(session);
  };
  const attach = (session, connection, send) => {
    clearTimeout(session.idleTimer); session.idleTimer = null;
    session.attached = connection; session.send = send;
    session.receipt.status = 'running'; session.receipt.reattachedAt = new Date().toISOString(); session.receipt.attachCount = (session.receipt.attachCount || 0) + 1;
    record(session);
  };
  const launch = (spec, request, connection, send) => {
    const id = crypto.randomUUID();
    const journalDir = C.privateDirectory(path.join(C.root(), 'sessions', `${descriptor.hostname}-${descriptor.jobId}`, id));
    const journals = Object.fromEntries(['stdout', 'stderr'].map(name => [name, fs.createWriteStream(path.join(journalDir, name + '.log'), { flags: 'ax', mode: 0o600 })]));
    const child = spawn(spec.cli, spec.args, { cwd: spec.project, env: launchEnvironment(request.env, request.hostname === os.hostname()), stdio: ['pipe', 'pipe', 'pipe'] });
    const receipt = { id, pid: child.pid, project: spec.project, cli: spec.cli, sourceCli: spec.sourceCli, cliSha256: spec.cliSha256, version: spec.version, nativeId: spec.nativeId, status: 'starting', journalDir };
    const session = { child, receipt, nativeId: spec.nativeId, streaming: streamingInput(spec.args), pending: 0, tasks: new Set(), inputBuffer: '', outputBuffer: '', attached: connection, send, stdinEnded: false, idleTimer: null };
    session.closed = new Promise(resolve => child.once('close', resolve));
    sessions.set(id, session);
    const inspectLines = (kind, chunk) => {
      const prop = kind === 'input' ? 'inputBuffer' : 'outputBuffer';
      session[prop] += chunk.toString('utf8');
      let i;
      while ((i = session[prop].indexOf('\n')) >= 0) {
        const line = session[prop].slice(0, i); session[prop] = session[prop].slice(i + 1);
        try {
          const value = JSON.parse(line);
          if (kind === 'input' && value.type === 'user') session.pending++;
          if (kind === 'output') {
            if (value.session_id) { session.nativeId = value.session_id; receipt.nativeId = value.session_id; }
            if (value.type === 'result') session.pending = Math.max(0, session.pending - 1);
            if (value.type === 'system' && value.subtype === 'task_started' && value.is_backgrounded !== false) session.tasks.add(value.task_id);
            if (value.type === 'system' && value.subtype === 'task_notification') session.tasks.delete(value.task_id);
            if (value.type === 'result' || (value.type === 'system' && /^task_/.test(value.subtype || ''))) { if (!session.attached) reviewIdle(session); }
          }
        } catch { /* Native bytes still pass through unchanged. */ }
      }
      if (session[prop].length > 2 * 1024 * 1024) session[prop] = ''; // Inspection is bounded; transport is unchanged.
    };
    session.inspectInput = chunk => inspectLines('input', chunk);
    child.once('spawn', () => { receipt.status = 'running'; receipt.startTicks = C.processIdentity(child.pid); record(session); session.send?.({ op: 'started', ...receipt }); });
    child.once('error', error => { session.send?.({ op: 'error', error: error.message }); });
    child.stdin.on('error', () => {});
    for (const name of ['stdout', 'stderr']) {
      journals[name].on('error', error => { console.error(`Claude journal: ${error.message}`); child.kill('SIGTERM'); });
      child[name].on('data', chunk => {
        if (!journals[name].write(chunk)) { child[name].pause(); journals[name].once('drain', () => child[name].resume()); }
        if (name === 'stdout') inspectLines('output', chunk);
        const target = session.attached;
        if (target && !session.send({ op: name, data: chunk.toString('base64') })) {
          child[name].pause(); target.once('drain', () => { if (session.attached === target) child[name].resume(); });
        }
      });
    }
    child.once('close', (code, signal) => {
      clearTimeout(session.idleTimer);
      receipt.status = 'exited'; receipt.code = code; receipt.signal = signal; record(session);
      for (const journal of Object.values(journals)) journal.end();
      session.send?.({ op: 'exit', code, signal }); session.attached?.end(); sessions.delete(id);
    });
    return session;
  };
  const server = net.createServer(connection => {
    connections.add(connection);
    let session, launched = false;
    const send = C.channel(connection, request => {
      try {
        if (request.op === 'probe') { send({ op: 'ready', ...descriptor, sessions: [...sessions.values()].map(s => s.receipt) }); return; }
        if (!launched && request.op === 'spawn') {
          launched = true;
          const spec = launchSpec(request, sourceCli, snapshot);
          spec.nativeId = nativeSessionId(spec.args);
          const existing = spec.nativeId && [...sessions.values()].find(s => s.nativeId === spec.nativeId && s.receipt.status !== 'exited');
          if (existing?.attached) throw new Error('This Claude session is attached to another window; close it there before resuming here');
          if (existing && !existing.stdinEnded) {
            // Reattach the reloaded window to the still-running native process.
            // A repeated SDK initialize is answered natively by the same process.
            session = existing; attach(existing, connection, send);
            send({ op: 'started', ...existing.receipt, reattached: true });
            return;
          }
          if (existing) {
            // The old process is finishing after stdin EOF; resume once it exits.
            existing.closed.then(() => { if (!connection.destroyed) session = launch(spec, request, connection, send); });
            return;
          }
          session = launch(spec, request, connection, send);
          return;
        }
        if (!session) throw new Error('Expected spawn');
        if (request.op === 'input') {
          const chunk = Buffer.from(request.data, 'base64'); session.inspectInput(chunk);
          if (!session.child.stdin.write(chunk)) { connection.pause(); session.child.stdin.once('drain', () => connection.resume()); }
        } else if (request.op === 'eof') {
          // A vanished client (Tunnel/extension host gone, computer off) closes
          // its stdin before the connection drops. Native stdin EOF would make
          // the CLI wind down and kill background work after its print-mode
          // cap, so interactive sessions detach instead and live until the
          // allocation ends (or an explicitly configured idle grace).
          if (session.streaming) detach(session, connection);
          else { session.stdinEnded = true; session.child.stdin.end(); }
        }
        else if (request.op === 'detach') detach(session, connection);
        // Client signals (reload/close/terminal) only detach: native work runs
        // until the allocation ends. Turn interruption is a native control request.
        else if (request.op === 'signal' && ['SIGINT', 'SIGTERM', 'SIGHUP'].includes(request.signal)) detach(session, connection);
        else throw new Error('Unsupported backend operation');
      } catch (error) { send({ op: 'error', error: error.message }); connection.end(); }
    });
    connection.on('error', () => {});
    connection.on('close', () => { connections.delete(connection); detach(session, connection); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  fs.chmodSync(socket, 0o600); descriptor.status = 'ready'; C.writeJson(file, descriptor);
  console.log(`CLAUDE_BACKEND_READY job=${descriptor.jobId} node=${descriptor.hostname} pid=${descriptor.pid} version=${version}`);
  const stop = () => {
    descriptor.status = 'stopped'; C.writeJson(file, descriptor);
    for (const session of sessions.values()) { clearTimeout(session.idleTimer); session.child.kill('SIGTERM'); }
    for (const connection of connections) connection.destroy();
    server.close();
    const deadline = setTimeout(() => { for (const session of sessions.values()) session.child.kill('SIGKILL'); }, 5000); deadline.unref();
  };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, stop);
  return { server, stop, descriptor };
}
module.exports = { serve, launchSpec, launchEnvironment, nativeSessionId, streamingInput };
if (require.main === module) serve(...process.argv.slice(2)).catch(error => { console.error(`claude-backend: ${error.message}`); process.exitCode = 1; });
