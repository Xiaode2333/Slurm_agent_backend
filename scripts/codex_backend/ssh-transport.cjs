'use strict';
// SSH encrypts/authenticates the node hop; WebSocket/JSON-RPC stays unchanged.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile, execFileSync } = require('node:child_process');
const execFileAsync = require('node:util').promisify(execFile);
const { setTimeout: delay } = require('node:timers/promises');
const C = require('./common.cjs');

const SSH_OPTIONS = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
  '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2'];
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
function fingerprint(d) {
  return C.hash(JSON.stringify([d.schema, d.id, d.hostname, d.jobId, d.project,
    d.cli, d.version, d.socket, d.pid, d.startTicks, d.status]));
}
function sshHost(host) {
  if (typeof host !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host)) throw new Error('Invalid SSH backend hostname');
  return host;
}
function remoteVerify(file, descriptor) {
  const command = [process.execPath, __filename, 'verify', file, fingerprint(descriptor)].map(quote).join(' ');
  const result = execFileSync('ssh', [...SSH_OPTIONS, sshHost(descriptor.hostname), command],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
  const verified = JSON.parse(result);
  if (fingerprint(verified) !== fingerprint(descriptor)) throw new Error('Backend identity changed during SSH verification');
  return verified;
}
async function remoteVerifyAsync(file, descriptor) {
  const command = [process.execPath, __filename, 'verify', file, fingerprint(descriptor)].map(quote).join(' ');
  const { stdout } = await execFileAsync('ssh', [...SSH_OPTIONS, sshHost(descriptor.hostname), command],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
  const verified = JSON.parse(stdout);
  if (fingerprint(verified) !== fingerprint(descriptor)) throw new Error('Backend identity changed during SSH verification');
  return verified;
}
function verify(file, expected) {
  const descriptor = C.readJson(file);
  if (descriptor.transport || fingerprint(descriptor) !== expected) throw new Error('Remote backend descriptor changed');
  C.validateDescriptor(descriptor, descriptor.project);
  return descriptor;
}
async function ensure(file, { root = C.stateRoot(), verifyRemote = remoteVerify, spawnSsh = spawn } = {}) {
  const original = C.readJson(file);
  sshHost(original.hostname);
  if (original.transport) throw new Error('Cannot forward another forwarding descriptor');
  const localHost = os.hostname();
  const binding = path.join(root, 'backends', `ssh-${C.hash(localHost + '\0' + fingerprint(original))}.json`);
  try {
    const existing = C.readJson(binding);
    C.validateDescriptor(existing, original.project, localHost, { allowShared: true });
    // Fail closed if the upstream socket/process has been replaced or stopped.
    verifyRemote(file, original);
    return { file: binding, descriptor: existing };
  } catch (error) {
    if (error.code !== 'ENOENT' && !/stale|missing|private|SSH|socket|process|ENOENT|descriptor/i.test(error.message)) throw error;
  }
  const remote = verifyRemote(file, original);
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-ssh-'));
  fs.chmodSync(runtime, 0o700);
  const socket = path.join(runtime, 'app.sock');
  // OpenSSH's stream-local forward syntax cannot represent ':' in socket paths.
  if ([socket, remote.socket].some(p => typeof p !== 'string' || !p.startsWith('/') || /[:\n\r\0]/.test(p))) {
    throw new Error('Unsupported SSH Unix socket path');
  }
  const log = path.join(runtime, 'ssh.log');
  const stderr = fs.openSync(log, 'ax', 0o600);
  let child;
  try {
    child = spawnSsh('ssh', [...SSH_OPTIONS, '-N', '-o', 'ExitOnForwardFailure=yes',
      '-o', 'StreamLocalBindMask=0177', '-L', `${socket}:${remote.socket}`, sshHost(remote.hostname)],
    { detached: true, stdio: ['ignore', 'ignore', stderr] });
  } finally { fs.closeSync(stderr); }
  let launchError;
  child.on('error', error => { launchError = error; });
  try {
    const deadline = Date.now() + 12000;
    while (!fs.existsSync(socket)) {
      if (launchError) throw launchError;
      if (child.exitCode !== null || child.signalCode) throw new Error(`SSH forwarding exited; see ${log}`);
      if (Date.now() >= deadline) throw new Error(`SSH forwarding startup timed out; see ${log}`);
      await delay(50);
    }
    const descriptor = { ...remote, socket, transport: { kind: 'ssh-unix-v1',
      localHostname: localHost, pid: child.pid, startTicks: C.processIdentity(child.pid),
      remoteSocket: remote.socket, sourceDescriptor: file, fingerprint: fingerprint(remote), log } };
    C.validateDescriptor(descriptor, remote.project, localHost, { allowShared: true });
    const client = await C.rpcClient(socket, { timeout: 5000 });
    client.close();
    C.writeJson(binding, descriptor);
    child.unref();
    return { file: binding, descriptor };
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }
}
async function resolveBackend({ project, root = C.stateRoot(), env = process.env, host = os.hostname() }) {
  // Preserve native same-node preference and ambiguity failures.
  let local;
  try { local = C.selectBackend({ project, root, env, host }); }
  catch (error) { if (!/; found 0\./.test(error.message)) throw error; }
  if (local) {
    if (local.descriptor.transport) {
      const source = local.descriptor.transport.sourceDescriptor;
      remoteVerify(source, C.readJson(source));
    }
    return local;
  }
  const dir = path.join(root, 'backends');
  const candidates = [];
  const errors = [];
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      const d = C.readJson(file);
      if (d.transport || d.hostname === host || d.schema !== 'codex_backend_v1' || d.status !== 'ready' ||
          d.cli !== C.CLI || d.version !== C.CLI_VERSION || !d.project ||
          (env.CODEX_BACKEND_JOB && d.jobId !== env.CODEX_BACKEND_JOB) ||
          (env.CODEX_BACKEND_HOST && d.hostname !== env.CODEX_BACKEND_HOST)) continue;
      candidates.push({ file, descriptor: d });
    } catch (error) { errors.push(`${name}: ${error.message}`); }
  }
  const matching = candidates.filter(c => C.canonical(c.descriptor.project) === C.canonical(project));
  const eligible = matching.length ? matching : candidates;
  const live = [];
  // Expired descriptors must not serialize long SSH timeouts ahead of the
  // healthy node. Bound concurrency; retain ambiguity instead of picking one.
  for (let i = 0; i < eligible.length; i += 4) {
    await Promise.all(eligible.slice(i, i + 4).map(async candidate => {
      try { await remoteVerifyAsync(candidate.file, candidate.descriptor); live.push(candidate); }
      catch (error) { errors.push(`${candidate.descriptor.hostname}/${candidate.descriptor.jobId}: ${error.message}`); }
    }));
  }
  if (live.length !== 1) throw new Error(`Expected one reachable SSH backend; found ${live.length}. Select CODEX_BACKEND_JOB or CODEX_BACKEND_HOST. ${errors.join('; ')}`);
  const lockDir = C.privateDirectory(path.join(root, 'ssh-locks'));
  const lock = path.join(lockDir, `${C.hash(host + '\0' + fingerprint(live[0].descriptor))}.lock`);
  // Serialize reconnects across terminals/windows on shared storage. This is
  // a transport-only helper, never an app-server launcher or scheduler call.
  const output = execFileSync('flock', ['-w', '30', lock, process.execPath, __filename, 'ensure', live[0].file],
    { encoding: 'utf8', timeout: 45000, maxBuffer: 65536 });
  return JSON.parse(output);
}
module.exports = { SSH_OPTIONS, fingerprint, sshHost, remoteVerify, remoteVerifyAsync, verify, ensure, resolveBackend };
if (require.main === module) (async () => {
  const [action, file, expected] = process.argv.slice(2);
  if (action === 'verify') return verify(file, expected);
  if (action === 'ensure') return ensure(file);
  throw new Error('Expected SSH transport verify or ensure');
})().then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(`codex-backend SSH: ${error.message}`); process.exitCode = 1;
});
