'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { component } = require('./runtime.json');
const C = require(path.join(component, 'common.cjs'));
async function activate(context, api) {
  const vscode = api || require('vscode');
  const root = C.root();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-helper-')); fs.chmodSync(dir, 0o700);
  const socket = path.join(dir, 'control.sock');
  const hooks = new Set(), terminals = new Map();
  const registration = path.join(root, 'helpers', `${C.hash(vscode.env.sessionId)}.json`);
  const windowFile = path.join(root, 'windows', `${process.pid}-${C.processIdentity(process.pid)}.json`);
  const register = () => {
    const value = { hostname: os.hostname(), pid: process.pid, startTicks: C.processIdentity(process.pid), socket, component,
      projects: (vscode.workspace.workspaceFolders || []).map(f => C.canonical(f.uri.fsPath)), hooks: [...hooks], terminals: [...terminals.values()] };
    C.writeJson(registration, value);
    for (const hook of hooks) C.writeJson(path.join(root, 'helpers', `${C.hash('terminal:' + hook)}.json`), value);
    for (const terminal of terminals.values()) C.writeJson(path.join(root, 'helpers', `${C.hash(`terminal-process:${terminal.pid}:${terminal.startTicks}`)}.json`), value);
  };
  const owners = new WeakMap();
  const registerTerminal = async terminal => {
    try {
      const pid = await terminal.processId, previous = owners.get(terminal);
      if (previous && previous !== pid) terminals.delete(previous);
      const startTicks = C.processIdentity(pid); owners.set(terminal, pid); terminals.set(pid, { pid, startTicks });
      const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
      const hook = env.find(v => v.startsWith('VSCODE_IPC_HOOK_CLI='))?.slice('VSCODE_IPC_HOOK_CLI='.length);
      if (hook) hooks.add(hook); register();
    } catch { /* Terminal may have closed during registration. */ }
  };
  const refresh = async () => {
    for (const [pid, t] of terminals) { try { if (C.processIdentity(pid) !== t.startTicks) terminals.delete(pid); } catch { terminals.delete(pid); } }
    await Promise.all((vscode.window.terminals || []).map(registerTerminal)); register();
  };
  const config = vscode.workspace.getConfiguration('claudeCode');
  const dispatcher = chosen => {
    const launcher = path.join(C.privateDirectory(path.join(os.homedir(), '.local/share/claude-backend')), 'launcher.sh');
    const node = fs.readFileSync(path.join(chosen, 'node-path'), 'utf8').trim();
    const temp = launcher + '.' + process.pid;
    fs.writeFileSync(temp, `#!/usr/bin/env bash\nexec ${C.quote(node)} ${C.quote(path.join(chosen, 'dispatcher.cjs'))} "$@"\n`, { mode: 0o700 });
    fs.renameSync(temp, launcher); return launcher;
  };
  const restore = async () => {
    fs.rmSync(windowFile, { force: true });
    await context.workspaceState.update('selectedConnection', undefined);
    let another = false;
    const windows = path.join(root, 'windows');
    for (const file of fs.existsSync(windows) ? fs.readdirSync(windows) : []) {
      const match = file.match(/^(\d+)-(\d+)\.json$/); if (!match) continue;
      try { if (C.processIdentity(Number(match[1])) === match[2]) another = true; } catch { /* Stale binding. */ }
    }
    if (!another) {
      try {
        const original = C.readJson(path.join(root, 'original-wrapper.json'));
        if (config.get('claudeProcessWrapper') === path.join(os.homedir(), '.local/share/claude-backend/launcher.sh')) await config.update('claudeProcessWrapper', original.value, vscode.ConfigurationTarget.Global);
        fs.rmSync(path.join(root, 'original-wrapper.json'), { force: true });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return { status: 'local' };
  };
  const status = () => {
    let selected; try { selected = C.readJson(windowFile); } catch { return { mode: 'local', verified: false }; }
    const receipts = [];
    const receiptDir = path.join(root, 'receipts');
    for (const name of fs.existsSync(receiptDir) ? fs.readdirSync(receiptDir) : []) {
      try {
        const r = C.readJson(path.join(receiptDir, name));
        if (r.backend === selected.descriptor && r.windowPid === process.pid && r.connected && r.entrypoint === 'claude-vscode' &&
            r.hostname === os.hostname() && C.processIdentity(r.wrapperPid) === r.wrapperStartTicks) receipts.push(r);
      } catch { /* Expired process receipts are not proof. */ }
    }
    return { mode: 'backend', ...selected, verified: receipts.length > 0, receipts };
  };
  const connect = async request => {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this VS Code workspace first');
    const project = C.canonical(request.project);
    if (!(vscode.workspace.workspaceFolders || []).some(f => C.canonical(f.uri.fsPath) === project)) throw new Error('Project does not belong to this VS Code window');
    if (path.dirname(path.resolve(request.descriptor)) !== path.join(root, 'backends')) throw new Error('Descriptor outside Claude backend registry');
    const d = C.readJson(request.descriptor); C.validate(d, false);
    await require(path.join(component, 'transport.cjs')).probe(request.descriptor);
    const chosen = C.canonical(request.component);
    const install = C.canonical(path.join(os.homedir(), '.local/share/claude-backend'));
    if (path.dirname(chosen) !== install || !/^[a-f0-9]{64}$/.test(path.basename(chosen)) || !fs.existsSync(path.join(chosen, 'installed'))) throw new Error('Unmanaged Claude component');
    const official = vscode.extensions.getExtension('anthropic.claude-code');
    if (!official?.packageJSON.contributes?.configuration?.properties?.['claudeCode.claudeProcessWrapper']) throw new Error('Install an official Claude Code extension supporting claudeProcessWrapper');
    const originalFile = path.join(root, 'original-wrapper.json');
    if (!fs.existsSync(originalFile)) C.writeJson(originalFile, { value: config.inspect('claudeProcessWrapper')?.globalValue });
    const launcher = dispatcher(chosen);
    C.writeJson(windowFile, { windowPid: process.pid, descriptor: request.descriptor, component: chosen, project, jobId: d.jobId, hostname: d.hostname, extensionVersion: official.packageJSON.version });
    await context.workspaceState.update('selectedConnection', { descriptor: request.descriptor, component: chosen, project });
    if (config.get('claudeProcessWrapper') !== launcher) await config.update('claudeProcessWrapper', launcher, vscode.ConfigurationTarget.Global);
    return { status: 'configured', jobId: d.jobId, hostname: d.hostname, extensionVersion: official.packageJSON.version, verified: false };
  };
  const server = net.createServer(connection => {
    connection.on('error', () => {}); let buffer = '';
    connection.on('data', async chunk => {
      buffer += chunk; if (buffer.length > 16384) { connection.destroy(); return; } if (!buffer.includes('\n')) return;
      connection.pause();
      try {
        const request = JSON.parse(buffer.split('\n')[0]); let value;
        if (request.action === 'refresh') { await refresh(); value = { status: 'refreshed' }; }
        else if (request.action === 'connect') value = await connect(request);
        else if (request.action === 'status') value = status();
        else if (request.action === 'restore') value = await restore();
        else throw new Error('Unknown helper action');
        connection.end(JSON.stringify(value) + '\n');
      } catch (error) { connection.end(JSON.stringify({ status: 'failed', error: error.message }) + '\n'); }
    });
  });
  await new Promise(resolve => server.listen(socket, resolve)); fs.chmodSync(socket, 0o600);
  if (vscode.window.onDidOpenTerminal) context.subscriptions.push(vscode.window.onDidOpenTerminal(registerTerminal));
  if (vscode.window.onDidChangeTerminalShellIntegration) context.subscriptions.push(vscode.window.onDidChangeTerminalShellIntegration(e => registerTerminal(e.terminal)));
  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri() { refresh(); } }));
  context.subscriptions.push(vscode.commands.registerCommand('slurm-agent.claudeBackend.restore', restore));
  context.subscriptions.push(vscode.commands.registerCommand('slurm-agent.claudeBackend.status', () => vscode.window.showInformationMessage(JSON.stringify(status()))));
  context.subscriptions.push({ dispose() { server.close(); fs.rmSync(windowFile, { force: true }); fs.rmSync(registration, { force: true }); fs.rmSync(socket, { force: true }); } });
  await refresh();
  const previous = context.workspaceState.get('selectedConnection');
  if (previous) {
    try { await connect({ ...previous, component }); }
    catch (error) { vscode.window.showInformationMessage(`Claude backend needs reconnect: ${error.message}`); }
  }
}
module.exports = { activate, deactivate() {} };
