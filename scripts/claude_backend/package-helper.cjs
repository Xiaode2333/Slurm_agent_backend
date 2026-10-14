'use strict';
const path = require('node:path');
function packageHelper(component) {
  // The shared packager derives identity and archive name from this helper's
  // manifest, so both helpers use the same atomic packaging implementation.
  return require(path.join(component, 'codex/package-helper.cjs')).packageHelper(component);
}
module.exports = { packageHelper };
if (require.main === module) console.error(`Packaged ${packageHelper(process.argv[2])}`);
