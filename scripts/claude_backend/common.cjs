'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = () => path.join(os.homedir(), '.local/state/claude-backend');
const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
const canonical = value => fs.realpathSync(value);
function privateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const s = fs.lstatSync(dir);
  if (!s.isDirectory() || s.uid !== process.getuid() || (s.mode & 0o077)) throw new Error(`Not a private directory: ${dir}`);
  return dir;
}
function readJson(file) {
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.uid !== process.getuid() || (s.mode & 0o077)) throw new Error(`Not a private file: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJson(file, value) {
  privateDirectory(path.dirname(file));
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(temp, file);
}
function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid PID');
  const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return s.slice(s.lastIndexOf(')') + 2).split(' ')[19];
}
function cliVersion(cli) {
  fs.accessSync(cli, fs.constants.X_OK);
  const out = execFileSync(cli, ['--version'], { encoding: 'utf8', timeout: 120000 }).trim();
  const version = out.match(/^(\d+\.\d+\.\d+(?:-[\w.-]+)?) \(Claude Code\)$/)?.[1];
  if (!version) throw new Error(`Unrecognized Claude Code version: ${out}`);
  return version;
}
function cliPath(env = process.env) {
  if (env.CLAUDE_BACKEND_CLI) return canonical(env.CLAUDE_BACKEND_CLI);
  for (const file of [path.join(os.homedir(), '.local/bin/claude'), path.join(os.homedir(), '.npm-global/bin/claude'),
    ...(env.PATH || '').split(path.delimiter).map(dir => path.join(dir, 'claude'))]) {
    try { fs.accessSync(file, fs.constants.X_OK); return canonical(file); } catch { /* Try next installed CLI. */ }
  }
  throw new Error('Claude Code is not installed; set CLAUDE_BACKEND_CLI');
}
function validate(d, local = true) {
  if (d.schema !== 'claude_backend_v1' || d.status !== 'ready' || !/^\d+$/.test(d.jobId) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(d.hostname) || !path.isAbsolute(d.socket) || !path.isAbsolute(d.component)) throw new Error('Invalid Claude backend descriptor');
  if (local) {
    if (d.hostname !== os.hostname() || processIdentity(d.pid) !== d.startTicks) throw new Error('Stale Claude backend process');
    const s = fs.lstatSync(d.socket);
    if (!s.isSocket() || s.uid !== process.getuid() || (s.mode & 0o077)) throw new Error('Invalid private backend socket');
  }
  return d;
}
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
// Length-bounded JSON envelopes carry bytes; native stdout/stderr never acquire broker records.
function channel(stream, receive) {
  let buffer = Buffer.alloc(0);
  stream.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    try {
      let i;
      while ((i = buffer.indexOf(10)) >= 0) {
        if (i > 2 * 1024 * 1024) throw new Error('Oversized backend frame');
        const line = buffer.subarray(0, i); buffer = buffer.subarray(i + 1);
        receive(JSON.parse(line.toString('utf8')));
      }
      if (buffer.length > 2 * 1024 * 1024) throw new Error('Oversized backend frame');
    } catch (error) { stream.destroy(error); }
  });
  return value => {
    if (stream.destroyed || !stream.writable) return false;
    if (stream.writableLength > 4 * 1024 * 1024) { stream.destroy(new Error('Backend client too slow')); return false; }
    return stream.write(JSON.stringify(value) + '\n');
  };
}
module.exports = { root, hash, canonical, privateDirectory, readJson, writeJson, processIdentity, cliVersion, cliPath, validate, quote, channel };
