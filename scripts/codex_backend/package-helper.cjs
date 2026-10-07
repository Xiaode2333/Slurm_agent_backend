'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
// Query the installing CLI, not the standalone tunnel binary. Keep the
// declared minimum: packaging must not claim compatibility with older APIs.
function currentCodeVersion() {
  try {
    const out = execFileSync('code', ['--version'], { encoding: 'utf8', timeout: 30000 });
    const line = out.split(/\r?\n/).find(line => /\d+\.\d+\.\d+/.test(line));
    if (!line) return null;
    const [major, minor, patch] = line.match(/\d+\.\d+\.\d+/)[0].split('.').map(Number);
    return { raw: `${major}.${minor}.${patch}`, major, minor, patch };
  } catch { return null; }
}
function engineFor(code) {
  if (code.major !== 1 || code.minor < 95) {
    throw new Error(`Unsupported VS Code ${code.raw}; connector requires VS Code 1.95 or newer in the 1.x series`);
  }
  return `^1.${Math.max(code.minor - 5, 95)}.0`;
}
function packageHelper(component) {
  const dist = path.join(component, 'dist');
  const version = `0.1.${parseInt(require('node:crypto').createHash('sha256').update(component).digest('hex').slice(0, 8), 16)}`;
  const code = currentCodeVersion();
  const engine = code ? engineFor(code) : '^1.95.0';
  if (!code) console.error(`WARNING: could not determine the local VS Code version; using engine ${engine}`);
  fs.mkdirSync(path.join(dist, 'extension'), { recursive: true });
  for (const name of ['package.json', 'extension.cjs']) {
    fs.copyFileSync(path.join(component, 'helper', name), path.join(dist, 'extension', name));
  }
  const packageFile = path.join(dist, 'extension', 'package.json');
  const manifest = JSON.parse(fs.readFileSync(packageFile));
  manifest.version = version;
  if (manifest.engines) manifest.engines.vscode = engine;
  fs.writeFileSync(packageFile, JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dist, 'extension', 'runtime.json'), JSON.stringify({ component }));
  fs.writeFileSync(path.join(dist, '[Content_Types].xml'), `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="cjs" ContentType="application/javascript"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>`);
  fs.writeFileSync(path.join(dist, 'extension.vsixmanifest'), `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="codex-backend" Version="${version}" Publisher="mdlammps"/><DisplayName>Codex Backend Connector</DisplayName><Description xml:space="preserve">Connect the official Codex extension to a persistent allocation.</Description><Tags></Tags><Categories>Other</Categories><GalleryFlags></GalleryFlags><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${engine}"/><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/></Properties></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets></PackageManifest>`);
  const vsix = path.join(component, 'codex-backend.vsix');
  fs.rmSync(vsix, { force: true });
  execFileSync('zip', ['-q', '-r', vsix, '[Content_Types].xml', 'extension.vsixmanifest', 'extension'], { cwd: dist });
  return vsix;
}
module.exports = { packageHelper };
if (require.main === module) console.error(`Packaged ${packageHelper(process.argv[2])}`);
