'use strict';
// Opt-in workaround; never called by backend startup or connector installation.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const SPEC = Object.freeze({
  version: '26.930.61225',
  bundle: 'app-initial-532d60c9b397.js',
  wrapper: 'app-initial-5120fa5fe295.js',
  originalHash: 'c19b16eec9cf6f5e0d85acd68a579d36be0a95ef81648b4a59f1813e90af46e9',
  wrapperHash: '3e661c7e7feaa43d23e70f990deaa0b67369dca6073a435e05964a5fb752d754',
  before: 'V=c==null?(0,e4.jsx)(nGe,{children:B}):B',
  after: 'V=(0,e4.jsx)(nGe,{children:B})',
});
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function requireThat(condition, message) { if (!condition) throw new Error(message); }
function owned(file, directory = false) {
  const stat = fs.lstatSync(file);
  requireThat(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()) && stat.uid === process.getuid(), 'Expected user-owned ordinary path: ' + file);
  return stat;
}
function privateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); owned(dir, true); fs.chmodSync(dir, 0o700); return dir;
}
function syntax(source) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: source, encoding: 'utf8' });
  if (result.error) throw result.error;
  requireThat(result.status === 0, 'Patched JavaScript syntax failed: ' + result.stderr);
}
function atomicWrite(file, bytes, mode, expectedHash) {
  const temp = file + '.ime-' + crypto.randomUUID();
  try {
    const fd = fs.openSync(temp, 'wx', mode);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (expectedHash) { owned(file); requireThat(hash(fs.readFileSync(file)) === expectedHash, 'File changed before replacement'); }
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
// Spec injection is for isolated fixtures only. The CLI always uses frozen SPEC.
function createPatcher(spec = SPEC) {
  function transform(source) {
    requireThat(source.split(spec.before).length === 2, 'Expected exactly one approved wrapper expression');
    return source.replace(spec.before, spec.after);
  }
  function inspect(extensionDir) {
    extensionDir = path.resolve(extensionDir); owned(extensionDir, true);
    const packageFile = path.join(extensionDir, 'package.json'); owned(packageFile);
    const pkg = JSON.parse(fs.readFileSync(packageFile));
    requireThat(pkg.publisher === 'openai' && pkg.name === 'chatgpt' && pkg.version === spec.version, 'Unsupported official extension version/identity');
    const target = path.join(extensionDir, 'webview/assets', spec.bundle);
    const wrapper = path.join(extensionDir, 'webview/assets', spec.wrapper);
    const mode = owned(target).mode & 0o777; owned(wrapper);
    requireThat(hash(fs.readFileSync(wrapper)) === spec.wrapperHash, 'Wrapper asset changed; stop for review');
    const source = fs.readFileSync(target, 'utf8');
    const currentHash = hash(source);
    let state;
    if (currentHash === spec.originalHash) { transform(source); state = 'original'; }
    else if (source.split(spec.after).length === 2 && hash(source.replace(spec.after, spec.before)) === spec.originalHash) state = 'patched';
    requireThat(state, 'Unsupported or changed Webview bundle; refusing mutation');
    return { extensionDir, target, source, currentHash, mode, state };
  }
  function apply(extensionDir, backupRoot = path.join(os.homedir(), '.local/state/codex-backend/webview-patches')) {
    const current = inspect(extensionDir);
    requireThat(current.state === 'original', 'Already patched; retain and use its existing rollback manifest');
    const patched = transform(current.source); syntax(patched);
    const dir = fs.mkdtempSync(path.join(privateDirectory(backupRoot), 'ime-' + spec.version + '-')); fs.chmodSync(dir, 0o700);
    const backup = path.join(dir, 'original.js');
    fs.writeFileSync(backup, current.source, { flag: 'wx', mode: 0o600 });
    const manifestFile = path.join(dir, 'manifest.json');
    const manifest = { schema: 'codex_ime_wrapper_patch_v1', version: spec.version, extensionDir: current.extensionDir,
      target: current.target, backup, originalHash: spec.originalHash, patchedHash: hash(patched), wrapperHash: spec.wrapperHash,
      originalMode: current.mode, status: 'prepared', at: new Date().toISOString() };
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    // Revalidate the package/wrapper immediately before replacing the bundle.
    requireThat(inspect(extensionDir).currentHash === current.currentHash, 'Extension changed before patch');
    atomicWrite(current.target, patched, current.mode, current.currentHash);
    requireThat(inspect(extensionDir).state === 'patched', 'Patched asset verification failed');
    manifest.status = 'applied'; atomicWrite(manifestFile, JSON.stringify(manifest, null, 2) + '\n', 0o600);
    return { status: 'applied', manifest: manifestFile, patchedHash: manifest.patchedHash, reload: 'Developer: Reload Webviews' };
  }
  function rollback(manifestFile) {
    manifestFile = path.resolve(manifestFile); owned(manifestFile);
    const manifest = JSON.parse(fs.readFileSync(manifestFile));
    requireThat(manifest.schema === 'codex_ime_wrapper_patch_v1' && manifest.version === spec.version && manifest.originalHash === spec.originalHash && manifest.wrapperHash === spec.wrapperHash, 'Unsupported rollback manifest');
    const current = inspect(manifest.extensionDir);
    requireThat(current.target === manifest.target && manifest.backup === path.join(path.dirname(manifestFile), 'original.js'), 'Rollback path mismatch');
    owned(manifest.backup);
    const original = fs.readFileSync(manifest.backup, 'utf8');
    requireThat(hash(original) === spec.originalHash && hash(transform(original)) === manifest.patchedHash, 'Rollback backup/identity changed');
    requireThat(Number.isInteger(manifest.originalMode) && manifest.originalMode >= 0 && manifest.originalMode <= 0o777, 'Invalid original permissions');
    if (current.state === 'patched') {
      requireThat(current.currentHash === manifest.patchedHash, 'Patched identity changed');
      atomicWrite(current.target, original, manifest.originalMode, current.currentHash);
    }
    requireThat(inspect(manifest.extensionDir).state === 'original', 'Rollback verification failed');
    manifest.status = 'rolled-back'; atomicWrite(manifestFile, JSON.stringify(manifest, null, 2) + '\n', 0o600);
    return { status: 'rolled-back', reload: 'Developer: Reload Webviews' };
  }
  return { transform, inspect, apply, rollback };
}
module.exports = { SPEC, hash, createPatcher };
if (require.main === module) {
  try {
    const [action, argument, ...extra] = process.argv.slice(2);
    requireThat(!extra.length && ['check', 'apply', 'rollback'].includes(action), 'Usage: node webview-ime.cjs check|apply [EXTENSION_DIR] | rollback MANIFEST');
    requireThat(typeof process.getuid === 'function', 'Run on the Linux remote extension host, not the desktop');
    const patcher = createPatcher();
    const extensionDir = argument || path.join(os.homedir(), '.vscode-server/extensions/openai.chatgpt-' + SPEC.version + '-linux-x64');
    let result;
    if (action === 'rollback') { requireThat(argument, 'Rollback requires the saved manifest'); result = patcher.rollback(argument); }
    else if (action === 'apply') result = patcher.apply(extensionDir);
    else { const current = patcher.inspect(extensionDir); result = { version: SPEC.version, state: current.state, hash: current.currentHash, target: current.target }; }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error('codex-webview-ime: ' + error.message); process.exitCode = 1; }
}
