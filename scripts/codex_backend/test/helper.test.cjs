'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const C = require('../common.cjs');

test('connector restores bindings before the official extension starts its CLI', () => {
  const manifest = require('../helper/package.json');
  assert.ok(manifest.activationEvents.includes('*'));
  assert.equal(manifest.extensionDependencies, undefined);
});

for (const openedProject of [true, false]) test(`helper connects ${openedProject ? 'project' : 'Welcome terminal'} window, reloads once and unbinds only this window`, async t => {
  const originalHook = process.env.VSCODE_IPC_HOOK_CLI;
  t.after(() => { if (originalHook === undefined) delete process.env.VSCODE_IPC_HOOK_CLI; else process.env.VSCODE_IPC_HOOK_CLI = originalHook; });
  process.env.VSCODE_IPC_HOOK_CLI = 'host-hook-before-reload';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-helper-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const net = require('node:net'); const socket = path.join(root, 'backend.sock');
  const server = net.createServer(); await new Promise(resolve => server.listen(socket, resolve)); fs.chmodSync(socket, 0o600);
  t.after(() => server.close());
  const serverProject = path.join(root, 'server-project'); fs.mkdirSync(serverProject);
  const descriptor = { schema: 'codex_backend_v1', status: 'ready', id: 'existing', project: serverProject, socket,
    cli: C.CLI, version: C.CLI_VERSION, hostname: os.hostname(), jobId: '42', pid: process.pid, startTicks: C.processIdentity(process.pid) };
  const descriptorFile = path.join(root, 'backends', 'backend.json'); C.writeJson(descriptorFile, descriptor);
  const component = path.resolve(__dirname, '..');
  const localC = { ...C, stateRoot: () => root, dispatcherLauncher: () => path.join(root, 'dispatcher.sh') };
  const moduleObject = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(component, 'helper/extension.cjs'), 'utf8'), {
    require(name) {
      if (name === './runtime.json') return { component };
      if (name === path.join(component, 'common.cjs')) return localC;
      return require(name);
    }, module: moduleObject, process, console, setImmediate,
  });
  const global = new Map(), workspace = new Map(), settings = new Map([['cliExecutable', '/original/codex'], ['unrelated', 'keep']]);
  const commands = [], registered = new Map(), updates = [];
  const terminalListeners = new Set();
  const activeTerminalListeners = new Set();
  const shellIntegrationListeners = new Set();
  const terminalProcess = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    env: { ...process.env, VSCODE_IPC_HOOK_CLI: 'distinct-terminal-hook' }, stdio: 'ignore', cwd: root,
  });
  t.after(() => terminalProcess.kill());
  const state = map => ({ get: key => map.get(key), async update(key, value) { value === undefined ? map.delete(key) : map.set(key, value); } });
  const context = () => ({ globalState: state(global), workspaceState: state(workspace), subscriptions: [] });
  const api = {
    env: { sessionId: 'test-window' }, ConfigurationTarget: { Global: 1 },
    workspace: { workspaceFolders: openedProject ? [{ uri: { fsPath: root } }] : undefined, getConfiguration() { return {
      get: key => settings.get(key), inspect: key => ({ globalValue: settings.get(key) }),
      async update(key, value, target) { updates.push({ key, value, target }); settings.set(key, value); },
    }; } },
    extensions: { getExtension: () => ({ packageJSON: { version: C.EXTENSION_VERSION }, async activate() {} }) },
    window: { terminals: [{ processId: Promise.resolve(terminalProcess.pid) }], showInformationMessage() {}, registerUriHandler() { return { dispose() {} }; },
      onDidOpenTerminal(callback) { terminalListeners.add(callback); return { dispose() { terminalListeners.delete(callback); } }; },
      onDidChangeActiveTerminal(callback) { activeTerminalListeners.add(callback); return { dispose() { activeTerminalListeners.delete(callback); } }; },
      onDidChangeTerminalShellIntegration(callback) { shellIntegrationListeners.add(callback); return { dispose() { shellIntegrationListeners.delete(callback); } }; } },
    commands: { async executeCommand(command) { commands.push(command); }, registerCommand(name, callback) { registered.set(name, callback); return { dispose() {} }; } },
  };
  const first = context(); const connector = await moduleObject.exports.activate(first, api);
  assert.deepEqual(C.readJson(path.join(root, 'helpers', C.hash('test-window') + '.json')).hooks, ['distinct-terminal-hook']);
  t.after(() => first.subscriptions.forEach(item => item.dispose()));
  const request = { requestId: crypto.randomUUID(), descriptor: descriptorFile, project: root };
  const response = await connector.connect(request); assert.equal(response.status, 'reloading'); await response.afterReply();
  assert.equal(settings.get('unrelated'), 'keep'); assert.equal(updates.length, 1);
  assert.deepEqual({ ...global.get('originalCli') }, { hadValue: true, value: '/original/codex' });
  assert.equal(commands.filter(c => c === 'workbench.action.reloadWindow').length, 1);
  C.writeJson(C.receiptPath(root, socket, `extension-host:${process.pid}`), {
    backendId: 'existing', backendPid: process.pid, connected: true, initialized: true, listCompleted: true, client: 'VS Code', pid: process.pid, startTicks: C.processIdentity(process.pid), project: root, threadIds: ['running', 'done'], activeIds: ['running'],
  });
  process.env.VSCODE_IPC_HOOK_CLI = 'host-hook-after-reload';
  settings.set('cliExecutable', '/legacy/bound-launcher'); // Old helper's pending reload.
  api.env.sessionId = 'test-window-after-reload';
  const terminal = api.window.terminals[0];
  if (!openedProject) api.window.terminals = []; // Restoration can lag extension activation.
  const second = context(); const restoredConnector = await moduleObject.exports.activate(second, api);
  assert.equal(settings.get('cliExecutable'), path.join(root, 'dispatcher.sh'));
  assert.equal(updates.length, 2);
  const claim = path.join(root, 'helpers', C.hash('terminal:distinct-terminal-hook') + '.json');
  const processClaim = path.join(root, 'helpers', C.hash(`terminal-process:${terminalProcess.pid}:${C.processIdentity(terminalProcess.pid)}`) + '.json');
  if (openedProject) {
    assert.equal(C.readJson(claim).sessionId, 'test-window-after-reload');
    assert.equal(C.readJson(processClaim).sessionId, 'test-window-after-reload');
  }
  first.subscriptions.forEach(item => item.dispose()); first.subscriptions = [];
  if (openedProject) {
    assert.equal(C.readJson(claim).sessionId, 'test-window-after-reload');
    assert.equal(C.readJson(processClaim).sessionId, 'test-window-after-reload');
  }
  t.after(() => second.subscriptions.forEach(item => item.dispose()));
  const result = await C.waitForFile(path.join(root, 'results', request.requestId + '.json'), value => value.status === 'connected', 3000);
  assert.deepEqual(result.activeIds, ['running']); assert.equal(workspace.has('pendingConnection'), false);
  if (!openedProject) {
    api.window.terminals = [terminal];
    await Promise.all([...terminalListeners].map(callback => callback(terminal)));
  }
  const repeat = { requestId: crypto.randomUUID(), descriptor: descriptorFile, project: root };
  assert.equal((await restoredConnector.connect(repeat)).status, 'verifying');
  await C.waitForFile(path.join(root, 'results', repeat.requestId + '.json'), value => value.status === 'connected', 3000);
  assert.equal(commands.filter(c => c === 'workbench.action.reloadWindow').length, 1);
  assert.equal(restoredConnector.connectionStatus().mode, 'slurm');
  assert.equal(restoredConnector.connectionStatus().project, root);
  // The same Terminal object is reused, but its bootstrap shell/PID/hook died.
  // There is deliberately no onDidOpenTerminal event for the replacement.
  const replacement = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    env: { ...process.env, VSCODE_IPC_HOOK_CLI: 'respawned-terminal-hook' }, stdio: 'ignore', cwd: root,
  });
  t.after(() => replacement.kill());
  terminal.processId = Promise.resolve(replacement.pid);
  await require('../connect.cjs').refreshHelpers(root, root);
  assert.equal(require('../connect.cjs').findHelper(root, 'respawned-terminal-hook', root).sessionId, 'test-window-after-reload');
  await Promise.all([...activeTerminalListeners].map(callback => callback(terminal)));
  await Promise.all([...shellIntegrationListeners].map(callback => callback({ terminal })));
  const owner = require('../connect.cjs').findHelper(root, 'respawned-terminal-hook', root);
  assert.equal(owner.sessionId, 'test-window-after-reload');
  assert.ok(owner.terminals.some(t => t.pid === replacement.pid));
  assert.ok(!owner.terminals.some(t => t.pid === terminalProcess.pid));
  await registered.get('mdlammps.codexBackend.restore')();
  assert.equal(settings.get('cliExecutable'), path.join(root, 'dispatcher.sh'));
  assert.equal(C.readJson(path.join(root, 'results', repeat.requestId + '.json')).status, 'connected');
  assert.equal(restoredConnector.connectionStatus().mode, 'local'); assert.equal(settings.get('unrelated'), 'keep');
});
