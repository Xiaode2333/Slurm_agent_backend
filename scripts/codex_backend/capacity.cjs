'use strict';
// Detect root Codex turns that ended with "model at capacity" and resume them
// on the same thread with its own model. Used by a supervising agent:
//   capacity.cjs watch [--timeout S] [--since ISO]   -> exits on one event
//   capacity.cjs resume THREAD_ID [--delay S] [--descriptor FILE] [--text T]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CAPACITY = new Set(['server_overloaded']);
const sessionsRoot = (env = process.env) => path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
const DEFAULT_TEXT = '上一轮因 "Selected model is at capacity" 中断（由监控 agent 自动重试，未更换模型）。请从中断处继续当前任务。';

function isCapacityFailure(record) {
  const p = record && record.type === 'event_msg' && record.payload;
  if (!p || p.type !== 'task_complete' || !p.error) return false;
  return CAPACITY.has(p.error.codex_error_info) || /at capacity/i.test(p.error.message || '');
}
function sessionMeta(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(256 * 1024), n = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, n).toString('utf8').split('\n')[0];
    const record = JSON.parse(line);
    return record.type === 'session_meta' ? record.payload : null;
  } catch { return null; } finally { fs.closeSync(fd); }
}
const isRoot = meta => Boolean(meta) && meta.thread_source === 'user' && !(meta.source && typeof meta.source === 'object' && meta.source.subagent);
function readRange(file, start, end) {
  const fd = fs.openSync(file, 'r');
  try { const buffer = Buffer.alloc(end - start); fs.readSync(fd, buffer, 0, buffer.length, start); return buffer; } finally { fs.closeSync(fd); }
}
// The last task_complete within a bounded tail decides whether a thread still
// needs intervention (a later successful turn or user retry clears it).
function lastTurnOutcome(file, tailBytes = 8 * 1024 * 1024) {
  const size = fs.statSync(file).size, start = Math.max(0, size - tailBytes);
  const lines = readRange(file, start, size).toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/task_complete|task_started|turn_started|turn_aborted/.test(lines[i])) continue;
    try {
      const r = JSON.parse(lines[i]);
      if (r.type !== 'event_msg') continue;
      // A user interruption is deliberate and never retried.
      if (r.payload.type === 'turn_aborted') return { complete: true, capacity: false, aborted: true, turnId: r.payload.turn_id, at: r.timestamp };
      if (r.payload.type === 'task_complete') return { complete: true, capacity: isCapacityFailure(r), turnId: r.payload.turn_id, at: r.timestamp };
      if (/^(task|turn)_started$/.test(r.payload.type)) return { complete: false, turnId: r.payload.turn_id, at: r.timestamp };
    } catch { /* Partial first line of the tail. */ }
  }
  return null;
}
function recentFiles(root, horizonMs) {
  const out = [];
  const now = Date.now();
  for (let d = 0; d <= Math.ceil(horizonMs / 86400000) + 1; d++) {
    const day = new Date(now - d * 86400000);
    const dir = path.join(root, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try { if (now - fs.statSync(file).mtimeMs <= horizonMs) out.push(file); } catch { /* Raced rename. */ }
    }
  }
  return out;
}
async function watch({ timeout = 7200, since, interval = 5, horizon = 172800, root = sessionsRoot(), log = console.log } = {}) {
  const started = Date.now(), sinceMs = since ? Date.parse(since) : null;
  const tracked = new Map(); // file -> { offset, rest, root, thread }
  const track = (file, fromStart) => {
    const meta = sessionMeta(file);
    const size = fs.statSync(file).size;
    // With --since, replay a bounded tail so an event during a handoff gap is not lost.
    const offset = fromStart ? 0 : (sinceMs ? Math.max(0, size - 4 * 1024 * 1024) : size);
    tracked.set(file, { offset, rest: '', root: isRoot(meta), thread: meta && meta.id });
  };
  for (const file of recentFiles(root, horizon * 1000)) track(file, false);
  for (;;) {
    for (const file of recentFiles(root, horizon * 1000)) if (!tracked.has(file)) track(file, true);
    for (const [file, t] of tracked) {
      if (!t.root) continue;
      let size;
      try { size = fs.statSync(file).size; } catch { tracked.delete(file); continue; }
      if (size < t.offset) { t.offset = 0; t.rest = ''; }
      if (size === t.offset) continue;
      const text = t.rest + readRange(file, t.offset, size).toString('utf8');
      t.offset = size;
      const lines = text.split('\n'); t.rest = lines.pop();
      for (const line of lines) {
        if (!line.includes('task_complete')) continue;
        let record; try { record = JSON.parse(line); } catch { continue; }
        if (!isCapacityFailure(record)) continue;
        if (sinceMs && Date.parse(record.timestamp) <= sinceMs) continue;
        log(`status=EVENT thread=${t.thread} turn=${record.payload.turn_id} at=${record.timestamp} file=${file} message=${JSON.stringify(record.payload.error.message)}`);
        return 0;
      }
    }
    if (Date.now() - started >= timeout * 1000) { log(`status=TIMEOUT elapsed=${Math.round((Date.now() - started) / 1000)}s tracked=${tracked.size}`); return 3; }
    await new Promise(resolve => setTimeout(resolve, interval * 1000));
  }
}
function defaultDescriptor(env = process.env) {
  const dir = path.join(os.homedir(), '.local/state/codex-backend/backends');
  if (env.CODEX_BACKEND_DESCRIPTOR) return env.CODEX_BACKEND_DESCRIPTOR;
  if (env.SLURM_JOB_ID) return path.join(dir, `${os.hostname()}-${env.SLURM_JOB_ID}.json`);
  throw new Error('Set --descriptor or CODEX_BACKEND_DESCRIPTOR');
}
function findRollout(threadId, root = sessionsRoot()) {
  for (const file of recentFiles(root, 30 * 86400000)) if (file.endsWith(`${threadId}.jsonl`)) return file;
  throw new Error(`No recent rollout for thread ${threadId}`);
}
async function resume(threadId, { delay = 0, descriptor = defaultDescriptor(), text = DEFAULT_TEXT, log = console.log } = {}) {
  const C = require('./common.cjs');
  if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay * 1000));
  const file = findRollout(threadId), meta = sessionMeta(file);
  if (!isRoot(meta)) { log(`status=SKIP reason=not_root thread=${threadId}`); return 0; }
  const outcome = lastTurnOutcome(file);
  if (!outcome || !outcome.complete || !outcome.capacity) { log(`status=SKIP reason=${outcome && !outcome.complete ? 'turn_running' : 'no_pending_capacity_failure'} thread=${threadId}`); return 0; }
  const d = C.readJson(descriptor);
  if (d.hostname !== os.hostname()) throw new Error(`Backend runs on ${d.hostname}; run this on that node`);
  const client = await C.rpcClient(d.socket, { timeout: 120000 });
  try {
    const before = (await client.request('thread/read', { threadId, includeTurns: false })).thread;
    if (before.status && before.status.type === 'active') { log(`status=SKIP reason=thread_active thread=${threadId}`); return 0; }
    // No model/config override: the thread keeps its recorded model and settings.
    const resumed = await client.request('thread/resume', { threadId, excludeTurns: true });
    const model = (resumed.thread && resumed.thread.model) || resumed.model || before.model;
    const turn = await client.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
    log(`status=RESUMED thread=${threadId} failed_turn=${outcome.turnId} new_turn=${turn.turn && turn.turn.id} model=${model}`);
    return 0;
  } finally { client.close(); }
}
function option(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}
module.exports = { isCapacityFailure, isRoot, sessionMeta, lastTurnOutcome, watch, resume };
if (require.main === module) {
  const [command, ...args] = process.argv.slice(2);
  const run = command === 'watch'
    ? watch({ timeout: Number(option(args, '--timeout', 7200)), since: option(args, '--since'), interval: Number(option(args, '--interval', 5)) })
    : command === 'resume'
      ? resume(args[0], { delay: Number(option(args, '--delay', 0)), descriptor: option(args, '--descriptor', process.env.CODEX_BACKEND_DESCRIPTOR || undefined) || defaultDescriptor(), text: option(args, '--text', DEFAULT_TEXT) })
      : Promise.reject(new Error('Usage: capacity.cjs watch|resume THREAD_ID'));
  run.then(code => { process.exitCode = code; }).catch(error => { console.log(`status=FATAL error=${JSON.stringify(error.message)}`); process.exitCode = 4; });
}
