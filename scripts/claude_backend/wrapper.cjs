'use strict';
const os = require('node:os');
const path = require('node:path');
const C = require('./common.cjs');
const T = require('./transport.cjs');

async function run(file, args, project = process.cwd(), windowPid) {
  return new Promise((resolve, reject) => {
    let connection, identity, receipt, receiptFile, ready = false, stopped = false, clientEnded = false;
    let generation = 0, failedGeneration = -1, retries = 0, timer, retryTimer, outputSeq = 0, inputSeq = 0, queuedBytes = 0;
    const pending = new Map(), signals = new Map();
    const writeReceipt = connected => {
      if (receiptFile) C.writeJson(receiptFile, { ...receipt, connected, reconnecting: !connected && !stopped });
    };
    const send = value => {
      if (!connection || connection.input.destroyed || !connection.input.writable) return false;
      return connection.input.write(JSON.stringify(value) + '\n');
    };
    const cleanup = () => {
      clearTimeout(timer); clearTimeout(retryTimer);
      for (const [signal, handler] of signals) process.removeListener(signal, handler);
      process.stdin.removeListener('data', onInput); process.stdin.removeListener('end', onEnd); process.stdin.pause();
      writeReceipt(false); connection?.close();
    };
    const finish = (error, code) => {
      if (stopped) return;
      stopped = true; cleanup();
      if (error) reject(error); else resolve(code);
    };
    const resumeInput = () => {
      if (ready && !clientEnded && queuedBytes < 4 * 1024 * 1024 && connection.input.writableLength < 4 * 1024 * 1024) process.stdin.resume();
    };
    const onInput = chunk => {
      if (identity?.protocol !== 'resume-v1') { if (!send({ op: 'input', data: chunk.toString('base64') })) process.stdin.pause(); return; }
      const value = { op: 'input', seq: ++inputSeq, data: chunk.toString('base64') };
      queuedBytes += chunk.length;
      if (queuedBytes > 4 * 1024 * 1024) { finish(new Error('Claude reconnect input buffer exceeded; native work preserved, inspect before resuming')); return; }
      pending.set(value.seq, { value, size: chunk.length });
      if (!ready || !send(value)) process.stdin.pause();
    };
    const onEnd = () => { clientEnded = true; if (ready) send({ op: 'eof' }); };
    process.stdin.pause(); process.stdin.on('data', onInput); process.stdin.once('end', onEnd);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handler = () => {
        send({ op: 'detach' }); finish(null, 128 + os.constants.signals[signal]);
        process.exit(128 + os.constants.signals[signal]);
      };
      signals.set(signal, handler); process.on(signal, handler);
    }
    const lost = (epoch, error) => {
      if (stopped || epoch !== generation || failedGeneration === epoch) return;
      failedGeneration = epoch; clearTimeout(timer); ready = false; process.stdin.pause();
      writeReceipt(false); connection?.close();
      if (!identity || identity.protocol !== 'resume-v1' || clientEnded || retries >= 4) {
        finish(new Error(`Claude backend transport lost (not a native Claude exit); native work may still be running. ${error?.message || 'Connection closed'}. Inspect backend status before resuming`)); return;
      }
      const wait = [250, 500, 1000, 2000][retries++];
      process.stderr.write(`claude-backend: transport interrupted; reconnecting to the same native process (${retries}/4)\n`);
      retryTimer = setTimeout(open, wait);
    };
    const open = () => {
      if (stopped) return;
      const epoch = ++generation;
      try { connection = T.stream(file); }
      catch (error) { lost(epoch, error); return; }
      const active = connection;
      timer = setTimeout(() => lost(epoch, new Error('Reconnect handshake timed out')), 12000);
      active.input.on('drain', () => { if (epoch === generation) resumeInput(); });
      C.channel(active.output, value => {
        if (stopped || epoch !== generation || failedGeneration === epoch) return;
        if (value.op === 'started') {
          if (identity && (value.id !== identity.id || value.pid !== identity.pid || value.startTicks !== identity.startTicks || value.reconnectToken !== identity.reconnectToken || !value.reconnected)) {
            finish(new Error('Claude reconnect identity changed; refusing to launch or replay into another process')); return;
          }
          const reconnected = Boolean(identity);
          identity = value; ready = true; retries = 0; clearTimeout(timer);
          receipt = { ...value, wrapperPid: process.pid, wrapperStartTicks: C.processIdentity(process.pid), hostname: os.hostname(), backend: file, entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT, windowPid };
          receiptFile = path.join(C.root(), 'receipts', `${os.hostname()}-${process.pid}.json`); writeReceipt(true);
          if (reconnected) process.stderr.write('claude-backend: transport restored; native process unchanged\n');
          if (value.status !== 'exited') {
            for (const { value: input } of pending.values()) send(input);
            if (process.stdin.readableEnded || clientEnded) { clientEnded = true; send({ op: 'eof' }); }
            else resumeInput();
          }
        } else if (value.op === 'input_ack') {
          if (!Number.isSafeInteger(value.seq) || value.seq < 0 || value.seq > inputSeq) { finish(new Error('Invalid Claude input acknowledgement')); return; }
          for (const [seq, item] of pending) if (seq <= value.seq) { queuedBytes -= item.size; pending.delete(seq); }
          resumeInput();
        } else if (value.op === 'stdout' || value.op === 'stderr' || value.op === 'exit') {
          if (identity?.protocol === 'resume-v1') {
            if (!Number.isSafeInteger(value.seq) || value.seq < 1 || value.seq > outputSeq + 1) { finish(new Error('Claude reconnect output gap; resume from native history')); return; }
            if (value.seq <= outputSeq) return;
          }
          if (value.op === 'exit') { finish(null, value.code ?? (value.signal ? 128 + (os.constants.signals[value.signal] || 1) : 1)); return; }
          const output = value.op === 'stdout' ? process.stdout : process.stderr;
          if (!output.write(Buffer.from(value.data, 'base64'))) {
            active.output.pause(); output.once('drain', () => { if (epoch === generation && !stopped) active.output.resume(); });
          }
          if (identity?.protocol === 'resume-v1') { outputSeq = value.seq; send({ op: 'ack', seq: outputSeq }); }
        } else if (value.op === 'error') finish(new Error(value.error));
      });
      active.output.once('error', error => lost(epoch, error));
      active.output.once('end', () => lost(epoch));
      active.child?.once('error', error => lost(epoch, error));
      active.opened.then(() => {
        if (stopped || epoch !== generation || failedGeneration === epoch) return;
        if (identity) send({ op: 'reconnect', id: identity.id, pid: identity.pid, startTicks: identity.startTicks, token: identity.reconnectToken, afterSeq: outputSeq });
        else send({ op: 'spawn', protocol: 'resume-v1', args, project: C.canonical(project), hostname: os.hostname(), env: process.env });
      }).catch(error => lost(epoch, error));
    };
    open();
  });
}
module.exports = { run };
if (require.main === module) run(process.argv[2], process.argv.slice(3)).then(code => { process.exitCode = code; }).catch(error => { console.error(`claude-backend: ${error.message}`); process.exitCode = 1; });
