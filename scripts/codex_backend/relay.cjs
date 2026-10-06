'use strict';
const fs = require('node:fs');
const os = require('node:os');
const { once } = require('node:events');
const { StringDecoder } = require('node:string_decoder');
const C = require('./common.cjs');

function normalizeRequest(message, project, aliases = [project]) {
  if (!message.method || !message.params || typeof message.params !== 'object') return message;
  const params = { ...message.params };
  if (message.method === 'thread/list' && (!params.sourceKinds || params.sourceKinds.length === 0)) {
    params.sourceKinds = ['cli', 'vscode', 'appServer'];
  }
  if (params.cwd) {
    const normalize = cwd => {
      try {
        if (C.canonical(cwd) !== project) return cwd;
        return message.method === 'thread/list' && aliases.length > 1 ? aliases : project;
      } catch { return cwd; }
    };
    params.cwd = Array.isArray(params.cwd) ? [...new Set(params.cwd.flatMap(normalize))] : normalize(params.cwd);
  }
  return { ...message, params };
}
async function relay({ descriptor, root = C.stateRoot(), input = process.stdin, output = process.stdout,
  hook = process.env.CODEX_BACKEND_DESCRIPTOR_FILE ? `extension-host:${process.ppid}` : process.env.VSCODE_IPC_HOOK_CLI || '' }) {
  const ws = await C.connectSocket(descriptor.socket);
  const receiptFile = C.receiptPath(root, descriptor.socket, hook);
  const requests = new Map();
  const receipt = { backendId: descriptor.id, pid: process.pid, hostname: os.hostname(),
    startTicks: C.processIdentity(process.pid), hook, connected: true, initialized: false, listCompleted: false,
    threadIds: [], resumed: [], notificationCount: 0, at: Date.now() };
  let incoming = '';
  const decoder = new StringDecoder('utf8');
  let outputChain = Promise.resolve();
  let queuedBytes = 0;
  let closed = false;
  let receiptTimer;
  const writeReceipt = () => { receipt.at = Date.now(); C.writeJson(receiptFile, receipt); };
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
          receipt.threadIds = [...new Set([...receipt.threadIds, ...message.result.data.map(t => t.id)])];
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
        if (!receiptTimer) receiptTimer = setTimeout(() => { receiptTimer = undefined; if (!closed) writeReceipt(); }, 500);
      }
      if (request) writeReceipt();
      queuedBytes -= data.length;
      if (queuedBytes < 1024 * 1024 && !closed) ws.resume();
    }).catch(fail);
  });
  const finished = new Promise((resolve, reject) => {
    ws.once('close', (code, reason) => {
      closed = true; input.pause();
      receipt.connected = false; writeReceipt();
      if (!input.readableEnded) input.destroy(code === 1000 ? undefined : new Error(`Backend disconnected: ${code}`));
      code === 1000 ? resolve() : reject(new Error(`Backend connection closed: ${code} ${reason}`));
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
        const message = normalizeRequest(JSON.parse(line), descriptor.project, descriptor.projectAliases);
        if (message.method && message.id !== undefined) requests.set(message.id, message);
        await new Promise((resolve, reject) => ws.send(JSON.stringify(message), error => error ? reject(error) : resolve()));
      }
    }
    incoming += decoder.end();
    if (incoming.trim()) throw new Error('Incomplete final JSONL message');
    await outputChain;
    ws.close(1000); await finished;
  } finally {
    clearTimeout(receiptTimer);
    closed = true; ws.terminate(); receipt.connected = false; writeReceipt();
  }
}
module.exports = { normalizeRequest, relay };
if (require.main === module) {
  (async () => {
    C.checkCli();
    let selected;
    if (process.env.CODEX_BACKEND_DESCRIPTOR_FILE) {
      const descriptor = C.readJson(process.env.CODEX_BACKEND_DESCRIPTOR_FILE);
      selected = { descriptor: C.validateDescriptor(descriptor, descriptor.project) };
    } else {
    const selectionFile = require('node:path').join(C.stateRoot(), 'connections', `${C.hash(process.env.VSCODE_IPC_HOOK_CLI || '')}.json`);
    let selection;
    try { selection = C.readJson(selectionFile); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (selection) {
      selected = { descriptor: C.validateDescriptor(C.readJson(selection.descriptor), selection.project) };
    } else {
      const project = process.env.VSCODE_CWD || process.env.SLURM_SUBMIT_DIR || process.cwd();
      selected = C.selectBackend({ project });
    }
    }
    await relay({ descriptor: selected.descriptor });
  })().catch(error => { process.stderr.write(`codex-backend: ${error.message}\n`); process.exitCode = 1; });
}
