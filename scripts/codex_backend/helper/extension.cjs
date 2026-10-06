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
    const project = C.canonical(descriptor.project);
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
      const descriptor = C.validateDescriptor(value, projectFor(value, request));
      const official = vscode.extensions.getExtension('openai.chatgpt');
      if (official?.packageJSON.version !== C.EXTENSION_VERSION) throw new Error('Official extension version is not supported');
      await official.activate();
      await vscode.commands.executeCommand('chatgpt.openSidebar');
      const receiptFile = C.receiptPath(root, descriptor.socket, `extension-host:${process.pid}`);
      const receipt = await C.waitForFile(receiptFile, value => value.backendId === descriptor.id &&
        value.connected && value.initialized && value.listCompleted &&
        /vs\s*code|chatgpt/i.test(value.client || '') && (() => {
          try { return value.startTicks === C.processIdentity(value.pid); } catch { return false; }
        })());
      const snapshot = await C.inspectBackend(descriptor);
      const result = { status: 'connected', jobId: descriptor.jobId, hostname: descriptor.hostname,
        backendId: descriptor.id, backendPid: descriptor.pid, connectionPid: receipt.pid,
        threadCount: snapshot.threads.length, activeIds: snapshot.activeIds,
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
      const project = projectFor(value);
      const descriptor = C.validateDescriptor(value, project);
      const chosenComponent = request.component || component;
      if (request.component) {
        const installRoot = path.join(os.homedir(), '.local/share/codex-backend') + path.sep;
        if (!path.resolve(chosenComponent).startsWith(installRoot) || !/^[a-f0-9]{64}$/.test(path.basename(chosenComponent)) ||
            !fs.existsSync(path.join(C.privateDirectory(chosenComponent), 'installed'))) throw new Error('Unmanaged connector component');
      }
      const launcher = C.connectionLauncher(chosenComponent, request.descriptor, root);
      const official = vscode.extensions.getExtension('openai.chatgpt');
      if (official?.packageJSON.version !== C.EXTENSION_VERSION) throw new Error('Official extension version mismatch');
      const selection = path.join(root, 'connections', `${C.hash(hook)}.json`);
      C.writeJson(selection, { descriptor: request.descriptor, project: C.canonical(project), hostname: os.hostname() });
      const reload = configuration.get('cliExecutable') !== launcher || context.workspaceState.get('selectedDescriptor') !== request.descriptor;
      if (reload) {
        if (context.globalState.get('originalCli') === undefined) {
          const original = configuration.inspect('cliExecutable')?.globalValue;
          await context.globalState.update('originalCli', { hadValue: original !== undefined, value: original });
        }
        await context.workspaceState.update('pendingConnection', request);
        await context.workspaceState.update('selectedLauncher', launcher);
        await context.workspaceState.update('selectedDescriptor', request.descriptor);
        await configuration.update('cliExecutable', launcher, vscode.ConfigurationTarget.Global);
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
  const registerTerminal = async terminal => {
    try {
      const pid = await terminal.processId;
      terminals.set(pid, { pid, startTicks: C.processIdentity(pid) });
      const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
      const value = env.find(x => x.startsWith('VSCODE_IPC_HOOK_CLI='))?.slice('VSCODE_IPC_HOOK_CLI='.length);
      if (value) hooks.add(value);
      register();
    } catch { /* Terminal may have exited before registration. */ }
  };
  await Promise.all((vscode.window.terminals || []).map(registerTerminal));
  register();
  if (vscode.window.onDidOpenTerminal) context.subscriptions.push(vscode.window.onDidOpenTerminal(registerTerminal));
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
  context.subscriptions.push(vscode.commands.registerCommand('mdlammps.codexBackend.restore', async () => {
    const original = context.globalState.get('originalCli');
    if (!original) return;
    if (configuration.get('cliExecutable') !== context.workspaceState.get('selectedLauncher')) throw new Error('CLI setting has changed since connection; leaving it intact');
    await configuration.update('cliExecutable', original.hadValue ? original.value : undefined, vscode.ConfigurationTarget.Global);
    await context.globalState.update('originalCli', undefined);
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }));
  const pending = context.workspaceState.get('pendingConnection');
  if (pending) finishConnection(pending);
  return { connect };
}
module.exports = { activate };
