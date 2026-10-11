/**
 * Rebrands user-visible strings in downloaded built-in extensions.
 * Run after `download-extensions.js`; safe to run repeatedly.
 */
const path = require('path');
const fs = require('fs');

const extensionsDir = path.resolve(process.argv[2] || path.join(__dirname, '../extensions'));

const PATCHES = [
  {
    // Source Control welcome text: "...how to use git and source control in VS Code..."
    extension: 'vscode.git',
    files: /^package\.nls(\.[\w-]+)?\.json$/,
    replace: [[/\bVS Code\b/g, 'OLKIL']],
  },
];

function brandExtensions(dir) {
  let changed = 0;
  for (const patch of PATCHES) {
    const extDir = path.join(dir, patch.extension);
    if (!fs.existsSync(extDir)) {
      console.warn(`[brand-extensions] ${patch.extension} not found in ${dir}`);
      continue;
    }
    for (const name of fs.readdirSync(extDir)) {
      if (!patch.files.test(name)) {
        continue;
      }
      const file = path.join(extDir, name);
      const before = fs.readFileSync(file, 'utf8');
      const after = patch.replace.reduce((text, [pattern, value]) => text.replace(pattern, value), before);
      if (after !== before) {
        fs.writeFileSync(file, after);
        changed++;
        console.log(`[brand-extensions] patched ${patch.extension}/${name}`);
      }
    }
  }
  return changed;
}

if (require.main === module) {
  brandExtensions(extensionsDir);
}

module.exports = { brandExtensions };
