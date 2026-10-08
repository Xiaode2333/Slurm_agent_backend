'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { SPEC, hash, createPatcher } = require('../webview-ime.cjs');
const original = 'function layout(c,m,B,nGe,e4){if(m)return e4.jsx("recovery",{children:B});let V;return ' + SPEC.before + ',V}';
const wrapper = 'function wrapper(e){return e.children}';
const fixtureSpec = { ...SPEC, originalHash: hash(original), wrapperHash: hash(wrapper) };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ime-patch-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const extension = path.join(root, 'extension'), assets = path.join(extension, 'webview/assets');
  fs.mkdirSync(assets, { recursive: true });
  const packageFile = path.join(extension, 'package.json');
  fs.writeFileSync(packageFile, JSON.stringify({ name: 'chatgpt', publisher: 'openai', version: SPEC.version }));
  const target = path.join(assets, SPEC.bundle);
  fs.writeFileSync(target, original, { mode: 0o600 });
  fs.writeFileSync(path.join(assets, SPEC.wrapper), wrapper);
  return { root, extension, packageFile, target, backups: path.join(root, 'backups'), patcher: createPatcher(fixtureSpec) };
}
function render(source, error, gate = false) {
  const ctx = { error, gate, B: { type: 'composer', marker: 'same-input' }, nGe: wrapper, e4: { jsx: (type, props) => ({ type, props }) } };
  vm.createContext(ctx); vm.runInContext(source, ctx);
  return ctx.layout(error, gate, ctx.B, ctx.nGe, ctx.e4);
}
test('account-error regression fails before fix and keeps the component boundary after fix', () => {
  assert.notEqual(render(original, undefined).type, render(original, new Error('query')).type);
  const patched = createPatcher().transform(original);
  for (const error of [undefined, new Error('query'), undefined, new Error('HTTP 403'), null]) {
    assert.equal(render(patched, error).type, wrapper);
  }
  assert.equal(render(original, undefined, true).type, 'recovery');
  assert.equal(render(patched, new Error('query'), true).type, 'recovery');
  assert.equal(patched, original.replace(SPEC.before, SPEC.after));
});
test('transform refuses missing or ambiguous matches and does not change access gates', () => {
  const patcher = createPatcher();
  assert.throws(() => patcher.transform('different build'), /exactly one/);
  assert.throws(() => patcher.transform(original + original), /exactly one/);
  assert.ok(patcher.transform(original).includes('if(m)return e4.jsx("recovery",{children:B})'));
});
test('apply and rollback retain exact original bytes, permissions and private backups', t => {
  const f = fixture(t), applied = f.patcher.apply(f.extension, f.backups);
  assert.equal(f.patcher.inspect(f.extension).state, 'patched');
  assert.equal(fs.readFileSync(f.target, 'utf8'), original.replace(SPEC.before, SPEC.after));
  const info = JSON.parse(fs.readFileSync(applied.manifest));
  assert.equal(fs.statSync(path.dirname(applied.manifest)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(info.backup).mode & 0o777, 0o600);
  assert.equal(fs.statSync(applied.manifest).mode & 0o777, 0o600);
  assert.throws(() => f.patcher.apply(f.extension, f.backups), /Already patched/);
  f.patcher.rollback(applied.manifest);
  assert.equal(fs.readFileSync(f.target, 'utf8'), original);
  assert.equal(fs.statSync(f.target).mode & 0o777, 0o600);
  assert.equal(f.patcher.rollback(applied.manifest).status, 'rolled-back');
});
test('unknown build, changed wrapper and symlink target are rejected without writes', t => {
  const f = fixture(t);
  fs.writeFileSync(f.target, original + '\n');
  assert.throws(() => f.patcher.apply(f.extension, f.backups), /changed Webview/);
  assert.ok(!fs.existsSync(f.backups));
  fs.writeFileSync(f.target, original);
  fs.writeFileSync(path.join(path.dirname(f.target), SPEC.wrapper), wrapper + '\n');
  assert.throws(() => f.patcher.apply(f.extension, f.backups), /Wrapper asset changed/);
  fs.writeFileSync(path.join(path.dirname(f.target), SPEC.wrapper), wrapper);
  const copy = path.join(f.root, 'copy'); fs.renameSync(f.target, copy); fs.symlinkSync(copy, f.target);
  assert.throws(() => f.patcher.apply(f.extension, f.backups), /ordinary path/);
  assert.equal(fs.readFileSync(copy, 'utf8'), original);
});
test('rollback refuses an extension upgrade or changed asset and preserves it', t => {
  const f = fixture(t), applied = f.patcher.apply(f.extension, f.backups);
  const patched = fs.readFileSync(f.target, 'utf8');
  fs.writeFileSync(f.packageFile, JSON.stringify({ name: 'chatgpt', publisher: 'openai', version: 'future' }));
  assert.throws(() => f.patcher.rollback(applied.manifest), /Unsupported official/);
  assert.equal(fs.readFileSync(f.target, 'utf8'), patched);
  fs.writeFileSync(f.packageFile, JSON.stringify({ name: 'chatgpt', publisher: 'openai', version: SPEC.version }));
  fs.writeFileSync(f.target, patched + '\n');
  assert.throws(() => f.patcher.rollback(applied.manifest), /changed Webview/);
  assert.equal(fs.readFileSync(f.target, 'utf8'), patched + '\n');
});
test('rollback refuses corrupted original backup and mismatched target paths', t => {
  const f = fixture(t), applied = f.patcher.apply(f.extension, f.backups);
  const info = JSON.parse(fs.readFileSync(applied.manifest));
  fs.writeFileSync(info.backup, original + '\n');
  assert.throws(() => f.patcher.rollback(applied.manifest), /backup\/identity changed/);
  fs.writeFileSync(info.backup, original);
  info.target = path.join(f.root, 'unrelated'); fs.writeFileSync(applied.manifest, JSON.stringify(info));
  assert.throws(() => f.patcher.rollback(applied.manifest), /path mismatch/);
  assert.equal(f.patcher.inspect(f.extension).state, 'patched');
});
