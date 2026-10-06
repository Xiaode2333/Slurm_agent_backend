'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const C = require('./common.cjs');

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
async function connect(project, action = 'connect') {
  C.checkCli();
  const selected = C.selectBackend({ project });
  selected.descriptor.projectAliases = await C.discoverProjectAliases(selected.descriptor.socket, project);
  C.writeJson(selected.file, selected.descriptor);
  const snapshot = await C.inspectBackend(selected.descriptor);
  if (action === 'status') {
    console.log(JSON.stringify({ ...selected, snapshot }, null, 2)); return;
  }
  if (action !== 'connect') throw new Error('Usage: connect_codex_backend.sh [connect|status|check]');
  const hook = process.env.VSCODE_IPC_HOOK_CLI;
  if (!hook) throw new Error('Run in a VS Code Tunnel integrated terminal');
  let helper = findHelper(project, hook);
  if (!helper || helper.component !== __dirname) {
    const installed = execFileSync('code', ['--list-extensions', '--show-versions'], { encoding: 'utf8', timeout: 30000 });
    const official = installed.split(/\r?\n/).find(line => line.startsWith('openai.chatgpt@'));
    if (official && official !== `openai.chatgpt@${C.EXTENSION_VERSION}`) throw new Error(`Unsupported official extension: ${official}`);
    if (!official) execFileSync('code', ['--install-extension', `openai.chatgpt@${C.EXTENSION_VERSION}`], { stdio: 'inherit', timeout: 120000 });
    execFileSync('code', ['--install-extension', path.join(__dirname, 'codex-backend.vsix'), '--force'], { stdio: 'inherit', timeout: 120000 });
    const deadline = Date.now() + 90000;
    do {
      helper = findHelper(project, hook);
      if (helper) break;
      await delay(250);
    } while (Date.now() < deadline);
    if (!helper) throw new Error(`No connector registration matched this terminal on ${os.hostname()} in ${C.canonical(project)} (hook ${hook}). The extension may be disabled, the workspace untrusted, or terminal ownership unavailable`);
  }
  const requestId = crypto.randomUUID();
  const reply = await send(helper.socket, { action: 'connect', requestId, descriptor: selected.file, component: __dirname });
  if (reply.status === 'failed') throw new Error(reply.error);
  if (reply.status === 'reloading') console.log('Applying backend connection; VS Code will reload once. The backend keeps running.');
  const result = await C.waitForFile(path.join(C.stateRoot(), 'results', `${requestId}.json`),
    value => value.status === 'connected' || value.status === 'failed');
  if (result.status === 'failed') throw new Error(result.error);
  console.log(`CONNECTED job=${result.jobId} node=${result.hostname} backend_pid=${result.backendPid} sessions=${result.threadCount} active=${result.activeIds.length}`);
}
module.exports = { findHelper, send, connect };
if (require.main === module) connect(...process.argv.slice(2)).catch(error => {
  process.stderr.write(`codex-backend: ${error.message}\n`); process.exitCode = 1;
});
