'use strict';

/** Copy the xterm.js runtime into src/panel/vendor so the right panel is
 * self-contained (no node_modules resolution needed at runtime). */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'src', 'panel', 'vendor');

fs.mkdirSync(VENDOR, { recursive: true });

const copies = [
  [path.join(ROOT, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'), path.join(VENDOR, 'xterm.js')],
  [path.join(ROOT, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), path.join(VENDOR, 'xterm.css')],
  [path.join(ROOT, 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js'), path.join(VENDOR, 'addon-fit.js')],
];

for (const [from, to] of copies) {
  if (!fs.existsSync(from)) {
    console.error('missing source for vendored file:', from);
    process.exit(1);
  }
  fs.copyFileSync(from, to);
  console.log('vendored', path.relative(ROOT, to));
}
