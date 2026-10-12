'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const C = require('./common.cjs');
function binding(pid = process.ppid) {
  for (let depth = 0; pid > 1 && depth < 48; depth++) {
    try {
      const ticks = C.processIdentity(pid);
      const file = path.join(C.root(), 'windows', `${pid}-${ticks}.json`);
      if (fs.existsSync(file)) return C.readJson(file);
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    } catch { break; }
  }
}
async function dispatch(args) {
  const selected = binding();
  if (selected) return require(path.join(selected.component, 'wrapper.cjs')).run(selected.descriptor, args, process.cwd(), selected.windowPid);
  const bundled = args[0] && path.isAbsolute(args[0]) ? args.shift() : null;
  const child = spawn(bundled || C.cliPath(), args, { stdio: 'inherit', env: process.env });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => child.kill(signal));
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code ?? 1)); });
}
module.exports = { binding, dispatch };
if (require.main === module) dispatch(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { console.error(`claude-backend: ${error.message}`); process.exitCode = 1; });
