'use strict';
// Keep WAL traffic on this node, retaining consistent SQLite backup snapshots
// in the durable project namespace. Never copy an open WAL database as a file.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');
const C = require('./common.cjs');

async function snapshot(source, target) {
  const db = new DatabaseSync(source, { readOnly: true });
  const temp = `${target}.${process.pid}.tmp`;
  try {
    await backup(db, temp);
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, target);
  } finally { db.close(); fs.rmSync(temp, { force: true }); }
}
async function restore(durable, local) {
  C.privateDirectory(local);
  const saved = path.join(durable, 'snapshots');
  const files = new Set([...fs.readdirSync(durable), ...(fs.existsSync(saved) ? fs.readdirSync(saved) : [])].filter(x => x.endsWith('.sqlite')));
  for (const file of files) {
    const source = fs.existsSync(path.join(saved, file)) ? saved : durable;
    await snapshot(path.join(source, file), path.join(local, file));
  }
}
async function sync(local, durable) {
  const saved = C.privateDirectory(path.join(durable, 'snapshots'));
  for (const file of fs.readdirSync(local).filter(x => x.endsWith('.sqlite'))) {
    await snapshot(path.join(local, file), path.join(saved, file));
  }
}
async function run(project, socket, descriptor, durable) {
  C.privateDirectory(durable);
  const local = C.privateDirectory(path.join(path.dirname(socket), 'sqlite'));
  await restore(durable, local);
  const { run: server } = require('./server.cjs');
  let inFlight = Promise.resolve();
  let syncing = false;
  let failure;
  const interval = setInterval(() => {
    if (syncing) return;
    syncing = true;
    inFlight = sync(local, durable).catch(error => { failure = error; console.error(`SQLITE_CHECKPOINT_FAILED ${error.message}`); }).finally(() => { syncing = false; });
  }, 60000);
  try { return await server(project, socket, descriptor, local); }
  finally {
    clearInterval(interval); await inFlight;
    await sync(local, durable);
    if (failure) console.error('A periodic SQLite backup failed; final backup succeeded.');
  }
}
module.exports = { snapshot, restore, sync, run };
if (require.main === module) run(...process.argv.slice(2)).then(code => { process.exitCode = code; })
  .catch(error => { console.error(`SQLITE_STORE_FAILED ${error.message}`); process.exitCode = 1; });
