'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cliConfig } = require('../cli-config.cjs');

test('Bouchet retains the npm CLI and Grace selects standalone without filesystem probing', () => {
  assert.deepEqual(cliConfig({ env: {}, host: 'bouchet-node', home: '/home/test' }), {
    cli: '/home/test/.npm-global/bin/codex', version: '0.160.1', cluster: 'bouchet',
  });
  assert.deepEqual(cliConfig({ env: {}, host: 'r917u13n01.grace.ycrc.yale.edu', home: '/home/test' }), {
    cli: '/home/test/.local/bin/codex', version: '0.161.0', cluster: 'grace',
  });
});
test('explicit cluster works on short hostnames and path/version overrides remain validated', () => {
  assert.equal(cliConfig({ env: { CODEX_BACKEND_CLUSTER: 'grace' }, host: 'r917u13n01' }).version, '0.161.0');
  assert.equal(cliConfig({ env: { CODEX_BACKEND_CLUSTER: 'bouchet' }, host: 'node.grace.ycrc.yale.edu' }).version, '0.160.1');
  const config = cliConfig({ env: { CODEX_BACKEND_CLI: '/opt/codex', CODEX_BACKEND_CLI_VERSION: '0.161.0' } });
  assert.equal(config.cli, '/opt/codex');
  assert.equal(config.version, '0.161.0');
  assert.throws(() => cliConfig({ env: { CODEX_BACKEND_CLUSTER: 'unknown' } }), /must be bouchet or grace/);
  assert.throws(() => cliConfig({ env: { CODEX_BACKEND_CLI: 'relative' } }), /absolute path/);
  assert.throws(() => cliConfig({ env: { CODEX_BACKEND_CLI_VERSION: 'latest' } }), /Unsupported/);
});
