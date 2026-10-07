'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const C = require('./common.cjs');

// Caller holds the project's exclusive service lock. A killed bootstrap can
// leave Codex's 15-minute backfill lease behind although its owner has exited.
function recoverBackfill(sqliteHome) {
  const stateFile = path.join(sqliteHome, 'state_5.sqlite');
  if (!fs.existsSync(stateFile)) return;
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(stateFile);
  try {
    db.exec('PRAGMA busy_timeout=5000');
    const result = db.prepare("UPDATE backfill_state SET status='pending' WHERE id=1 AND status='running'").run();
    if (result.changes) console.log('BACKFILL_RECOVERED abandoned startup lease; retaining its history watermark');
  } finally { db.close(); }
}

async function run(project, socket, descriptorFile, sqliteHome) {
  console.log('BACKEND_STARTUP checking CLI version (up to 120 seconds for cold shared storage)');
  C.checkCli();
  project = C.canonical(project);
  C.privateDirectory(path.dirname(socket));
  C.privateDirectory(path.dirname(descriptorFile));
  C.privateDirectory(sqliteHome);
  recoverBackfill(sqliteHome);
  console.log('BACKEND_STARTUP starting app-server');
  const descriptor = { schema: 'codex_backend_v1', id: `${os.hostname()}-${process.env.SLURM_JOB_ID}`,
    hostname: os.hostname(), jobId: process.env.SLURM_JOB_ID, project, socket,
    cli: C.CLI, version: C.CLI_VERSION, sqliteHome, status: 'starting', startedAt: new Date().toISOString() };
  const child = spawn(C.CLI, ['-c', 'features.code_mode_host=true', '-c', `sqlite_home=${JSON.stringify(sqliteHome)}`, 'app-server',
    '--listen', `unix://${socket}`, '--analytics-default-enabled'], { cwd: project, stdio: ['ignore', 'inherit', 'inherit'] });
  descriptor.pid = child.pid; descriptor.startTicks = C.processIdentity(child.pid);
  C.writeJson(descriptorFile, descriptor);
  let exited = false;
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => { exited = true; resolve({ code: code ?? 1, signal }); });
  });
  exit.catch(() => {});
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  try {
    // Cold NFS-backed state/configuration startup can exceed a minute.
    const deadline = Date.now() + 900000;
    while (true) {
      if (exited) throw new Error('app-server exited before readiness');
      try { const probe = await C.rpcClient(socket); probe.close(); break; }
      catch (error) { if (Date.now() >= deadline) throw error; await delay(250); }
    }
    // Import shared rollout history into this project's private, durable index.
    // Never share SQLite WAL files with another node's default Codex process.
    const index = await C.rpcClient(socket, { timeout: 120000 });
    try { await index.request('thread/list', { limit: 1, sourceKinds: ['cli', 'vscode', 'appServer'], useStateDbOnly: false }); }
    finally { index.close(); }
    descriptor.projectAliases = [project];
    descriptor.status = 'ready'; C.writeJson(descriptorFile, descriptor);
    console.log(`BACKEND_READY job=${descriptor.jobId} node=${descriptor.hostname} pid=${descriptor.pid} socket=${socket}`);
    console.log(`TUI: ${C.CLI} --remote unix://${socket}`);
    console.log('Tunnel connection information: vscode_slurm.out; then bash ./scripts/connect_codex_backend.sh');
    const result = await exit;
    descriptor.status = result.code === 0 ? 'stopped' : 'failed';
    descriptor.exitCode = result.code; descriptor.signal = result.signal;
    descriptor.stoppedAt = new Date().toISOString(); C.writeJson(descriptorFile, descriptor);
    return result.code;
  } catch (error) {
    child.kill('SIGTERM');
    const killDeadline = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await exit; } finally { clearTimeout(killDeadline); }
    descriptor.status = 'failed'; descriptor.error = error.message; C.writeJson(descriptorFile, descriptor);
    throw error;
  }
}
if (require.main === module) run(...process.argv.slice(2)).then(code => { process.exitCode = code; })
  .catch(error => { console.error(`BACKEND_FAILED ${error.message}`); process.exitCode = 1; });
module.exports = { run, recoverBackfill };
