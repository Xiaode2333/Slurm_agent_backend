'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { performance } = require('node:perf_hooks');
const C = require('./common.cjs');
const { relay } = require('./relay.cjs');
const { consumeJsonl } = require('./jsonl.cjs');

async function clientThroughRelay(descriptor, project, root, implementation = relay) {
  const input = new PassThrough(), output = new PassThrough(), pending = new Map(); let id = 0;
  consumeJsonl(output, message => {
    const entry = pending.get(message.id); if (!entry || message.method) return;
    clearTimeout(entry.timer); pending.delete(message.id);
    message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
  }, error => { for (const entry of pending.values()) entry.reject(error); });
  const lifetime = implementation({ descriptor, project, root, input, output, hook: `benchmark:${process.pid}:${Math.random()}` });
  lifetime.catch(() => {});
  const request = (method, params) => new Promise((resolve, reject) => {
    const key = ++id; const timer = setTimeout(() => { pending.delete(key); reject(new Error(`timeout: ${method}`)); }, 20000);
    pending.set(key, { resolve, reject, timer }); input.write(JSON.stringify({ id: key, method, params }) + '\n');
  });
  await request('initialize', { clientInfo: { name: 'slurm_backend_benchmark', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  input.write(JSON.stringify({ method: 'initialized' }) + '\n');
  return { request, async close() { input.end(); try { await lifetime; } catch (error) { if (!/Backend connection closed: 1006/.test(error.message)) throw error; } output.end(); } };
}
async function measure(descriptor, project, outputDir, { repetitions = 8, concurrency = 4, implementation = relay, label = 'relay' } = {}) {
  fs.mkdirSync(outputDir, { recursive: true });
  const root = C.privateDirectory(path.join(outputDir, 'private-receipts'));
  const rows = [];
  for (const transport of ['direct', label]) {
    const clients = await Promise.all(Array.from({ length: concurrency }, () => transport === 'direct' ? C.rpcClient(descriptor.socket) : clientThroughRelay(descriptor, project, root, implementation)));
    try {
      await Promise.all(clients.map(async (client, index) => {
        for (let repeat = 0; repeat < repetitions; repeat++) {
          const start = performance.now();
          try {
            await client.request('thread/list', { cwd: project, limit: 20, useStateDbOnly: true, sourceKinds: ['cli', 'vscode', 'appServer'] });
            rows.push({ transport, client: index, repeat, ms: performance.now() - start, status: 'ok' });
          } catch (error) { rows.push({ transport, client: index, repeat, ms: performance.now() - start, status: 'error' }); }
        }
      }));
    } finally { await Promise.all(clients.map(client => client.close())); }
  }
  const summary = {};
  for (const transport of ['direct', label]) {
    const values = rows.filter(r => r.transport === transport), times = values.map(r => r.ms).sort((a, b) => a - b);
    summary[transport] = { requests: values.length, errors: values.filter(r => r.status !== 'ok').length,
      p50Ms: times[Math.floor(times.length * 0.5)], p95Ms: times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] };
  }
  fs.writeFileSync(path.join(outputDir, `${label}.csv`), 'transport,client,repeat,ms,status\n' + rows.map(r => `${r.transport},${r.client},${r.repeat},${r.ms.toFixed(3)},${r.status}`).join('\n') + '\n');
  fs.writeFileSync(path.join(outputDir, `${label}.json`), JSON.stringify({ concurrency, repetitions, summary }, null, 2) + '\n');
  return summary;
}
module.exports = { clientThroughRelay, measure };
if (require.main === module) {
  const project = C.canonical(process.argv[2] || process.cwd());
  const selected = C.selectBackend({ project });
  measure(selected.descriptor, project, process.argv[3] || 'tmp/benchmarks').then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
