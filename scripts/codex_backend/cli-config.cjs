'use strict';
const os = require('node:os');
const path = require('node:path');

// Keep the original Bouchet installation; Grace uses the standalone CLI.
function cliConfig({ env = process.env, host = os.hostname(), home = os.homedir() } = {}) {
  const cluster = env.CODEX_BACKEND_CLUSTER || (/\.grace\./i.test(host) ? 'grace' : 'bouchet');
  if (!['bouchet', 'grace'].includes(cluster)) throw new Error('CODEX_BACKEND_CLUSTER must be bouchet or grace');
  const cli = env.CODEX_BACKEND_CLI || path.join(home, cluster === 'grace' ? '.local/bin/codex' : '.npm-global/bin/codex');
  const version = env.CODEX_BACKEND_CLI_VERSION || (cluster === 'grace' ? '0.161.0' : '0.160.1');
  if (!path.isAbsolute(cli)) throw new Error('CODEX_BACKEND_CLI must be an absolute path');
  if (!['0.160.1', '0.161.0'].includes(version)) throw new Error('Unsupported CODEX_BACKEND_CLI_VERSION');
  return { cli, version, cluster };
}
module.exports = { cliConfig };
