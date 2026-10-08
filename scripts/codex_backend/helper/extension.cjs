'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { component } = require('./runtime.json');
const C = require(path.join(component, 'common.cjs'));

async function activate(context, api) {
  const vscode = api || require('vscode');
  const root = C.stateRoot();
  const projectFor = (descriptor, request) => {
    const project = C.canonical(request?.project || descriptor.project);
    const folders = vscode.workspace.workspaceFolders || [];
    const pending = context.workspaceState.get('pendingConnection');
    const restored = request && pending?.requestId === request.requestId &&
      pending.descriptor === request.descriptor && context.workspaceState.get('selectedDescriptor') === request.descriptor;
    const allowed = folders.length ? folders.some(folder => C.canonical(folder.uri.fsPath) === project) :
      restored || [...terminals.values()].some(terminal => {
        try { return C.processIdentity(terminal.pid) === terminal.startTicks && C.canonical(`/proc/${terminal.pid}/cwd`) === project; }
        catch { return false; }
      });
    if (!allowed) throw new Error('Backend project does not match this window or its terminal');
    return project;
  };
  const hook = process.env.VSCODE_IPC_HOOK_CLI || '';
  const sessionId = vscode.env.sessionId;
  const configuration = vscode.workspace.getConfiguration('chatgpt');
  const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-helper-'));
  fs.chmodSync(privateRoot, 0o700);
  const socket = path.join(privateRoot, 'control.sock');
  const registration = path.join(root, 'helpers', `${C.hash(sessionId)}.json`);
  const resultPath = id => path.join(root, 'results', `${id}.json`);
  let busy = false;
  const report = (request, value) => C.writeJson(resultPath(request.requestId), value);
  const finishConnection = async request => {
    try {
      const value = C.readJson(request.descriptor);
      const descriptor = C.validateDescriptor(value, projectFor(value, request), os.hostname(), { allowShared: true });
      const official = vscode.extensions.getExtension('openai.chatgpt');
      if (official?.packageJSON.version !== C.EXTENSION_VERSION) throw new Error('Official extension version is not supported');
      await official.activate();
      await vscode.commands.executeCommand('chatgpt.openSidebar');
      const receiptFile = C.receiptPath(root, descriptor.socket, `extension-host:${process.pid}`);
      const receipt = await C.waitForFile(receiptFile, value => value.backendId === descriptor.id &&
        value.connected && value.initialized && value.listCompleted && (!value.project || value.project === C.canonical(request.project || descriptor.project)) &&
        /vs\s*code|chatgpt/i.test(value.client || '') && (() => {
          try { return value.startTicks === C.processIdentity(value.pid); } catch { return false; }
        })());
      const snapshot = { threads: receipt.threadIds || [], activeIds: receipt.activeIds || [], partial: receipt.partial !== false };
      const result = { status: 'connected', jobId: descriptor.jobId, hostname: descriptor.hostname,
        backendId: descriptor.id, backendPid: descriptor.pid, connectionPid: receipt.pid,
        threadCount: snapshot.threads.length, partial: snapshot.partial, activeIds: snapshot.activeIds, project: projectFor(value, request),
        listCompleted: true, at: new Date().toISOString() };
      report(request, result);
      await context.workspaceState.update('pendingConnection', undefined);
      vscode.window.showInformationMessage(`Codex backend connected: job ${descriptor.jobId}, ${snapshot.activeIds.length} active session(s).`);
    } catch (error) { report(request, { status: 'failed', error: error.message }); }
  };
  const connect = async request => {
    if (busy) throw new Error('A connection operation is already in progress');
    busy = true;
    try {
      if (!/^[a-f0-9-]{36}$/.test(request.requestId || '')) throw new Error('Invalid connection request id');
      const backendDir = path.join(root, 'backends') + path.sep;
      if (!path.resolve(request.descriptor || '').startsWith(backendDir)) throw new Error('Descriptor outside backend registry');
      const value = C.readJson(request.descriptor);
      const project = projectFor(value, request);
      const descriptor = C.validateDescriptor(value, project, os.hostname(), { allowShared: true });
      const chosenComponent = request.component || component;
      if (request.component) {
        const installRoot = path.join(os.homedir(), '.local/share/codex-backend') + path.sep;
        if (!path.resolve(chosenComponent).startsWith(installRoot) || !/^[a-f0-9]{64}$/.test(path.basename(chosenComponent)) ||
            !fs.existsSync(path.join(C.privateDirectory(chosenComponent), 'installed'))) throw new Error('Unmanaged connector component');
      }
      const launcher = C.dispatcherLauncher(chosenComponent);
      C.writeJson(C.windowPath(root), { descriptor: request.descriptor, project, component: chosenComponent });
      const official = vscode.extensions.getExtension('openai.chatgpt');
      if (official?.packageJSON.version !== C.EXTENSION_VERSION) {
        throw new Error(`Official extension version mismatch: this window runs ${official?.packageJSON.version ?? 'no openai.chatgpt extension'}, but the backend requires ${C.EXTENSION_VERSION}. Run "Developer: Reload Window" (or reopen the tunnel) so this window loads the extension installed by the CLI, then repeat the connection command.`);
      }
      const selection = path.join(root, 'connections', `${C.hash(hook)}.json`);
      C.writeJson(selection, { descriptor: request.descriptor, project: C.canonical(project), hostname: os.hostname() });
      const reload = configuration.get('cliExecutable') !== launcher || context.workspaceState.get('selectedDescriptor') !== request.descriptor || context.workspaceState.get('selectedProject') !== project;
      if (reload) {
        if (context.globalState.get('originalCli') === undefined) {
          const original = configuration.inspect('cliExecutable')?.globalValue;
          await context.globalState.update('originalCli', { hadValue: original !== undefined, value: original });
        }
        await context.workspaceState.update('pendingConnection', request);
        await context.workspaceState.update('selectedLauncher', launcher);
        await context.workspaceState.update('selectedDescriptor', request.descriptor);
        await context.workspaceState.update('selectedProject', project);
        if (configuration.get('cliExecutable') !== launcher) await configuration.update('cliExecutable', launcher, vscode.ConfigurationTarget.Global);
        report(request, { status: 'reloading', backendId: descriptor.id });
        return { status: 'reloading', afterReply: () => vscode.commands.executeCommand('workbench.action.reloadWindow') };
      }
      finishConnection(request).finally(() => { busy = false; });
      return { status: 'verifying' };
    } catch (error) { busy = false; throw error; }
  };
  const server = net.createServer(connection => {
    let buffer = '';
    connection.on('error', () => {});
    connection.on('data', async chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 16384) { connection.destroy(); return; }
      if (!buffer.includes('\n')) return;
      connection.pause();
      try {
        const request = JSON.parse(buffer.split('\n')[0]);
        if (request.action === 'status') { connection.end(JSON.stringify(connectionStatus()) + '\n'); return; }
        if (request.action === 'refresh') {
          await refreshTerminals();
          connection.end(JSON.stringify({ status: 'refreshed' }) + '\n'); return;
        }
        if (request.action !== 'connect') throw new Error('Unknown connector action');
        const { afterReply, ...reply } = await connect(request);
        connection.end(JSON.stringify(reply) + '\n', () => { if (afterReply) setImmediate(afterReply); });
      } catch (error) { connection.end(JSON.stringify({ status: 'failed', error: error.message }) + '\n'); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  fs.chmodSync(socket, 0o600);
  let disposed = false;
  const hooks = new Set();
  const terminals = new Map();
  const claims = new Set([registration]);
  const register = () => {
    if (disposed) return;
    const value = { hostname: os.hostname(), projects: (vscode.workspace.workspaceFolders || []).map(f => C.canonical(f.uri.fsPath)),
      hooks: [...hooks], terminals: [...terminals.values()], socket, pid: process.pid, startTicks: C.processIdentity(process.pid), sessionId, component };
    C.writeJson(registration, value);
    const selected = context.workspaceState.get('selectedDescriptor');
    const project = context.workspaceState.get('selectedProject');
    if (selected && project) C.writeJson(C.windowPath(root), { descriptor: selected, project, component, sessionId });
    else C.writeJson(C.windowPath(root), { local: true, sessionId });
    // Persistent terminals retain their hook through a window reload. The host
    // receiving the terminal from VS Code owns its claim, even while the old
    // host remains alive for the remote reconnection grace period.
    for (const terminalHook of hooks) {
      const claim = path.join(root, 'helpers', `${C.hash('terminal:' + terminalHook)}.json`);
      C.writeJson(claim, value); claims.add(claim);
    }
    for (const terminal of terminals.values()) {
      const claim = path.join(root, 'helpers', `${C.hash(`terminal-process:${terminal.pid}:${terminal.startTicks}`)}.json`);
      C.writeJson(claim, value); claims.add(claim);
    }
  };
  const terminalOwners = new WeakMap();
  const registerTerminal = async terminal => {
    try {
      const pid = await terminal.processId;
      const previous = terminalOwners.get(terminal);
      if (previous && previous !== pid) terminals.delete(previous);
      const startTicks = C.processIdentity(pid);
      terminalOwners.set(terminal, pid);
      terminals.set(pid, { pid, startTicks });
      const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
      const value = env.find(x => x.startsWith('VSCODE_IPC_HOOK_CLI='))?.slice('VSCODE_IPC_HOOK_CLI='.length);
      if (value) hooks.add(value);
      register();
    } catch { /* Terminal may have exited before registration. */ }
  };
  async function refreshTerminals() {
    for (const [pid, terminal] of terminals) {
      try { if (C.processIdentity(pid) !== terminal.startTicks) terminals.delete(pid); }
      catch { terminals.delete(pid); }
    }
    await Promise.all((vscode.window.terminals || []).map(registerTerminal));
    register();
  }
  await refreshTerminals();
  if (vscode.window.onDidOpenTerminal) context.subscriptions.push(vscode.window.onDidOpenTerminal(registerTerminal));
  // Persistent/reused terminals can replace their shell PID and CLI hook
  // without creating a new Terminal object or firing onDidOpenTerminal.
  if (vscode.window.onDidChangeActiveTerminal) context.subscriptions.push(vscode.window.onDidChangeActiveTerminal(refreshTerminals));
  if (vscode.window.onDidChangeTerminalShellIntegration) context.subscriptions.push(vscode.window.onDidChangeTerminalShellIntegration(event => registerTerminal(event.terminal)));
  context.subscriptions.push({ dispose() {
    disposed = true;
    server.close();
    for (const file of claims) {
      try { const owner = C.readJson(file); if (owner.pid === process.pid && owner.sessionId === sessionId) fs.rmSync(file, { force: true }); }
      catch (error) { if (error.code !== 'ENOENT') console.error(error.message); }
    }
    fs.rmSync(privateRoot, { recursive: true, force: true });
  } });
  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri() {} }));
  function connectionStatus() {
    const configured = configuration.get('cliExecutable');
    let selected;
    try { selected = C.readJson(C.windowPath(root)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!selected || selected.local) return { mode: 'local', configuredCli: configured, verified: false };
    try {
      const descriptor = C.validateDescriptor(C.readJson(selected.descriptor), selected.project, os.hostname(), { allowShared: true });
      const receipt = C.readJson(C.receiptPath(root, descriptor.socket, `extension-host:${process.pid}`));
      const live = receipt.connected && receipt.initialized && receipt.backendId === descriptor.id &&
        receipt.backendPid === descriptor.pid &&
        receipt.project === selected.project && receipt.startTicks === C.processIdentity(receipt.pid);
      const configuredForBackend = configured === context.workspaceState.get('selectedLauncher');
      return { mode: live && configuredForBackend ? 'slurm' : 'configured-unverified', verified: Boolean(live && configuredForBackend),
        project: selected.project, jobId: descriptor.jobId, hostname: descriptor.hostname, backendPid: descriptor.pid,
        relayPid: receipt.pid, configuredCli: configured, initialized: receipt.initialized, listCompleted: receipt.listCompleted };
    } catch (error) { return { mode: 'configured-unverified', verified: false, project: selected.project, error: error.message }; }
  }
  context.subscriptions.push(vscode.commands.registerCommand('mdlammps.codexBackend.status', async () => {
    const status = connectionStatus();
    vscode.window.showInformationMessage(status.verified ?
      `Codex: Slurm job ${status.jobId} on ${status.hostname}, backend PID ${status.backendPid}, project ${status.project}` :
      `Codex: ${status.mode}${status.error ? ': ' + status.error : ''}`);
    return status;
  }));
  context.subscriptions.push(vscode.commands.registerCommand('mdlammps.codexBackend.restore', async () => {
    // Unbind only this extension host. Other windows still use the dispatcher.
    fs.rmSync(C.windowPath(root), { force: true });
    await context.workspaceState.update('selectedDescriptor', undefined);
    await context.workspaceState.update('selectedProject', undefined);
    await context.workspaceState.update('pendingConnection', undefined);
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }));
  const pending = context.workspaceState.get('pendingConnection');
  if (pending) {
    // A legacy helper can reload into this version with its old bound launcher.
    // Migrate before the official startup event, without another reload.
    const launcher = C.dispatcherLauncher(component);
    await context.workspaceState.update('selectedLauncher', launcher);
    if (configuration.get('cliExecutable') !== launcher) await configuration.update('cliExecutable', launcher, vscode.ConfigurationTarget.Global);
    finishConnection(pending);
  }
  return { connect, connectionStatus };
}
module.exports = { activate };
