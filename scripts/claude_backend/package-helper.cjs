'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
function packageHelper(component) {
  const packager = require(path.join(component, 'codex/package-helper.cjs'));
  const vsix = packager.packageHelper(component);
  // The shared packager generates a Codex identity; align metadata with this independent helper.
  const manifest = path.join(component, 'dist/extension.vsixmanifest');
  fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').replaceAll('Id="codex-backend"', 'Id="claude-backend"').replaceAll('Publisher="mdlammps"', 'Publisher="slurm-agent"').replaceAll('Codex Backend', 'Claude Backend').replaceAll('official Codex', 'official Claude Code'));
  execFileSync('zip', ['-q', vsix, 'extension.vsixmanifest'], { cwd: path.join(component, 'dist') });
  const output = path.join(component, 'claude-backend.vsix'); fs.renameSync(vsix, output); return output;
}
module.exports = { packageHelper };
if (require.main === module) console.error(`Packaged ${packageHelper(process.argv[2])}`);
