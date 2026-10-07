'use strict';
const fs = require('node:fs');
const os = require('node:os');
const { once } = require('node:events');
const { StringDecoder } = require('node:string_decoder');
const C = require('./common.cjs');

function normalizeRequest(message, project, aliases = [project]) {
  if (!message.method || !message.params || typeof message.params !== 'object') return message;
  const params = { ...message.params };
  // A new thread/one-shot command without cwd must use this client's project,
  // rather than the shared server's startup directory. Resume keeps its thread.
  if (['thread/start', 'command/exec'].includes(message.method) && params.cwd == null) params.cwd = project;
  if (message.method === 'thread/list') {
    if (!params.sourceKinds || params.sourceKinds.length === 0) params.sourceKinds = ['cli', 'vscode', 'appServer'];
    // Default repair scans read shared rollout files. UI pagination should use
    // the continuously maintained index; an explicit false still requests repair.
    if (params.useStateDbOnly === undefined || params.useStateDbOnly === null) params.useStateDbOnly = true;
  }
  if (params.cwd) {
    const normalize = cwd => {
      try {
        if (cwd !== project && C.canonical(cwd) !== project) return cwd;
        return message.method === 'thread/list' && aliases.length > 1 ? aliases : project;
      } catch { return cwd; }
    };
    params.cwd = Array.isArray(params.cwd) ? [...new Set(params.cwd.flatMap(normalize))] : normalize(params.cwd);
  }
  return { ...message, params };
}
async function relay({ descriptor, project = descriptor.project, aliases = descriptor.projectAliases || [project],
  root = C.stateRoot(), input = process.stdin, output = process.stdout,
  hook = process.env.CODEX_BACKEND_RECEIPT_HOOK || (process.env.CODEX_BACKEND_DESCRIPTOR_FILE ? `extension-host:${process.ppid}` : process.env.VSCODE_IPC_HOOK_CLI || '') }) {
  const ws = await C.connectSocket(descriptor.socket);
  const receiptFile = C.receiptPath(root, descriptor.socket, hook);
  const requests = new Map();
  const receipt = { backendId: descriptor.id, backendPid: descriptor.pid, jobId: descriptor.jobId, project,
    pid: process.pid, hostname: os.hostname(),
    startTicks: C.processIdentity(process.pid), hook, connected: true, initialized: false, listCompleted: false,
    threadIds: [], resumed: [], notificationCount: 0, at: Date.now() };
  let incoming = '';
  const decoder = new StringDecoder('utf8');
  let outputChain = Promise.resolve();
  let queuedBytes = 0;
  let closed = false;
  let closeRequested = false;
  let receiptTimer;
  C.privateDirectory(require('node:path').dirname(receiptFile));
  let receiptChain = Promise.resolve();
  let receiptError;
  const writeReceipt = () => {
    receipt.at = Date.now();
    const value = JSON.stringify(receipt);
    receiptChain = receiptChain.then(async () => {
      const temp = `${receiptFile}.${process.pid}.tmp`;
      await fs.promises.writeFile(temp, value, { mode: 0o600 });
      await fs.promises.rename(temp, receiptFile);
    }).catch(error => { receiptError = error; });
  };
  const scheduleReceipt = () => {
    if (!receiptTimer) receiptTimer = setTimeout(() => { receiptTimer = undefined; if (!closed) writeReceipt(); }, 2000);
  };
  const fail = error => { if (!closed) { closed = true; ws.terminate(); input.destroy(error); } };
  ws.on('error', fail);
  ws.on('message', (data, binary) => {
    if (binary) { fail(new Error('Unexpected binary backend frame')); return; }
    queuedBytes += data.length;
    if (queuedBytes >= 1024 * 1024) ws.pause();
    outputChain = outputChain.then(async () => {
      const text = data.toString('utf8');
      const message = JSON.parse(text);
      const request = !message.method && requests.get(message.id);
      if (request) {
        requests.delete(message.id);
        if (request.method === 'initialize' && !message.error) {
          receipt.initialized = true; receipt.client = request.params.clientInfo?.name;
        }
        if (request.method === 'thread/list' && !message.error) {
          receipt.listCompleted = true;
          receipt.threadIds = [...new Set([...receipt.threadIds, ...message.result.data.map(t => t.id)])].slice(-500);
          receipt.activeIds = message.result.data.filter(t => t.status?.type === 'active').map(t => t.id);
          receipt.partial = Boolean(message.result.nextCursor);
        }
        if (request.method === 'thread/resume' && !message.error) {
          receipt.resumed = [...receipt.resumed.slice(-9), { threadId: message.result.thread.id,
            turnIds: (message.result.thread.turns || []).map(t => t.id), status: message.result.thread.status }];
        }
      }
      if (!output.write(text + '\n')) await once(output, 'drain');
      if (message.method && message.params?.threadId) {
        receipt.notificationCount++;
        receipt.lastProgressThreadId = message.params.threadId;
        receipt.lastProgressTurnId = message.params.turnId;
        scheduleReceipt();
      }
      if (request && ['initialize', 'thread/list', 'thread/resume'].includes(request.method)) writeReceipt();
      queuedBytes -= data.length;
      if (queuedBytes < 1024 * 1024 && !closed) ws.resume();
    }).catch(fail);
  });
  const finished = new Promise((resolve, reject) => {
    ws.once('close', (code, reason) => {
      closed = true; input.pause();
      receipt.connected = false; writeReceipt();
      if (!input.readableEnded) input.destroy(code === 1000 ? undefined : new Error(`Backend disconnected: ${code}`));
      code === 1000 || closeRequested ? resolve() : reject(new Error(`Backend connection closed: ${code} ${reason}`));
    });
    input.once('error', reject);
  });
  finished.catch(() => {});
  try {
    for await (const chunk of input) {
      incoming += decoder.write(chunk);
      if (Buffer.byteLength(incoming) > 64 * 1024 * 1024) throw new Error('JSONL input exceeds 64 MiB');
      let newline;
      while ((newline = incoming.indexOf('\n')) !== -1) {
        const line = incoming.slice(0, newline).trim(); incoming = incoming.slice(newline + 1);
        if (!line) continue;
        const message = normalizeRequest(JSON.parse(line), project, aliases);
        if (message.method && message.id !== undefined) requests.set(message.id, message);
        await new Promise((resolve, reject) => ws.send(JSON.stringify(message), error => error ? reject(error) : resolve()));
      }
    }
    incoming += decoder.end();
    if (incoming.trim()) throw new Error('Incomplete final JSONL message');
    await outputChain;
    closeRequested = true; ws.close(1000); await finished;
  } finally {
    clearTimeout(receiptTimer);
    closed = true; ws.terminate(); receipt.connected = false; writeReceipt();
    await receiptChain;
    if (receiptError) throw receiptError;
  }
}
module.exports = { normalizeRequest, relay };
if (require.main === module) {
  (async () => {
    let selected;
    const project = process.env.CODEX_BACKEND_PROJECT || process.env.VSCODE_CWD || process.cwd();
    if (process.env.CODEX_BACKEND_DESCRIPTOR_FILE) {
      const descriptor = C.readJson(process.env.CODEX_BACKEND_DESCRIPTOR_FILE);
      selected = { descriptor: C.validateDescriptor(descriptor, project, os.hostname(), { allowShared: true }) };
    } else {
    const selectionFile = require('node:path').join(C.stateRoot(), 'connections', `${C.hash(process.env.VSCODE_IPC_HOOK_CLI || '')}.json`);
    let selection;
    try { selection = C.readJson(selectionFile); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (selection) {
      selected = { descriptor: C.validateDescriptor(C.readJson(selection.descriptor), selection.project, os.hostname(), { allowShared: true }) };
    } else {
      selected = C.selectBackend({ project });
    }
    }
    const aliasFile = require('node:path').join(C.stateRoot(), 'aliases', `${C.hash(project)}.json`);
    let aliases = [project];
    try { aliases = C.readJson(aliasFile).paths; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await relay({ descriptor: selected.descriptor, project: C.canonical(project), aliases });
  })().catch(error => { process.stderr.write(`codex-backend: ${error.message}\n`); process.exitCode = 1; });
}
