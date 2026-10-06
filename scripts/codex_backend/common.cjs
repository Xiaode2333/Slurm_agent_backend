'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const WebSocket = require('ws');

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
function validateDescriptor(descriptor, project, host = os.hostname()) {
  if (descriptor.schema !== 'codex_backend_v1' || descriptor.status !== 'ready' ||
      descriptor.hostname !== host || descriptor.cli !== CLI || descriptor.version !== CLI_VERSION ||
      canonical(descriptor.project) !== canonical(project) ||
      descriptor.startTicks !== processIdentity(descriptor.pid)) {
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
  const job = env.SLURM_JOB_ID;
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(x => x.endsWith('.json')) : [];
  const candidates = [];
  const errors = [];
  let knownAllocation = false;
  for (const name of files) {
    const file = path.join(dir, name);
    try {
      const value = readJson(file);
      if (value.hostname !== host ||
          canonical(value.project) !== canonical(project)) continue;
      if (job && value.jobId === job) knownAllocation = true;
      validateDescriptor(value, project, host);
      candidates.push({ file, descriptor: value });
    } catch (error) { errors.push(`${name}: ${error.message}`); }
  }
  // A Tunnel can run in a separate allocation on this same node. Prefer its
  // allocation when registered; otherwise require a unique node/project match.
  const matches = job && knownAllocation ? candidates.filter(x => x.descriptor.jobId === job) : candidates;
  if (matches.length !== 1) {
    throw new Error(`Expected one backend on ${host}${job && knownAllocation ? ` in allocation ${job}` : ''}; found ${matches.length}. ${errors.join('; ')}`);
  }
  return matches[0];
}
function connectSocket(socket) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws+unix://${socket}:/`, { handshakeTimeout: 10000, maxPayload: 64 * 1024 * 1024 });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
async function rpcClient(socket) {
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
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 20000);
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
async function inspectBackend(descriptor) {
  const client = await rpcClient(descriptor.socket);
  try {
    const threads = [];
    let cursor = null;
    do {
      const page = await client.request('thread/list', {
        limit: 100, cursor, cwd: descriptor.projectAliases || descriptor.project, archived: false,
        sourceKinds: ['cli', 'vscode', 'appServer'], useStateDbOnly: true,
      });
      threads.push(...page.data); cursor = page.nextCursor;
    } while (cursor);
    const { data: loaded } = await client.request('thread/loaded/list', {});
    const loadedSet = new Set(loaded);
    for (const thread of threads) {
      if (loadedSet.has(thread.id)) {
        const result = await client.request('thread/read', { threadId: thread.id, includeTurns: false });
        thread.status = result.thread.status;
      }
    }
    return { threads, activeIds: threads.filter(t => t.status?.type === 'active').map(t => t.id) };
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
function connectionLauncher(component, descriptorFile, root = stateRoot()) {
  const dir = privateDirectory(path.join(root, 'launchers', hash(component + '\0' + descriptorFile)));
  const file = path.join(dir, 'launcher.sh');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(file, `#!/usr/bin/env bash\nexport CODEX_BACKEND_DESCRIPTOR_FILE=${quote(descriptorFile)}\nexec ${quote(path.join(component, 'launcher.sh'))} "$@"\n`, { mode: 0o700 });
  return file;
}
module.exports = { CLI, CLI_VERSION, EXTENSION_VERSION, stateRoot, hash, canonical, privateDirectory,
  writeJson, readJson, processIdentity, checkCli, validateDescriptor, selectBackend,
  connectSocket, rpcClient, inspectBackend, discoverProjectAliases, waitForFile, receiptPath, connectionLauncher };
