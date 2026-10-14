'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

function load(name, execute, overrides = {}) {
  const file = path.join(__dirname, '..', name);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require: id => overrides[id] || (id === 'node:child_process' ? { execFileSync: execute } :
      id === './common.cjs' ? require('../common.cjs') : require(id)),
    module, __dirname: path.dirname(file), process: { execPath: process.execPath,
      stdout: { write() {} }, stderr: { write() {} } }, console: { error() {} },
  }, { filename: file });
  return module.exports;
}

test('packaging preserves the API floor and replaces archives without obsolete entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-package-'));
  try {
    fs.cpSync(path.join(__dirname, '..', 'helper'), path.join(dir, 'helper'), { recursive: true });
    const packager = load('package-helper.cjs', (bin, args, options) => {
      assert.notEqual(bin, 'code', 'build CLI version is not the installation target');
      return execFileSync(bin, args, options);
    });
    const vsix = packager.packageHelper(dir);
    const read = name => execFileSync('unzip', ['-p', vsix, name], { encoding: 'utf8' });
    assert.equal(JSON.parse(read('extension/package.json')).engines.vscode, '^1.95.0');
    assert.match(read('extension.vsixmanifest'), /Code.Engine" Value="\^1.95.0"/);
    assert.match(read('extension.vsixmanifest'), /xmlns="http:\/\/schemas.microsoft.com\/developer\/vsx-schema\/2011"/);
    fs.writeFileSync(path.join(dir, 'obsolete.txt'), 'old entry');
    execFileSync('zip', ['-q', vsix, 'obsolete.txt'], { cwd: dir });
    packager.packageHelper(dir);
    assert.doesNotMatch(execFileSync('unzip', ['-Z1', vsix], { encoding: 'utf8' }), /obsolete/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('connector delegates installation and propagates installer errors unchanged', () => {
  let calls = 0;
  const failure = new Error('installer failure');
  const connector = load('connect.cjs', () => { throw new Error('unexpected direct command'); }, {
    './package-helper.cjs': { installHelper(component) {
      calls++;
      assert.equal(component, path.join(__dirname, '..'));
      if (calls > 1) throw failure;
    } },
  });
  connector.installVsix();
  assert.equal(calls, 1);
  assert.throws(() => connector.installVsix(), error => error === failure);
  assert.equal(calls, 2);
});
