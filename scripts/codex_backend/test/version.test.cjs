'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');

test('CLI upgrades are detected without a release pin; malformed versions fail', t => {
  let output = 'codex-cli 0.162.1\n';
  t.mock.method(cp, 'execFileSync', (_file, args, options) => {
    assert.deepEqual(args, ['--version']);
    assert.equal(options.timeout, 120000);
    return output;
  });
  const C = require('../common.cjs');
  assert.equal(C.checkCli(), '0.162.1');
  output = 'codex-cli 0.200.0-alpha.2\n';
  assert.equal(C.checkCli(), '0.200.0-alpha.2');
  assert.equal(C.CLI_VERSION, '0.200.0-alpha.2');
  output = 'codex-cli incompatible\n';
  assert.throws(() => C.checkCli(), /Unsupported CLI/);
});

test('explicit optional version pin is enforced without restoring default release pins', t => {
  const config = require('../cli-config.cjs');
  const commonPath = require.resolve('../common.cjs');
  const original = require.cache[commonPath];
  t.after(() => { require.cache[commonPath] = original; });
  t.mock.method(config, 'cliConfig', () => ({ cli: '/fixture/codex', version: '0.162.1' }));
  let output = 'codex-cli 0.162.1\n';
  t.mock.method(cp, 'execFileSync', () => output);
  delete require.cache[commonPath];
  const pinned = require('../common.cjs');
  assert.equal(pinned.checkCli(), '0.162.1');
  output = 'codex-cli 0.200.0\n';
  assert.throws(() => pinned.checkCli(), /CLI version mismatch/);
});

test('handshake parses exact versions, not prefix matches', () => {
  const C = require('../common.cjs');
  assert.equal(C.handshakeVersion('codex_vscode/0.162.1 (Linux; x86_64)'), '0.162.1');
  assert.throws(() => C.handshakeVersion('unrecognized'), /handshake/);
  assert.equal(C.isCliVersion('0.162.1'), true);
  assert.equal(C.isCliVersion('incompatible'), false);
});
