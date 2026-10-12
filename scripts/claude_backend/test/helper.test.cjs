'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const net = require('node:net');
const C = require('../common.cjs');
const { once } = require('node:events');
async function send(socket, request) {
  const c = net.createConnection(socket); c.on('error', () => {}); await once(c, 'connect');
  let result = '';
  return new Promise((resolve, reject) => { c.on('data', b => { result += b; }); c.on('error', reject); c.on('end', () => resolve(JSON.parse(result))); c.end(JSON.stringify(request) + '\n'); });
}
test('helper verifies this window, changes only Claude settings, and restores prior wrapper', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-helper-test-'));
  const root = C.privateDirectory(path.join(base, 'state')), component = path.join(base, 'home/.local/share/claude-backend', 'a'.repeat(64));
  fs.mkdirSync(component, { recursive: true }); fs.chmodSync(path.dirname(component), 0o700); fs.writeFileSync(path.join(component, 'node-path'), process.execPath); fs.writeFileSync(path.join(component, 'installed'), '');
  const project = base, descriptor = path.join(root, 'backends', 'fixture.json');
  C.writeJson(descriptor, { schema: 'claude_backend_v1', status: 'ready', hostname: os.hostname(), jobId: '111', socket: '/tmp/test', component, node: process.execPath });
  const disposables = [], commands = {}, updates = [], settings = { claudeProcessWrapper: '/original/wrapper' }, state = new Map();
  const context = { subscriptions: disposables, workspaceState: { get: k => state.get(k), update: async (k,v) => state.set(k,v) } };
  const api = { env: { sessionId: 'helper-test' }, ConfigurationTarget: { Global: 1 },
    workspace: { isTrusted: true, workspaceFolders: [{ uri: { fsPath: project } }], getConfiguration: name => { assert.equal(name, 'claudeCode'); return { get: k => settings[k], inspect: k => ({ globalValue: settings[k] }), update: async (k,v) => { updates.push([k,v]); settings[k]=v; } }; } },
    extensions: { getExtension: id => { assert.equal(id, 'anthropic.claude-code'); return { packageJSON: { version: '2.3.4', contributes: { configuration: { properties: { 'claudeCode.claudeProcessWrapper': {} } } } } }; } },
    window: { terminals: [], registerUriHandler: () => ({ dispose() {} }), showInformationMessage: () => {} },
    commands: { registerCommand: (name, fn) => { commands[name]=fn; return { dispose() {} }; } } };
  const fakeC = { ...C, root: () => root };
  const module = { exports: {} };
  const code = fs.readFileSync(path.join(__dirname, '../helper/extension.cjs'), 'utf8');
  vm.runInNewContext(code, { require: name => name === 'node:os' ? { ...os, homedir: () => path.join(base, 'home') } : name === './runtime.json' ? { component } : name === path.join(component, 'common.cjs') ? fakeC : name === path.join(component, 'transport.cjs') ? { probe: async () => ({ status: 'ready' }) } : require(name), process, module, console, Buffer });
  t.after(() => { for (const d of disposables) d.dispose(); fs.rmSync(base, { recursive: true, force: true }); });
  await module.exports.activate(context, api);
  const helper = C.readJson(path.join(root, 'helpers', C.hash('helper-test') + '.json'));
  let response = await send(helper.socket, { action: 'connect', descriptor, component, project }); assert.equal(response.status, 'configured', response.error);
  assert.match(settings.claudeProcessWrapper, /launcher.sh$/); assert.equal(updates.length, 1);
  response = await send(helper.socket, { action: 'status' }); assert.equal(response.verified, false);
  const record = { backend: descriptor, connected: true, hostname: os.hostname(), windowPid: process.pid + 1, wrapperPid: process.pid, wrapperStartTicks: C.processIdentity(process.pid), entrypoint: 'claude-vscode' };
  C.writeJson(path.join(root, 'receipts', 'test.json'), record);
  response = await send(helper.socket, { action: 'status' }); assert.equal(response.verified, false, 'another window is not proof');
  C.writeJson(path.join(root, 'receipts', 'test.json'), { ...record, windowPid: process.pid });
  response = await send(helper.socket, { action: 'status' }); assert.equal(response.verified, true);
  const outside = path.join(base, 'other'); fs.mkdirSync(outside);
  response = await send(helper.socket, { action: 'connect', descriptor, component, project: outside }); assert.equal(response.status, 'failed');
  response = await send(helper.socket, { action: 'restore' }); assert.equal(response.status, 'local'); assert.equal(settings.claudeProcessWrapper, '/original/wrapper');
});
