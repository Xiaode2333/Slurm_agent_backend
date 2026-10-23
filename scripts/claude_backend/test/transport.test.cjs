'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const C = require('../common.cjs');
const transport = path.resolve(__dirname, '../transport.cjs');
const diagnostic = "Claude SSH: ENOENT: no such file or directory, open '/proc/1859611/stat'";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-discovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const backends = C.privateDirectory(path.join(dir, 'backends'));
  const descriptor = { schema: 'claude_backend_v1', status: 'ready', hostname: 'worker.example',
    jobId: '123', pid: 1859611, startTicks: '42', socket: '/tmp/backend.sock',
    component: path.dirname(transport), node: process.execPath, project: dir };
  const stale = path.join(backends, 'stale.json'), live = path.join(backends, 'live.json');
  C.writeJson(stale, descriptor);
  C.writeJson(live, { ...descriptor, jobId: '124' });
  // Emulate a retired immutable bridge and a healthy worker without real SSH.
  fs.writeFileSync(path.join(dir, 'ssh'), `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.at(-1).includes('stale.json')) {
  fs.writeSync(2, ${JSON.stringify(diagnostic + '\n')}); process.exit(1);
}
process.stdin.once('data', () => process.stdout.write(JSON.stringify({ op: 'ready', status: 'ready' }) + '\\n'));
`, { mode: 0o700 });
  const run = body => cp.spawnSync(process.execPath, ['-e', `
const C = require(${JSON.stringify(path.resolve(__dirname, '../common.cjs'))});
const T = require(${JSON.stringify(transport)});
C.root = () => ${JSON.stringify(dir)};
(async () => { ${body} })().catch(error => { console.error(error.message); process.exitCode = 1; });
`], { encoding: 'utf8', timeout: 10000, env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH } });
  return { dir, stale, live, run };
}

test('discovery quietly skips an expired remote process and preserves its descriptor', t => {
  const { dir, stale, live, run } = fixture(t);
  const before = fs.readFileSync(stale, 'utf8');
  const result = run(`console.log((await T.select(${JSON.stringify(dir)}, {})).file);`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), live);
  assert.equal(result.stderr, '', 'failed discovery probes must not leak SSH errors');
  assert.equal(fs.readFileSync(stale, 'utf8'), before);
});

test('an explicit failed probe retains the remote diagnostic in its error', t => {
  const { stale, run } = fixture(t);
  const result = run(`try { await T.probe(${JSON.stringify(stale)}); throw new Error('probe unexpectedly succeeded'); }
catch (error) { console.log(error.message); }`);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(diagnostic), result.stdout);
  assert.equal(result.stderr, '');
});

test('session transport still forwards SSH stderr by default', t => {
  const { stale, run } = fixture(t);
  const result = run(`const connection = T.stream(${JSON.stringify(stale)});
await connection.opened; connection.output.resume();
await new Promise(resolve => connection.child.once('close', resolve));`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr.trim(), diagnostic);
});
