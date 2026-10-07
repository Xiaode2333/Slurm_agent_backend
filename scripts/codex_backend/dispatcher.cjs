'use strict';
// The official CLI override is application-scoped. Resolve the actual parent
// extension host, rather than binding that shared setting to one project.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const C = require('./common.cjs');

function selectionFor(pid = process.ppid, root = C.stateRoot()) {
  const file = C.windowPath(root, pid);
  try { return C.readJson(file); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
}
async function selectionForLaunch(args, pid = process.ppid, root = C.stateRoot(), timeout = 5000) {
  const selected = selectionFor(pid, root);
  if (selected || (!args.includes('app-server') && !(args.length === 1 && args[0] === '--version'))) return selected;
  // A restored chat view can activate the official extension before the eager
  // helper finishes. Wait for its explicit bound/local decision, not a race.
  try { return await C.waitForFile(C.windowPath(root, pid), () => true, timeout); }
  catch (error) { if (!error.message.startsWith('Timed out waiting for ')) throw error; }
}
function dispatch(args, selection = selectionFor()) {
  if (selection?.descriptor && args.length === 1 && args[0] === '--version') {
    C.validateDescriptor(C.readJson(selection.descriptor), selection.project, require('node:os').hostname(), { allowShared: true });
    // A running pinned server supplies the version. Do not cold-launch the
    // native CLI just to answer the extension's version query again.
    return spawn(process.execPath, ['-e', `process.stdout.write('codex-cli ${C.CLI_VERSION}\\n')`], { stdio: 'inherit' });
  }
  if (selection?.descriptor && args.includes('app-server')) {
    const component = C.privateDirectory(selection.component);
    if (!fs.existsSync(path.join(component, 'installed'))) throw new Error('Selected connector is not installed');
    const file = path.join(component, 'launcher.sh');
    const options = {
      stdio: 'inherit', env: { ...process.env, CODEX_BACKEND_DESCRIPTOR_FILE: selection.descriptor,
        CODEX_BACKEND_PROJECT: selection.project, CODEX_BACKEND_RECEIPT_HOOK: `extension-host:${process.ppid}` },
    };
    // Node 22's execve on Linux preserves the extension's child process and
    // signal behavior, eliminating an extra proxy process on every launch.
    if (typeof process.execve === 'function') process.execve(file, [file, ...args], options.env);
    const child = spawn(file, args, options);
    return child;
  }
  // Unbound windows and non-app-server CLI commands keep the normal CLI.
  return spawn(C.CLI, args, { stdio: 'inherit' });
}
module.exports = { selectionFor, selectionForLaunch, dispatch };
if (require.main === module) (async () => {
  try {
    const args = process.argv.slice(2);
    const child = dispatch(args, await selectionForLaunch(args));
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
    child.once('error', error => { console.error(error.message); process.exitCode = 1; });
    child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
  } catch (error) { console.error(`codex-backend dispatcher: ${error.message}`); process.exitCode = 1; }
})();
