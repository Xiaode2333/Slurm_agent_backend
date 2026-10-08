'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const CLI_VERSION = '0.160.1';
const EXTENSION_VERSION = '26.930.61225';
const CLI = path.join(os.homedir(), '.npm-global/bin/codex');
const stateRoot = () => path.join(os.homedir(), '.local/state/codex-backend');
const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
const canonical = value => fs.realpathSync(value);

function privateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error(`Not a private directory owned by this user: ${dir}`);
  }
  return dir;
}
function writeJson(file, value) {
  privateDirectory(path.dirname(file));
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
}
function readJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error(`Not a private file owned by this user: ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid backend PID');
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}
function checkCli() {
  // Loading the native CLI from cold shared storage can exceed ten seconds.
  const version = execFileSync(CLI, ['--version'], { encoding: 'utf8', timeout: 120000 }).trim();
  if (version !== `codex-cli ${CLI_VERSION}`) {
    throw new Error(`Unsupported CLI: ${version}; expected ${CLI_VERSION} at ${CLI}`);
  }
  return CLI_VERSION;
}
function validateDescriptor(descriptor, project, host = os.hostname(), { allowShared = false } = {}) {
  const transport = descriptor.transport;
  if (descriptor.schema !== 'codex_backend_v1' || descriptor.status !== 'ready' ||
      (!transport && descriptor.hostname !== host) || descriptor.cli !== CLI || descriptor.version !== CLI_VERSION ||
      (!allowShared && canonical(descriptor.project) !== canonical(project))) {
    throw new Error('Backend descriptor is stale, incompatible, or belongs to another node/project');
  }
  if (transport) {
    const T = require('./ssh-transport.cjs');
    const upstream = readJson(transport.sourceDescriptor);
    const args = fs.readFileSync(`/proc/${transport.pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    const forward = args.indexOf('-L');
    if (transport.kind !== 'ssh-unix-v1' || transport.localHostname !== host || upstream.transport ||
        transport.startTicks !== processIdentity(transport.pid) ||
        T.fingerprint(upstream) !== transport.fingerprint ||
        T.fingerprint({ ...descriptor, socket: transport.remoteSocket, transport: undefined }) !== transport.fingerprint ||
        forward < 0 || args[forward + 1] !== `${descriptor.socket}:${transport.remoteSocket}` || args.at(-1) !== descriptor.hostname) {
      throw new Error('SSH backend descriptor is stale or belongs to another node/process');
    }
  } else if (descriptor.startTicks !== processIdentity(descriptor.pid)) {
    throw new Error('Backend descriptor is stale, incompatible, or belongs to another node/project');
  }
  const socket = fs.statSync(descriptor.socket);
  if (!socket.isSocket() || socket.uid !== process.getuid() || (socket.mode & 0o077)) {
    throw new Error('Backend socket is missing or not private');
  }
  return descriptor;
}
function selectBackend({ root = stateRoot(), project, env = process.env, host = os.hostname() }) {
  const dir = path.join(root, 'backends');
  project = canonical(project);
  const job = env.CODEX_BACKEND_JOB || env.SLURM_JOB_ID;
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(x => x.endsWith('.json')) : [];
  const candidates = [];
  const errors = [];
  let knownAllocation = false;
  for (const name of files) {
    const file = path.join(dir, name);
    try {
      const value = readJson(file);
      if ((value.transport ? value.transport.localHostname !== host : value.hostname !== host) ||
          (env.CODEX_BACKEND_HOST && value.hostname !== env.CODEX_BACKEND_HOST) || !value.project) continue;
      if (job && value.jobId === job) knownAllocation = true;
      validateDescriptor(value, project, host, { allowShared: true });
      candidates.push({ file, descriptor: value });
    } catch (error) { errors.push(`${name}: ${error.message}`); }
  }
  // A Tunnel can run in a separate allocation on this same node. Prefer its
  // allocation when registered; otherwise require a unique node/project match.
  const native = candidates.filter(x => !x.descriptor.transport);
  const preferred = !env.CODEX_BACKEND_JOB && !env.CODEX_BACKEND_HOST && native.length ? native : candidates;
  const projectCandidates = preferred.filter(x => canonical(x.descriptor.project) === project);
  const matches = job && (knownAllocation || env.CODEX_BACKEND_JOB) ? candidates.filter(x => x.descriptor.jobId === job) :
    projectCandidates.length ? projectCandidates : preferred;
  if (matches.length !== 1) {
    throw new Error(`Expected one backend on ${host}${job && knownAllocation ? ` in allocation ${job}` : ''}; found ${matches.length}. ${errors.join('; ')}`);
  }
  return matches[0];
}
function connectSocket(socket) {
  const WebSocket = require('ws');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws+unix://${socket}:/`, { handshakeTimeout: 10000, maxPayload: 64 * 1024 * 1024 });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
async function rpcClient(socket, { timeout = 20000 } = {}) {
  const ws = await connectSocket(socket);
  const pending = new Map();
  let nextId = 1;
  const rejectAll = error => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear();
  };
  ws.on('error', rejectAll);
  ws.on('close', () => rejectAll(new Error('Backend disconnected')));
  ws.on('message', data => {
    const message = JSON.parse(data.toString());
    const p = pending.get(message.id);
    if (!p || message.method) return;
    pending.delete(message.id); clearTimeout(p.timer);
    message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, timeout);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  try {
    const initialized = await request('initialize', {
      clientInfo: { name: 'mdlammps_backend_probe', title: 'Backend connection probe', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    if (!initialized.userAgent?.includes(`/${CLI_VERSION}`)) throw new Error('Backend handshake version mismatch');
    ws.send(JSON.stringify({ method: 'initialized', params: {} }));
    return { request, close: () => ws.close(), initialized };
  } catch (error) { ws.terminate(); throw error; }
}
async function inspectBackend(descriptor, { project = descriptor.project, exhaustive = true } = {}) {
  const client = await rpcClient(descriptor.socket);
  try {
    const threads = [];
    let cursor = null;
    do {
      const page = await client.request('thread/list', {
        limit: exhaustive ? 100 : 20, cursor, cwd: canonical(project) === canonical(descriptor.project) ? descriptor.projectAliases || project : project, archived: false,
        sourceKinds: ['cli', 'vscode', 'appServer'], useStateDbOnly: true,
      });
      threads.push(...page.data); cursor = page.nextCursor;
    } while (cursor && exhaustive);
    const { data: loaded } = await client.request('thread/loaded/list', {});
    const loadedSet = new Set(loaded);
    await Promise.all(threads.map(async thread => {
      if (loadedSet.has(thread.id)) {
        const result = await client.request('thread/read', { threadId: thread.id, includeTurns: false });
        thread.status = result.thread.status;
      }
    }));
    return { threads, partial: Boolean(cursor), activeIds: threads.filter(t => t.status?.type === 'active').map(t => t.id) };
  } finally { client.close(); }
}
async function discoverProjectAliases(socket, project) {
  const client = await rpcClient(socket);
  const aliases = new Set([canonical(project)]);
  const checked = new Map();
  try {
    for (const archived of [false, true]) {
      let cursor = null;
      do {
        const page = await client.request('thread/list', { limit: 100, cursor, archived,
          sourceKinds: ['cli', 'vscode', 'appServer'], useStateDbOnly: true });
        for (const thread of page.data) {
          if (!thread.cwd) continue;
          if (!checked.has(thread.cwd)) {
            try { checked.set(thread.cwd, canonical(thread.cwd) === canonical(project)); }
            catch { checked.set(thread.cwd, false); }
          }
          if (checked.get(thread.cwd)) aliases.add(thread.cwd);
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    return [...aliases];
  } finally { client.close(); }
}
function waitForFile(file, predicate, timeout = 90000) {
  return new Promise((resolve, reject) => {
    privateDirectory(path.dirname(file));
    let done = false;
    const finish = (error, value) => {
      if (done) return; done = true;
      watcher.close(); clearInterval(fallback); clearTimeout(deadline);
      error ? reject(error) : resolve(value);
    };
    const check = () => {
      try { const value = readJson(file); if (predicate(value)) finish(null, value); }
      catch (error) { if (error.code !== 'ENOENT') finish(error); }
    };
    const watcher = fs.watch(path.dirname(file), check);
    // NFS may not deliver cross-process watch events: bounded fallback only.
    const fallback = setInterval(check, 1000);
    const deadline = setTimeout(() => finish(new Error(`Timed out waiting for ${file}`)), timeout);
    check();
  });
}
const receiptPath = (root, socket, hook) => path.join(root, 'receipts', `${hash(socket + '\0' + (hook || ''))}.json`);
const windowPath = (root, pid = process.pid) => path.join(root, 'windows', `${hash(os.hostname())}-${pid}-${processIdentity(pid)}.json`);
function dispatcherLauncher(component) {
  const dir = privateDirectory(path.join(os.homedir(), '.local/share/codex-backend'));
  const file = path.join(dir, 'dispatcher.sh');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const node = fs.readFileSync(path.join(component, 'node-path'), 'utf8').trim();
  const text = `#!/usr/bin/env bash\nexec ${quote(node)} ${quote(path.join(component, 'dispatcher.cjs'))} "$@"\n`;
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) {
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, text, { mode: 0o700 }); fs.renameSync(temp, file);
  }
  return file;
}
function connectionLauncher(component, descriptorFile, root = stateRoot(), project = '') {
  const dir = privateDirectory(path.join(root, 'launchers', hash(component + '\0' + descriptorFile + '\0' + project)));
  const file = path.join(dir, 'launcher.sh');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(file, `#!/usr/bin/env bash\nexport CODEX_BACKEND_DESCRIPTOR_FILE=${quote(descriptorFile)}\nexport CODEX_BACKEND_PROJECT=${quote(project)}\nexec ${quote(path.join(component, 'launcher.sh'))} "$@"\n`, { mode: 0o700 });
  return file;
}
module.exports = { CLI, CLI_VERSION, EXTENSION_VERSION, stateRoot, hash, canonical, privateDirectory,
  writeJson, readJson, processIdentity, checkCli, validateDescriptor, selectBackend,
  connectSocket, rpcClient, inspectBackend, discoverProjectAliases, waitForFile, receiptPath, windowPath,
  dispatcherLauncher, connectionLauncher };
