'use strict';
const os = require('node:os');
const C = require('./common.cjs');
const T = require('./transport.cjs');
async function run(file, args, project = process.cwd(), windowPid) {
  const connection = T.stream(file); await connection.opened;
  let exited = false;
  const send = value => {
    if (connection.input.destroyed) return false;
    return connection.input.write(JSON.stringify(value) + '\n');
  };
  const signals = new Map();
  // Any signal to this wrapper (window reload/close, Ctrl-C) detaches so the
  // native session keeps running in the allocation and can be reattached.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => {
      exited = true; send({ op: 'detach' }); cleanup(); connection.close();
      process.exit(128 + os.constants.signals[signal]);
    };
    signals.set(signal, handler); process.on(signal, handler);
  }
  const cleanup = () => { for (const [signal, handler] of signals) process.removeListener(signal, handler); process.stdin.pause(); };
  return new Promise((resolve, reject) => {
    C.channel(connection.output, value => {
      if (value.op === 'started') {
        // Private evidence distinguishes an available supervisor from an actual extension process.
        const receipt = { ...value, wrapperPid: process.pid, wrapperStartTicks: C.processIdentity(process.pid), hostname: os.hostname(), backend: file, entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT, windowPid, connected: true };
        const receiptFile = require('node:path').join(C.root(), 'receipts', `${os.hostname()}-${process.pid}.json`);
        C.writeJson(receiptFile, receipt);
        process.stdin.on('data', chunk => { if (!send({ op: 'input', data: chunk.toString('base64') })) process.stdin.pause(); });
        connection.input.on('drain', () => process.stdin.resume());
        process.stdin.once('end', () => send({ op: 'eof' })); process.stdin.resume();
        if (process.stdin.readableEnded) send({ op: 'eof' });
        connection.output.once('end', () => C.writeJson(receiptFile, { ...receipt, connected: false }));
      } else if (value.op === 'stdout' || value.op === 'stderr') {
        const output = value.op === 'stdout' ? process.stdout : process.stderr;
        if (!output.write(Buffer.from(value.data, 'base64'))) { connection.output.pause(); output.once('drain', () => connection.output.resume()); }
      } else if (value.op === 'exit') {
        exited = true; cleanup(); connection.close(); resolve(value.code ?? (value.signal ? 128 + (os.constants.signals[value.signal] || 1) : 1));
      } else if (value.op === 'error') { exited = true; cleanup(); connection.close(); reject(new Error(value.error)); }
    });
    connection.output.once('error', error => { cleanup(); reject(error); });
    connection.output.once('end', () => { if (!exited) { cleanup(); reject(new Error('Claude backend connection lost; inspect backend status before resuming')); } });
    send({ op: 'spawn', args, project: C.canonical(project), hostname: os.hostname(), env: process.env });
  });
}
module.exports = { run };
if (require.main === module) run(process.argv[2], process.argv.slice(3)).then(code => { process.exitCode = code; }).catch(error => { console.error(`claude-backend: ${error.message}`); process.exitCode = 1; });
