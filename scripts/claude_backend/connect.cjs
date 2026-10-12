'use strict';
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const C = require('./common.cjs');
const T = require('./transport.cjs');
async function connect(project, action = 'connect') {
  project = C.canonical(project);
  if (!['connect', 'status', 'doctor', 'local'].includes(action)) throw new Error('Usage: connect_claude_backend.sh [--project DIR] [connect|status|doctor|local|check]');
  const { findHelper, refreshHelpers, send } = require('./codex/connect.cjs');
  const hook = process.env.VSCODE_IPC_HOOK_CLI;
  let helper = hook && findHelper(project, hook, C.root());
  if (action === 'local') {
    if (!helper) throw new Error('Run in the connected VS Code window terminal');
    const reply = await send(helper.socket, { action: 'restore' });
    if (reply.status === 'failed') throw new Error(reply.error);
    console.log('LOCAL_CLAUDE: new sessions use the local CLI'); return;
  }
  const selected = await T.select(project);
  if (action === 'status' || action === 'doctor') {
    console.log(JSON.stringify({ backendAvailable: true, backend: await T.probe(selected.file), window: helper ? await send(helper.socket, { action: 'status' }) : { verified: false, mode: 'window-unverified' } }, null, 2)); return;
  }
  if (!hook) throw new Error('Run connect in the VS Code integrated terminal');
  const helperUpgrade = helper && C.canonical(helper.component) !== C.canonical(__dirname);
  if (!helper || helperUpgrade) {
    const installed = execFileSync('code', ['--list-extensions'], { encoding: 'utf8', timeout: 30000 });
    if (!installed.split(/\r?\n/).includes('anthropic.claude-code')) execFileSync('code', ['--install-extension', 'anthropic.claude-code'], { stdio: 'inherit', timeout: 120000 });
    const vsix = require('./package-helper.cjs').packageHelper(__dirname);
    execFileSync('code', ['--install-extension', vsix, '--force'], { stdio: 'inherit', timeout: 120000 });
    if (helperUpgrade) throw new Error('Claude connector updated, but this window still runs the previous helper. Run Developer: Reload Window once, then repeat connect; the backend keeps running');
    await refreshHelpers(project, C.root());
    const deadline = Date.now() + 15000;
    while (!helper && Date.now() < deadline) { helper = findHelper(project, hook, C.root()); if (!helper) await delay(250); }
    if (!helper) throw new Error('Claude connector installed. Run Developer: Reload Window once, then repeat connect; no backend restart is needed');
  }
  const reply = await send(helper.socket, { action: 'connect', descriptor: selected.file, project, component: __dirname });
  if (reply.status === 'failed') throw new Error(reply.error);
  console.log(`CLAUDE_BACKEND_CONFIGURED job=${reply.jobId} node=${reply.hostname} extension=${reply.extensionVersion}`);
  console.log('Open a new Claude Code tab, or close and resume an idle conversation. status reports verified=true after the extension launches its backend process.');
}
module.exports = { connect };
if (require.main === module) connect(...process.argv.slice(2)).catch(error => { console.error(`claude-backend: ${error.message}`); process.exitCode = 1; });
