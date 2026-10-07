'use strict';
const fs = require('node:fs');
const net = require('node:net');
const { once } = require('node:events');
const { consumeJsonl } = require('./jsonl.cjs');

// One input owner prevents conflicting approvals/prompts. Any number of
// read-only consumers can watch; their loss never closes the harness stdin.
async function broker(child, socket, journal) {
  const clients = new Set(); let controller; let sequence = 0; let stopped = false;
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code: code ?? 1, signal }));
  });
  done.catch(() => {});
  const output = fs.createWriteStream(journal, { flags: 'a', mode: 0o600 });
  const ring = []; let ringBytes = 0;
  const publish = record => {
    const text = JSON.stringify({ seq: ++sequence, record }) + '\n';
    ring.push({ seq: sequence, text }); ringBytes += Buffer.byteLength(text);
    while (ringBytes > 4 * 1024 * 1024 && ring.length > 1) ringBytes -= Buffer.byteLength(ring.shift().text);
    if (!output.write(text)) child.stdout.pause();
    for (const client of clients) {
      if (client.writableLength > 4 * 1024 * 1024) { client.destroy(new Error('Slow consumer; reconnect using the journal')); continue; }
      client.write(text);
    }
  };
  output.on('drain', () => child.stdout.resume());
  output.on('error', error => { console.error(`HARNESS_JOURNAL_FAILED ${error.message}`); child.kill('SIGTERM'); });
  consumeJsonl(child.stdout, publish, error => { console.error(error.message); child.kill('SIGTERM'); });
  const server = net.createServer(client => {
    let hello = false;
    client.on('error', () => {});
    consumeJsonl(client, value => {
      if (!hello) {
        if (value.action !== 'attach') { client.end(JSON.stringify({ error: 'First record must be attach' }) + '\n'); return; }
        if (!value.readOnly && controller) { client.end(JSON.stringify({ error: 'A controller is already attached; use --read-only' }) + '\n'); return; }
        hello = true; if (!value.readOnly) controller = client;
        const from = Number.isSafeInteger(value.from) && value.from >= 0 ? value.from : sequence;
        client.write(JSON.stringify({ attached: true, readOnly: Boolean(value.readOnly), sequence,
          replayGap: ring.length > 0 && from < ring[0].seq - 1, journal }) + '\n');
        for (const item of ring) if (item.seq > from) client.write(item.text);
        clients.add(client); return;
      }
      if (controller !== client) { client.write(JSON.stringify({ error: 'Read-only observer cannot send input' }) + '\n'); return; }
      if (!child.stdin.write(JSON.stringify(value) + '\n')) { client.pause(); child.stdin.once('drain', () => client.resume()); }
    }, error => client.destroy(error));
    client.on('close', () => { clients.delete(client); if (controller === client) controller = undefined; });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  fs.chmodSync(socket, 0o600);
  const close = async () => {
    if (stopped) return; stopped = true;
    for (const client of clients) client.end();
    server.close(); output.end(); await once(output, 'finish');
  };
  return { done, close, publish };
}
module.exports = { broker };
