'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function xml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}
function helperManifest(component) {
  return JSON.parse(fs.readFileSync(path.join(component, 'helper', 'package.json'), 'utf8'));
}
function packageHelper(component) {
  // This is an API compatibility floor, not the build machine's version. A
  // shared component may be built headlessly or by a newer/different Tunnel.
  const manifest = helperManifest(component);
  const engine = manifest.engines.vscode;
  const version = `0.1.${parseInt(require('node:crypto').createHash('sha256').update(component).digest('hex').slice(0, 8), 16)}`;
  const dist = fs.mkdtempSync(path.join(component, '.vsix-'));
  try {
    fs.mkdirSync(path.join(dist, 'extension'));
    fs.copyFileSync(path.join(component, 'helper', 'extension.cjs'), path.join(dist, 'extension', 'extension.cjs'));
    manifest.version = version;
    fs.writeFileSync(path.join(dist, 'extension', 'package.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(dist, 'extension', 'runtime.json'), JSON.stringify({ component }));
    fs.writeFileSync(path.join(dist, '[Content_Types].xml'), `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="cjs" ContentType="application/javascript"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>`);
    fs.writeFileSync(path.join(dist, 'extension.vsixmanifest'), `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="${xml(manifest.name)}" Version="${version}" Publisher="${xml(manifest.publisher)}"/><DisplayName>${xml(manifest.displayName)}</DisplayName><Description xml:space="preserve">${xml(manifest.description)}</Description><Tags></Tags><Categories>Other</Categories><GalleryFlags></GalleryFlags><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${engine}"/><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/></Properties></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets></PackageManifest>`);
    const archive = path.join(dist, 'codex-backend.vsix');
    execFileSync('zip', ['-q', '-r', archive, '[Content_Types].xml', 'extension.vsixmanifest', 'extension'], { cwd: dist });
    const vsix = path.join(component, `${manifest.name}.vsix`);
    // Concurrent windows must never install a missing or partially written ZIP.
    fs.renameSync(archive, vsix);
    return vsix;
  } finally { fs.rmSync(dist, { recursive: true, force: true }); }
}
function installHelper(component) {
  const vsix = path.join(component, 'codex-backend.vsix');
  const install = () => {
    let output;
    try {
      output = execFileSync('code', ['--install-extension', vsix, '--force'], {
        encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 8 * 1024 * 1024,
      });
    } catch (error) {
      // Inherited stdio makes error.stdout/stderr null and hides the only
      // reliable indication of the actual remote server's compatibility error.
      if (error.stdout) process.stdout.write(error.stdout);
      if (error.stderr) process.stderr.write(error.stderr);
      throw error;
    }
    if (output) process.stdout.write(output);
  };
  try { install(); }
  catch (error) {
    const output = `${error.stdout || ''}${error.stderr || ''}`;
    const mismatch = output.match(/not compatible with VS Code\s+['"](\d+)\.(\d+)\.(\d+)(?:[^'"]*)['"]/i);
    if (!mismatch) throw error;
    const engine = helperManifest(component).engines.vscode;
    const floor = engine.match(/^\^(\d+)\.(\d+)\.(\d+)$/);
    const target = mismatch.slice(1, 4).map(Number);
    if (!floor || target[0] !== Number(floor[1]) || target[1] < Number(floor[2]) ||
        (target[1] === Number(floor[2]) && target[2] < Number(floor[3]))) {
      throw new Error(`Connector requires VS Code ${engine}; installation target is ${target.join('.')}. Update the desktop client/use vscode.dev, or use a connector supporting that server. The backend keeps running.`);
    }
    console.error(`Connector package is incompatible with remote VS Code ${target.join('.')}; repackaging with supported engine ${engine} and retrying once.`);
    packageHelper(component);
    install(); // Only compatibility failures retry; a second rejection is fatal.
  }
}
module.exports = { packageHelper, installHelper };
if (require.main === module) console.error(`Packaged ${packageHelper(process.argv[2])}`);
