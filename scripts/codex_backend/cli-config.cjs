'use strict';
const os = require('node:os');
const path = require('node:path');

// Keep the original Bouchet installation; Grace uses the standalone CLI.
function cliConfig({ env = process.env, host = os.hostname(), home = os.homedir() } = {}) {
  const cluster = env.CODEX_BACKEND_CLUSTER || (/\.grace\./i.test(host) ? 'grace' : 'bouchet');
  if (!['bouchet', 'grace'].includes(cluster)) throw new Error('CODEX_BACKEND_CLUSTER must be bouchet or grace');
  const cli = env.CODEX_BACKEND_CLI || path.join(home, cluster === 'grace' ? '.local/bin/codex' : '.npm-global/bin/codex');
  // Optional user pin only; ordinary updates are detected from the installed CLI.
  const version = env.CODEX_BACKEND_CLI_VERSION || undefined;
  if (!path.isAbsolute(cli)) throw new Error('CODEX_BACKEND_CLI must be an absolute path');
  if (version && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Unsupported CODEX_BACKEND_CLI_VERSION');
  return { cli, version, cluster };
}
module.exports = { cliConfig };
