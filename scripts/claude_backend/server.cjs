'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const C = require('./common.cjs');
function launchSpec(request, fallback) {
  if (!Array.isArray(request.args) || request.args.some(x => typeof x !== 'string' || x.includes('\0'))) throw new Error('Invalid Claude arguments');
  const args = [...request.args];
  // Official claudeProcessWrapper passes the extension's bundled executable first.
  const bundled = args[0] && path.isAbsolute(args[0]) ? args.shift() : null;
  const cli = C.canonical(process.env.CLAUDE_BACKEND_CLI || bundled || fallback);
  const version = C.cliVersion(cli);
  if (process.env.CLAUDE_BACKEND_VERSION && version !== process.env.CLAUDE_BACKEND_VERSION) throw new Error('Explicit Claude version pin mismatch');
  if (bundled && process.env.CLAUDE_BACKEND_CLI && C.cliVersion(bundled) !== version) throw new Error('Configured Claude CLI differs from extension bundled version; update the CLI or remove CLAUDE_BACKEND_CLI');
  return { cli, version, args, project: C.canonical(request.project) };
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
  const cli = C.cliPath(), version = C.cliVersion(cli);
  if (process.env.CLAUDE_BACKEND_VERSION && version !== process.env.CLAUDE_BACKEND_VERSION) throw new Error('Explicit Claude version pin mismatch at startup');
  const sessions = new Map(), connections = new Set();
  const descriptor = { schema: 'claude_backend_v1', project, socket, component: __dirname, node: process.execPath,
    cli, version, hostname: os.hostname(), jobId: process.env.SLURM_JOB_ID,
    pid: process.pid, startTicks: C.processIdentity(process.pid), status: 'starting' };
  C.writeJson(file, descriptor);
  const server = net.createServer(connection => {
    connections.add(connection);
    let session, launched = false;
    const send = C.channel(connection, request => {
      try {
        if (request.op === 'probe') { send({ op: 'ready', ...descriptor, sessions: [...sessions.values()].map(s => s.receipt) }); return; }
        if (!launched && request.op === 'spawn') {
          launched = true;
          const spec = launchSpec(request, cli);
          const nativeId = nativeSessionId(spec.args);
          if (nativeId && [...sessions.values()].some(s => s.nativeId === nativeId && s.receipt.status !== 'exited')) throw new Error('This Claude session is still active in the allocation; wait for its turn to finish before resuming');
          const id = crypto.randomUUID();
          const journalDir = C.privateDirectory(path.join(C.root(), 'sessions', `${descriptor.hostname}-${descriptor.jobId}`, id));
          const journals = Object.fromEntries(['stdout', 'stderr'].map(name => [name, fs.createWriteStream(path.join(journalDir, name + '.log'), { flags: 'ax', mode: 0o600 })]));
          const child = spawn(spec.cli, spec.args, { cwd: spec.project, env: launchEnvironment(request.env, request.hostname === os.hostname()), stdio: ['pipe', 'pipe', 'pipe'] });
          const receipt = { id, pid: child.pid, project: spec.project, cli: spec.cli, version: spec.version, nativeId, status: 'starting', journalDir };
          session = { child, receipt, nativeId, pending: 0, inputBuffer: '', outputBuffer: '', orphaned: false };
          sessions.set(id, session);
          const record = () => C.writeJson(path.join(journalDir, 'session.json'), receipt);
          const inspectLines = (kind, chunk) => {
            const prop = kind === 'input' ? 'inputBuffer' : 'outputBuffer';
            session[prop] += chunk.toString('utf8');
            let i;
            while ((i = session[prop].indexOf('\n')) >= 0) {
              const line = session[prop].slice(0, i); session[prop] = session[prop].slice(i + 1);
              try {
                const value = JSON.parse(line);
                if (kind === 'input' && value.type === 'user') session.pending++;
                if (kind === 'output' && value.session_id) { session.nativeId = value.session_id; receipt.nativeId = value.session_id; }
                if (kind === 'output' && value.type === 'result') { session.pending = Math.max(0, session.pending - 1); if (session.orphaned && !session.pending) child.stdin.end(); }
              } catch { /* Native bytes still pass through unchanged. */ }
            }
            if (session[prop].length > 2 * 1024 * 1024) session[prop] = ''; // Inspection is bounded; transport is unchanged.
          };
          session.inspectInput = chunk => inspectLines('input', chunk);
          child.once('spawn', () => { receipt.status = 'running'; receipt.startTicks = C.processIdentity(child.pid); record(); send({ op: 'started', ...receipt }); });
          child.once('error', error => { send({ op: 'error', error: error.message }); });
          child.stdin.on('error', () => {});
          for (const name of ['stdout', 'stderr']) {
            journals[name].on('error', error => { console.error(`Claude journal: ${error.message}`); child.kill('SIGTERM'); });
            child[name].on('data', chunk => {
              if (!journals[name].write(chunk)) { child[name].pause(); journals[name].once('drain', () => child[name].resume()); }
              if (name === 'stdout') inspectLines('output', chunk);
              if (!session.orphaned && !send({ op: name, data: chunk.toString('base64') })) {
                child[name].pause(); connection.once('drain', () => { if (!session.orphaned) child[name].resume(); });
              }
            });
          }
          child.once('close', (code, signal) => {
            receipt.status = 'exited'; receipt.code = code; receipt.signal = signal; record();
            for (const journal of Object.values(journals)) journal.end();
            send({ op: 'exit', code, signal }); connection.end(); sessions.delete(id);
          });
          return;
        }
        if (!session) throw new Error('Expected spawn');
        if (request.op === 'input') {
          const chunk = Buffer.from(request.data, 'base64'); session.inspectInput(chunk);
          if (!session.child.stdin.write(chunk)) { connection.pause(); session.child.stdin.once('drain', () => connection.resume()); }
        } else if (request.op === 'eof') session.child.stdin.end();
        else if (request.op === 'signal' && ['SIGINT', 'SIGTERM', 'SIGHUP'].includes(request.signal)) session.child.kill(request.signal);
        else throw new Error('Unsupported backend operation');
      } catch (error) { send({ op: 'error', error: error.message }); connection.end(); }
    });
    connection.on('error', () => {});
    connection.on('close', () => {
      connections.delete(connection);
      if (session && session.receipt.status !== 'exited') {
        session.orphaned = true; session.receipt.status = 'detached';
        // A lost UI leaves a submitted turn running. Native stdin closes after
        // its result; history can then be resumed by the extension normally.
        if (!session.pending) session.child.stdin.end();
        session.child.stdout.resume(); session.child.stderr.resume();
        C.writeJson(path.join(session.receipt.journalDir, 'session.json'), session.receipt);
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  fs.chmodSync(socket, 0o600); descriptor.status = 'ready'; C.writeJson(file, descriptor);
  console.log(`CLAUDE_BACKEND_READY job=${descriptor.jobId} node=${descriptor.hostname} pid=${descriptor.pid} version=${version}`);
  const stop = () => {
    descriptor.status = 'stopped'; C.writeJson(file, descriptor);
    for (const session of sessions.values()) session.child.kill('SIGTERM');
    for (const connection of connections) connection.destroy();
    server.close();
    const deadline = setTimeout(() => { for (const session of sessions.values()) session.child.kill('SIGKILL'); }, 5000); deadline.unref();
  };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, stop);
  return { server, stop, descriptor };
}
module.exports = { serve, launchSpec, launchEnvironment, nativeSessionId };
if (require.main === module) serve(...process.argv.slice(2)).catch(error => { console.error(`claude-backend: ${error.message}`); process.exitCode = 1; });
