'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const C = require('./common.cjs');

const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');

// The socket's parent is the launcher's private node-local allocation runtime.
// Never execute an ELF from an extension directory on shared storage: another
// node can remove it during an update, invalidating executable mmap pages.
function createExecutableStore(runtime) {
  C.privateDirectory(runtime);
  const root = fs.mkdtempSync(path.join(runtime, 'claude-executables-'));
  fs.chmodSync(root, 0o700);
  const cache = new Map();
  return source => {
    source = C.canonical(source);
    let input, output, directory;
    try {
      input = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const before = fs.fstatSync(input, { bigint: true });
      if (!before.isFile() || !(before.mode & 0o111n)) throw new Error('Expected a regular executable');
      const magic = Buffer.alloc(4);
      fs.readSync(input, magic, 0, magic.length, 0);
      // npm/JavaScript and shell launchers may depend on adjacent packages.
      // Relocating them changes semantics; only standalone native ELF is copied.
      if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return { cli: source, sourceCli: source };
      const key = identity(before), cached = cache.get(source);
      if (cached?.key === key) return cached.result;
      directory = fs.mkdtempSync(path.join(root, 'native-'));
      fs.chmodSync(directory, 0o700);
      const temporary = path.join(directory, 'copying'), cli = path.join(directory, 'claude');
      output = fs.openSync(temporary, 'wx', 0o600);
      const digest = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
      let position = 0, count;
      while ((count = fs.readSync(input, buffer, 0, buffer.length, position))) {
        if (BigInt(position + count) > before.size) throw new Error('Source changed during snapshot');
        digest.update(buffer.subarray(0, count));
        let written = 0;
        while (written < count) written += fs.writeSync(output, buffer, written, count - written);
        position += count;
      }
      if (BigInt(position) !== before.size || identity(fs.fstatSync(input, { bigint: true })) !== key) throw new Error('Source changed during snapshot');
      fs.fchmodSync(output, 0o500);
      fs.fsyncSync(output);
      fs.closeSync(output); output = undefined;
      // Unique directory: publication never replaces any previously used inode.
      fs.renameSync(temporary, cli);
      const result = { cli, sourceCli: source, cliSha256: digest.digest('hex') };
      cache.set(source, { key, result });
      return result;
    } catch (error) {
      if (output !== undefined) { fs.closeSync(output); output = undefined; }
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
      throw new Error(`Cannot snapshot Claude executable ${source}: ${error.message}`, { cause: error });
    } finally {
      if (input !== undefined) fs.closeSync(input);
    }
  };
}
module.exports = { createExecutableStore };
