'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

function load(name, execute) {
  const file = path.join(__dirname, '..', name);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require: id => id === 'node:child_process' ? { execFileSync: execute } :
      id === './common.cjs' ? require('../common.cjs') : require(id),
    module, __dirname: path.dirname(file), process: { execPath: process.execPath,
      stdout: { write() {} }, stderr: { write() {} } }, console: { error() {} },
  }, { filename: file });
  return module.exports;
}

test('VS Code 1.100.2 packaging agrees in both manifests and removes old entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-package-'));
  try {
    fs.cpSync(path.join(__dirname, '..', 'helper'), path.join(dir, 'helper'), { recursive: true });
    const packager = load('package-helper.cjs', (bin, args, options) =>
      bin === 'code' ? '1.100.2\ncommit\nx64\n' : execFileSync(bin, args, options));
    const vsix = packager.packageHelper(dir);
    const read = name => execFileSync('unzip', ['-p', vsix, name], { encoding: 'utf8' });
    assert.equal(JSON.parse(read('extension/package.json')).engines.vscode, '^1.95.0');
    assert.match(read('extension.vsixmanifest'), /Code.Engine" Value="\^1.95.0"/);
    assert.match(read('extension.vsixmanifest'), /xmlns="http:\/\/schemas.microsoft.com\/developer\/vsx-schema\/2011"/);
    fs.writeFileSync(path.join(dir, 'obsolete.txt'), 'old entry');
    execFileSync('zip', ['-q', vsix, 'obsolete.txt'], { cwd: dir });
    packager.packageHelper(dir);
    assert.doesNotMatch(execFileSync('unzip', ['-Z1', vsix], { encoding: 'utf8' }), /obsolete/);
    const unsupported = load('package-helper.cjs', () => '1.90.0\n');
    assert.throws(() => unsupported.packageHelper(dir), /Unsupported VS Code/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('connector captures incompatibility, repackages using its Node, and retries once', () => {
  const calls = [];
  const connector = load('connect.cjs', (bin, args, options) => {
    calls.push({ bin, args, options });
    if (calls.length === 1) throw Object.assign(new Error('install failed'), {
      stderr: Buffer.from("not compatible with VS Code '1.100.2'"),
    });
    return 'installed\n';
  });
  connector.installVsix();
  assert.equal(calls.length, 3);
  assert.deepEqual(Array.from(calls[0].options.stdio), ['inherit', 'pipe', 'pipe']);
  assert.equal(calls[1].bin, process.execPath);
  assert.match(calls[1].args[0], /package-helper.cjs$/);
  assert.equal(calls[2].bin, 'code');
});

test('unrelated installation errors are not retried', () => {
  let calls = 0;
  const failure = Object.assign(new Error('permission denied'), { stderr: Buffer.from('EACCES') });
  const connector = load('connect.cjs', () => { calls++; throw failure; });
  assert.throws(() => connector.installVsix(), error => error === failure);
  assert.equal(calls, 1);
});
