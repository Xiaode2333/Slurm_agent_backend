'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { matchesComponent } = require('../connect.cjs');

test('component identity accepts symlink aliases but rejects different or missing components', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-component-test-'));
  try {
    const actual = path.join(root, 'actual');
    const alias = path.join(root, 'alias');
    const other = path.join(root, 'other');
    fs.mkdirSync(actual);
    fs.mkdirSync(other);
    fs.symlinkSync(actual, alias);
    assert.equal(matchesComponent({ component: alias }, actual), true);
    assert.equal(matchesComponent({ component: actual }, alias), true);
    assert.equal(matchesComponent({ component: other }, actual), false);
    assert.equal(matchesComponent({ component: path.join(root, 'missing') }, actual), false);
    assert.equal(matchesComponent(undefined, actual), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
