'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-vscode-compat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const component = path.join(root, 'component');
  fs.mkdirSync(path.join(component, 'helper'), { recursive: true });
  for (const name of ['package-helper.cjs', 'helper/package.json', 'helper/extension.cjs']) {
    fs.copyFileSync(path.join(__dirname, '..', name), path.join(component, name));
  }
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(root, 'calls.jsonl');
  fs.writeFileSync(path.join(bin, 'code'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const log = process.env.FAKE_CODE_LOG;
const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\\n').length : 0;
fs.appendFileSync(log, JSON.stringify(args) + '\\n');
if (args[0] === '--version') { console.log(process.env.FAKE_CODE_VERSION || '1.140.0'); process.exit(0); }
const mode = process.env.FAKE_CODE_FAILURE;
if (mode === 'always' || mode === 'old' || (mode === 'once' && calls === 0)) {
  console.error("Error: Unable to install extension 'mdlammps.codex-backend' as it is not compatible with VS Code '" + (mode === 'old' ? '1.90.0' : '1.100.2') + "'.");
  process.exit(1);
}
if (mode === 'network') { console.error('Network unavailable'); process.exit(1); }
console.log('Connector installed');
`, { mode: 0o700 });
  return { root, component, log, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_CODE_LOG: log },
    calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}
function run(f, failure) {
  return cp.spawnSync(process.execPath, ['-e', 'require(process.argv[1]).installHelper(process.argv[2])',
    path.join(f.component, 'package-helper.cjs'), f.component], {
    encoding: 'utf8', timeout: 10000, env: { ...f.env, FAKE_CODE_FAILURE: failure },
  });
}

test('headless and newer-client builds retain the real API floor in both VSIX manifests', t => {
  const f = fixture(t);
  const floor = JSON.parse(fs.readFileSync(path.join(f.component, 'helper/package.json'))).engines.vscode;
  for (const version of ['1.100.2', '1.140.0', '2.0.0']) {
    const result = cp.spawnSync(process.execPath, [path.join(f.component, 'package-helper.cjs'), f.component], {
      encoding: 'utf8', timeout: 10000, env: { ...f.env, FAKE_CODE_VERSION: version },
    });
    assert.equal(result.status, 0, result.stderr);
    const vsix = path.join(f.component, 'codex-backend.vsix');
    const manifest = JSON.parse(cp.execFileSync('unzip', ['-p', vsix, 'extension/package.json'], { encoding: 'utf8' }));
    const xml = cp.execFileSync('unzip', ['-p', vsix, 'extension.vsixmanifest'], { encoding: 'utf8' });
    assert.equal(manifest.engines.vscode, floor);
    assert.ok(xml.includes(`Id="Microsoft.VisualStudio.Code.Engine" Value="${floor}"`));
    assert.ok(xml.includes('http://schemas.microsoft.com/developer/vsx-schema/2011'));
  }
  assert.deepEqual(f.calls(), [], 'packaging must not confuse a local CLI with the remote installation target');
  assert.deepEqual(fs.readdirSync(f.component).filter(name => name.startsWith('.vsix-')), []);
});

test('captured remote installer mismatch rebuilds stale VSIX and retries exactly once', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.component, 'codex-backend.vsix'), 'stale incompatible package');
  const result = run(f, 'once');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /not compatible with VS Code '1.100.2'/);
  assert.match(result.stderr, /repackaging/i);
  assert.match(result.stdout, /Connector installed/);
  assert.equal(f.calls().length, 2);
  assert.ok(f.calls().every(args => args[0] === '--install-extension' && args[2] === '--force'));
  const manifest = JSON.parse(cp.execFileSync('unzip', ['-p', path.join(f.component, 'codex-backend.vsix'), 'extension/package.json']));
  assert.equal(manifest.engines.vscode, '^1.95.0');
});

for (const [mode, attempts, diagnostic] of [
  ['always', 2, /not compatible with VS Code/],
  ['network', 1, /Network unavailable/],
  ['old', 1, /requires VS Code.*1\.95\.0.*update/i],
]) test(`installer ${mode} failure is bounded and never reported as connected`, t => {
  const f = fixture(t);
  const result = run(f, mode);
  assert.notEqual(result.status, 0);
  assert.equal(f.calls().length, attempts);
  assert.match(result.stderr, diagnostic);
  assert.doesNotMatch(result.stdout, /CONNECTED|Connector installed/);
});

test('Claude helper retains its own identity through the shared atomic packager', t => {
  const f = fixture(t);
  const claude = path.join(__dirname, '../../claude_backend');
  fs.mkdirSync(path.join(f.component, 'codex'));
  fs.copyFileSync(path.join(f.component, 'package-helper.cjs'), path.join(f.component, 'codex/package-helper.cjs'));
  for (const name of ['package-helper.cjs', 'helper/package.json', 'helper/extension.cjs']) {
    fs.copyFileSync(path.join(claude, name), path.join(f.component, name));
  }
  const result = cp.spawnSync(process.execPath, [path.join(f.component, 'package-helper.cjs'), f.component], {
    encoding: 'utf8', timeout: 10000, env: f.env,
  });
  assert.equal(result.status, 0, result.stderr);
  const vsix = path.join(f.component, 'claude-backend.vsix');
  const manifest = JSON.parse(cp.execFileSync('unzip', ['-p', vsix, 'extension/package.json']));
  const xml = cp.execFileSync('unzip', ['-p', vsix, 'extension.vsixmanifest'], { encoding: 'utf8' });
  assert.equal(manifest.name, 'claude-backend');
  assert.equal(manifest.publisher, 'slurm-agent');
  assert.equal(manifest.engines.vscode, '^1.95.0');
  assert.match(xml, /Id="claude-backend".*Publisher="slurm-agent"/);
  assert.match(xml, /official Claude Code extension&apos;s CLI/);
  assert.equal(fs.existsSync(path.join(f.component, 'codex-backend.vsix')), false);
  assert.deepEqual(f.calls(), []);
});

test('concurrent packaging leaves a complete archive without staging directories', async t => {
  const f = fixture(t);
  const execute = require('node:util').promisify(cp.execFile);
  await Promise.all(Array.from({ length: 4 }, () => execute(process.execPath,
    [path.join(f.component, 'package-helper.cjs'), f.component], { env: f.env, timeout: 10000 })));
  const archive = path.join(f.component, 'codex-backend.vsix');
  cp.execFileSync('unzip', ['-t', archive]);
  assert.deepEqual(fs.readdirSync(f.component).filter(name => name.startsWith('.vsix-')), []);
});

test('successful installation does not rebuild or query CLI versions', t => {
  const f = fixture(t);
  const result = run(f, 'none');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.calls().length, 1);
  assert.equal(fs.existsSync(path.join(f.component, 'codex-backend.vsix')), false);
});
