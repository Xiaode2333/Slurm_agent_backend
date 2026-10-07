'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const C = require('./common.cjs');
const { broker } = require('./harness-broker.cjs');
const root = () => path.join(os.homedir(), '.local/state/slurm-agent-backend');
const binaries = { opencode: 'opencode', pi: 'pi', 'claude-code': 'claude' };
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
function spec(harness, mode, args = []) {
  if (!binaries[harness]) throw new Error('Harness must be opencode, pi or claude-code');
  if (!['native', 'rpc'].includes(mode)) throw new Error('Mode must be native or rpc');
  if (harness === 'opencode') {
    if (mode !== 'native') throw new Error('OpenCode uses native HTTP; use native mode');
    if (args.some(arg => /^(--hostname|--port|--mdns)(=|$)/.test(arg))) throw new Error('The service manages the loopback endpoint; do not override hostname/port/mdns');
    return { executable: binaries[harness], args: ['serve', '--hostname', '127.0.0.1', '--port', '0', ...args], transport: 'http' };
  }
  if (mode === 'native') return { executable: binaries[harness], args, transport: 'tmux' };
  return { executable: binaries[harness], transport: 'jsonl', args: harness === 'pi' ? ['--mode', 'rpc', ...args] :
    ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...args] };
}
function select(harness, project, job = process.env.AGENT_BACKEND_JOB) {
  project = C.canonical(project);
  const dir = path.join(root(), 'services'); const matches = [];
  for (const file of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    try {
      const value = C.readJson(path.join(dir, file));
      if (value.harness !== harness || value.hostname !== os.hostname() || (value.project !== project && harness !== 'opencode') ||
          value.status !== 'ready' || (job && value.jobId !== job) || value.startTicks !== C.processIdentity(value.pid)) continue;
      matches.push(value);
    } catch { /* Failed/stale services are not active. */ }
  }
  if (matches.length !== 1) throw new Error(`Expected one ${harness} service for this project on this node; found ${matches.length}. Use AGENT_BACKEND_JOB to select an allocation.`);
  return { ...matches[0], clientProject: project };
}
async function serve(harness, project, mode = 'native', ...args) {
  if (!process.env.SLURM_JOB_ID) throw new Error('Use a Slurm allocation');
  project = C.canonical(project); const command = spec(harness, mode, args);
  const state = C.privateDirectory(root());
  const id = `${os.hostname()}-${process.env.SLURM_JOB_ID}-${harness}`;
  const session = C.privateDirectory(path.join(state, 'sessions', id));
  const local = fs.mkdtempSync(path.join(process.env.SLURM_TMPDIR || os.tmpdir(), 'agent-')); fs.chmodSync(local, 0o700);
  const descriptorFile = path.join(state, 'services', `${id}.json`);
  const descriptor = { schema: 'slurm_agent_service_v1', id, harness, mode, transport: command.transport, project,
    hostname: os.hostname(), jobId: process.env.SLURM_JOB_ID, pid: process.pid, startTicks: C.processIdentity(process.pid),
    status: 'starting', session, startedAt: new Date().toISOString() };
  C.writeJson(descriptorFile, descriptor);
  let child, service;
  const stop = signal => child?.kill(signal);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop(signal));
  try {
    if (command.transport === 'tmux') {
      const tmux = `agent-${process.env.SLURM_JOB_ID}`; descriptor.tmux = tmux;
      const result = path.join(local, 'exit-code');
      const shell = `trap 'status=$?; printf "%s\\n" "$status" > ${quote(result)}; tmux -L ${quote(tmux)} wait-for -S agent-exited' EXIT\n${[command.executable, ...command.args].map(quote).join(' ')}\n`;
      const script = path.join(local, 'window.sh'); fs.writeFileSync(script, shell, { mode: 0o700 });
      execFileSync('tmux', ['-L', tmux, 'new-session', '-d', '-s', 'agent', '-n', 'admin', '-c', project, 'exec bash --noprofile --norc']);
      execFileSync('tmux', ['-L', tmux, 'set-option', '-g', 'remain-on-exit', 'on']);
      execFileSync('tmux', ['-L', tmux, 'new-window', '-t', 'agent', '-n', 'harness', '-c', project, `bash ${quote(script)}`]);
      descriptor.status = 'ready'; C.writeJson(descriptorFile, descriptor);
      console.log(`AGENT_READY harness=${harness} transport=tmux job=${descriptor.jobId}`);
      child = spawn('tmux', ['-L', tmux, 'wait-for', 'agent-exited'], { stdio: 'inherit' });
      await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      if (!fs.existsSync(result)) throw new Error('Native harness exited without an exit receipt');
      descriptor.exitCode = Number(fs.readFileSync(result, 'utf8').trim());
      execFileSync('tmux', ['-L', tmux, 'kill-server'], { stdio: 'ignore' });
    } else {
      const env = { ...process.env };
      if (command.transport === 'http') {
        const password = crypto.randomBytes(32).toString('hex');
        descriptor.authFile = path.join(session, 'http-auth.json');
        C.writeJson(descriptor.authFile, { username: 'opencode', password });
        env.OPENCODE_SERVER_USERNAME = 'opencode'; env.OPENCODE_SERVER_PASSWORD = password;
      }
      // OpenCode's native SQLite storage is user-wide. One service owns it;
      // projects attach to that server rather than opening cross-node WALs.
      const executable = command.transport === 'http' ? 'flock' : command.executable;
      const childArgs = command.transport === 'http' ? ['-n', '-F', path.join(state, 'opencode.lock'), command.executable, ...command.args] : command.args;
      child = spawn(executable, childArgs, { cwd: project, env, stdio: ['pipe', 'pipe', 'inherit'] });
      let earlyError;
      child.once('error', error => { earlyError = error; });
      const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code: code ?? 1, signal })));
      if (command.transport === 'jsonl') {
        descriptor.socket = path.join(local, 'rpc.sock'); descriptor.journal = path.join(session, 'events.jsonl');
        service = await broker(child, descriptor.socket, descriptor.journal);
      } else {
        let buffer = '';
        child.stdout.on('data', bytes => {
          const text = bytes.toString(); process.stdout.write(text.replace(/https?:\/\/\S+/g, '[local endpoint]'));
          buffer = (buffer + text).slice(-8192);
          const match = buffer.match(/http:\/\/127\.0\.0\.1:(\d+)/);
          if (match) descriptor.url = match[0];
        });
        const deadline = Date.now() + 120000;
        while (!descriptor.url) {
          if (earlyError) throw earlyError;
          if (child.exitCode !== null) throw new Error('OpenCode exited before readiness');
          if (Date.now() > deadline) throw new Error('OpenCode readiness timeout');
          await delay(100);
        }
        const auth = C.readJson(descriptor.authFile);
        const response = await fetch(`${descriptor.url}/global/health`, { headers: { Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}` }, signal: AbortSignal.timeout(10000) });
        if (!response.ok || !(await response.json()).healthy) throw new Error('OpenCode health check failed');
      }
      if (earlyError) throw earlyError;
      descriptor.childPid = child.pid; descriptor.status = 'ready'; C.writeJson(descriptorFile, descriptor);
      console.log(`AGENT_READY harness=${harness} transport=${command.transport} job=${descriptor.jobId}`);
      const result = await (service?.done || exited); descriptor.exitCode = result.code; descriptor.signal = result.signal;
    }
    descriptor.status = descriptor.exitCode === 0 ? 'stopped' : 'failed';
    return descriptor.exitCode;
  } catch (error) {
    descriptor.status = 'failed'; descriptor.error = error.message;
    child?.kill('SIGTERM'); throw error;
  } finally {
    if (descriptor.tmux) { try { execFileSync('tmux', ['-L', descriptor.tmux, 'kill-server'], { stdio: 'ignore' }); } catch {} }
    await service?.close(); descriptor.stoppedAt = new Date().toISOString(); C.writeJson(descriptorFile, descriptor);
  }
}
async function attach(descriptor, options) {
  if (descriptor.transport === 'tmux') {
    const child = spawn('tmux', ['-L', descriptor.tmux, 'attach', '-t', 'agent'], { stdio: 'inherit' });
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code ? reject(new Error(`tmux attach exited ${code}`)) : resolve()); }); return;
  }
  if (descriptor.transport === 'http') {
    const auth = C.readJson(descriptor.authFile);
    const child = spawn('opencode', ['attach', descriptor.url, '--dir', descriptor.clientProject || descriptor.project, ...options], {
      stdio: 'inherit', env: { ...process.env, OPENCODE_SERVER_USERNAME: auth.username, OPENCODE_SERVER_PASSWORD: auth.password },
    });
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code ? reject(new Error(`opencode attach exited ${code}`)) : resolve()); }); return;
  }
  const position = options.indexOf('--from');
  const from = position === -1 ? undefined : Number(options[position + 1]);
  if (position !== -1 && (!Number.isSafeInteger(from) || from < 0)) throw new Error('--from requires a nonnegative sequence');
  const client = net.createConnection(descriptor.socket);
  client.once('connect', () => {
    // Write the control frame before consuming even already-buffered input.
    client.write(JSON.stringify({ action: 'attach', readOnly: options.includes('--read-only'), from }) + '\n');
    process.stdin.pipe(client, { end: false });
    process.stdin.once('end', () => client.end());
  });
  client.on('data', bytes => { if (!process.stdout.write(bytes)) { client.pause(); process.stdout.once('drain', () => client.resume()); } });
  // EOF disconnects the client, not the persistent process.
  try {
    await new Promise((resolve, reject) => { client.once('error', reject); client.once('close', resolve); });
  } finally {
    process.stdin.unpipe(client);
  }
}
module.exports = { spec, select, serve, attach, root };
if (require.main === module) (async () => {
  const [action, harness, project = process.cwd(), ...options] = process.argv.slice(2);
  if (action === 'serve') return await serve(harness, project, ...options);
  if (action === 'check') { const command = spec(harness, options[0] || 'native'); console.log(execFileSync(command.executable, ['--version'], { encoding: 'utf8', timeout: 30000 }).trim()); return 0; }
  const descriptor = select(harness, project);
  if (action === 'status') { console.log(JSON.stringify(descriptor, null, 2)); return 0; }
  if (action === 'attach') { await attach(descriptor, options); return 0; }
  throw new Error('Usage: agent_backend.sh check|status|attach HARNESS [PROJECT] [options]');
})().then(code => { process.exitCode = code; }).catch(error => { console.error(`agent-backend: ${error.message}`); process.exitCode = 1; });
