'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const K = require('../capacity.cjs');
const cap = (turn, at = new Date().toISOString()) => JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, error: { message: 'Selected model is at capacity. Please try a different model.', codex_error_info: 'server_overloaded' } } }) + '\n';
function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = new Date(), day = path.join(dir, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  fs.mkdirSync(day, { recursive: true });
  const write = (id, meta) => { const f = path.join(day, `rollout-x-${id}.jsonl`); fs.writeFileSync(f, JSON.stringify({ type: 'session_meta', payload: { id, ...meta } }) + '\n'); return f; };
  return { root: path.join(dir, 'sessions'), write };
}
test('only root threads with a capacity task_complete need intervention', t => {
  const h = home(t);
  const root = h.write('r', { thread_source: 'user', source: 'vscode' }), sub = h.write('s', { thread_source: 'subagent', source: { subagent: {} } });
  assert.equal(K.isRoot(K.sessionMeta(root)), true); assert.equal(K.isRoot(K.sessionMeta(sub)), false);
  fs.appendFileSync(root, cap('t1'));
  assert.deepEqual({ ...K.lastTurnOutcome(root), at: undefined }, { complete: true, capacity: true, turnId: 't1', at: undefined });
  fs.appendFileSync(root, JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't2' } }) + '\n');
  assert.equal(K.lastTurnOutcome(root).complete, false);
  fs.appendFileSync(root, JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 't2' } }) + '\n');
  assert.equal(K.lastTurnOutcome(root).capacity, false);
  assert.equal(K.isCapacityFailure({ type: 'event_msg', payload: { type: 'task_complete', error: { message: 'other', codex_error_info: 'other' } } }), false);
});
test('watch ignores existing history and subagents, then reports a new root failure', async t => {
  const h = home(t);
  const root = h.write('r', { thread_source: 'user' }), sub = h.write('s', { thread_source: 'subagent', source: { subagent: {} } });
  fs.appendFileSync(root, cap('old', '2020-01-01T00:00:00Z'));
  const lines = [];
  setTimeout(() => fs.appendFileSync(sub, cap('sub')), 200);
  setTimeout(() => fs.appendFileSync(root, cap('new')), 600);
  assert.equal(await K.watch({ root: h.root, timeout: 10, interval: 0.1, log: l => lines.push(l) }), 0);
  assert.match(lines[0], /^status=EVENT thread=r turn=new /);
  assert.equal(await K.watch({ root: h.root, timeout: 0.3, interval: 0.1, log: l => lines.push(l) }), 3);
  assert.match(lines[1], /^status=TIMEOUT/);
  assert.equal(await K.watch({ root: h.root, timeout: 5, interval: 0.1, since: '2021-01-01T00:00:00Z', log: l => lines.push(l) }), 0);
  assert.match(lines[2], /turn=new/);
});
