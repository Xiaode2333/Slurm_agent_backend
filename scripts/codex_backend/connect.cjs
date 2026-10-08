'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const C = require('./common.cjs');

function matchesComponent(helper, component = __dirname) {
  try { return !!helper?.component && C.canonical(helper.component) === C.canonical(component); }
  catch { return false; }
}
function findHelper(project, hook, root = C.stateRoot()) {
  const dir = path.join(root, 'helpers');
  const valid = item => item.hostname === os.hostname() &&
    (item.projects.includes(C.canonical(project)) || (!item.projects.length && (item.terminals || []).some(terminal => {
      try { return terminal.startTicks === C.processIdentity(terminal.pid) && C.canonical(`/proc/${terminal.pid}/cwd`) === C.canonical(project); }
      catch { return false; }
    }))) && item.startTicks === C.processIdentity(item.pid) && fs.statSync(item.socket).isSocket();
  // Shell integration can replace the CLI hook after the terminal process was
  // created. Its process ancestry still identifies the owning VS Code window.
  let pid = process.ppid;
  const initialHooks = new Set();
  for (let depth = 0; pid > 1 && depth < 32; depth++) {
    try {
      const ticks = C.processIdentity(pid);
      const file = path.join(dir, `${C.hash(`terminal-process:${pid}:${ticks}`)}.json`);
      if (fs.existsSync(file)) {
        const item = C.readJson(file);
        try { return valid(item) ? item : undefined; } catch { return undefined; }
      }
      const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
      const initial = env.find(value => value.startsWith('VSCODE_IPC_HOOK_CLI='))?.slice('VSCODE_IPC_HOOK_CLI='.length);
      if (initial) initialHooks.add(initial);
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
      break; // An ancestor can belong to Slurm/root; do not inspect past it.
    }
  }
  // Older installed helpers know the terminal's initial hook. Use that
  // process-backed identity to let them apply the upgraded component and reload.
  for (const initial of initialHooks) {
    if (initial === hook) continue;
    const item = findHelperByHook(initial);
    if (item) return item;
  }
  return findHelperByHook(hook);
  function findHelperByHook(hook) {
    const hookMatches = item => (item.hooks || [item.hook]).includes(hook);
    let owner;
    try { owner = C.readJson(path.join(dir, `${C.hash('terminal:' + hook)}.json`)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (owner) {
      try { return valid(owner) && hookMatches(owner) ? owner : undefined; }
      catch { return undefined; }
    }
    const matches = [];
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!name.endsWith('.json')) continue;
      try {
        const item = C.readJson(path.join(dir, name));
        if (!valid(item) || !hookMatches(item)) continue;
        matches.push(item);
      } catch { /* Ignore expired extension-host registrations. */ }
    }
    if (matches.length > 1) throw new Error('Multiple VS Code windows match this terminal; close the duplicate project window');
    return matches[0];
  }
}
function send(socket, value) {
  return new Promise((resolve, reject) => {
    const connection = net.createConnection(socket);
    let buffer = '';
    connection.setTimeout(20000, () => connection.destroy(new Error('Helper request timeout')));
    connection.on('error', reject);
    connection.on('connect', () => connection.write(JSON.stringify(value) + '\n'));
    connection.on('data', chunk => {
      buffer += chunk;
      if (buffer.includes('\n')) { connection.end(); resolve(JSON.parse(buffer.split('\n')[0])); }
    });
    connection.on('end', () => { if (!buffer.includes('\n')) reject(new Error('Helper closed without a reply')); });
  });
}
function installVsix() {
  const vsix = path.join(__dirname, 'codex-backend.vsix');
  try {
    const output = execFileSync('code', ['--install-extension', vsix, '--force'], {
      encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'], timeout: 120000,
    });
    process.stdout.write(output);
    return;
  } catch (error) {
    const output = `${error.stdout || ''}${error.stderr || ''}`;
    process.stderr.write(output);
    if (!/compatible with VS Code/i.test(output)) throw error;
    // The installed component may predate dynamic engine ranges (the
    // component hash only changes when source changes), so repackage the
    // vsix against the client's own version and retry once.
    console.error('Connector package is not compatible with the local VS Code version; repackaging with a matching engine range.');
    execFileSync(process.execPath, [path.join(__dirname, 'package-helper.cjs'), __dirname], { stdio: 'inherit', timeout: 60000 });
    execFileSync('code', ['--install-extension', vsix, '--force'], { stdio: 'inherit', timeout: 120000 });
  }
}
async function refreshHelpers(project, root = C.stateRoot()) {
  const dir = path.join(root, 'helpers');
  const sockets = new Set();
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!name.endsWith('.json')) continue;
    try {
      const item = C.readJson(path.join(dir, name));
      if (item.hostname === os.hostname() && item.startTicks === C.processIdentity(item.pid) &&
          (!item.projects?.length || item.projects.includes(C.canonical(project))) && fs.statSync(item.socket).isSocket()) sockets.add(item.socket);
    } catch { /* Expired registrations cannot refresh or claim a terminal. */ }
  }
  // Refresh ownership only; never bind a window from a workspace match alone.
  await Promise.all([...sockets].map(async socket => {
    try { await send(socket, { action: 'refresh' }); }
    catch { /* Legacy helpers need one window reload to support refresh. */ }
  }));
  return sockets.size;
}
async function connect(project, action = 'connect') {
  project = C.canonical(project);
  const selected = await require('./ssh-transport.cjs').resolveBackend({ project });
  if (action === 'refresh-history') {
    const rpc = await C.rpcClient(selected.descriptor.socket, { timeout: 120000 });
    try { await rpc.request('thread/list', { limit: 1, cwd: project, useStateDbOnly: false }); }
    finally { rpc.close(); }
    const paths = await C.discoverProjectAliases(selected.descriptor.socket, project);
    C.writeJson(path.join(C.stateRoot(), 'aliases', `${C.hash(project)}.json`), { paths });
    console.log(`HISTORY_REFRESHED project=${project} aliases=${paths.length}`); return;
  }
  if (action === 'status' || action === 'doctor') {
    const hook = process.env.VSCODE_IPC_HOOK_CLI;
    const helper = hook && findHelper(project, hook);
    const window = matchesComponent(helper) ? await send(helper.socket, { action: 'status' }) :
      { mode: helper ? 'legacy-connector-unverified' : 'window-unverified', verified: false };
    let health;
    if (action === 'doctor') {
      const started = performance.now();
      try { const client = await C.rpcClient(selected.descriptor.socket, { timeout: 5000 }); client.close(); health = { initializeMs: performance.now() - started }; }
      catch (error) { health = { error: error.message }; }
    }
    console.log(JSON.stringify({ project, backendAvailable: true, backend: { jobId: selected.descriptor.jobId,
      hostname: selected.descriptor.hostname, pid: selected.descriptor.pid, startupProject: selected.descriptor.project,
      transport: selected.descriptor.transport?.kind || 'local-unix', clientHostname: os.hostname() }, window, health }, null, 2)); return;
  }
  if (action !== 'connect') throw new Error('Usage: connect_codex_backend.sh [--project DIR] [connect|status|doctor|refresh-history|check]');
  const hook = process.env.VSCODE_IPC_HOOK_CLI;
  if (!hook) throw new Error('Run in a VS Code Tunnel integrated terminal');
  let helper = findHelper(project, hook);
  if (!helper) {
    await refreshHelpers(project);
    helper = findHelper(project, hook);
  }
  if (!matchesComponent(helper)) {
    const installed = execFileSync('code', ['--list-extensions', '--show-versions'], { encoding: 'utf8', timeout: 30000 });
    const official = installed.split(/\r?\n/).find(line => line.startsWith('openai.chatgpt@'));
    if (official && official !== `openai.chatgpt@${C.EXTENSION_VERSION}`) {
      console.error(`Official extension ${official} does not match the supported ${C.EXTENSION_VERSION}; reinstalling.`);
      execFileSync('code', ['--uninstall-extension', 'openai.chatgpt', '--force'], { stdio: 'inherit', timeout: 120000 });
    }
    execFileSync('code', ['--install-extension', `openai.chatgpt@${C.EXTENSION_VERSION}`, '--force'], { stdio: 'inherit', timeout: 120000 });
    installVsix();
    if (!helper && await refreshHelpers(project)) {
      helper = findHelper(project, hook);
      if (!helper) throw new Error('Connector installed, but the active window still has stale terminal PID/hook registrations. Run Developer: Reload Window once, then repeat this command. Backend restart is not needed.');
    }
    const deadline = Date.now() + 90000;
    do {
      helper = findHelper(project, hook);
      if (helper) break;
      await delay(250);
    } while (Date.now() < deadline);
    if (!helper) throw new Error(`No connector registration matched this terminal on ${os.hostname()} in ${C.canonical(project)} (hook ${hook}). The extension may be disabled, the workspace untrusted, or terminal ownership unavailable`);
    if (!matchesComponent(helper) && (selected.descriptor.transport || C.canonical(selected.descriptor.project) !== project)) {
      throw new Error('Connector updated, but this window still runs the old helper, which cannot validate this remote/project binding. Run Developer: Reload Window once, then repeat the connection command. The backend keeps running.');
    }
  }
  const requestId = crypto.randomUUID();
  // Preserve the managed path spelling for helpers predating canonical validation.
  const requestedComponent = matchesComponent(helper) ? helper.component : __dirname;
  const reply = await send(helper.socket, { action: 'connect', requestId, descriptor: selected.file, project, component: requestedComponent });
  if (reply.status === 'failed') throw new Error(reply.error);
  if (reply.status === 'reloading') console.log('Applying backend connection; VS Code will reload once. The backend keeps running.');
  const result = await C.waitForFile(path.join(C.stateRoot(), 'results', `${requestId}.json`),
    value => value.status === 'connected' || value.status === 'failed');
  if (result.status === 'failed') throw new Error(result.error);
  console.log(`CONNECTED project=${result.project} job=${result.jobId} node=${result.hostname} backend_pid=${result.backendPid} sessions=${result.partial ? '>=' : ''}${result.threadCount} active_on_page=${result.activeIds.length}`);
}
module.exports = { matchesComponent, findHelper, refreshHelpers, send, connect, installVsix };
if (require.main === module) connect(...process.argv.slice(2)).catch(error => {
  process.stderr.write(`codex-backend: ${error.message}\n`); process.exitCode = 1;
});
