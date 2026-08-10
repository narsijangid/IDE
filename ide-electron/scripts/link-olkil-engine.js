/**
 * Relink vendored @olkil/* engine packages into node_modules (Windows junctions).
 * Run after clone / yarn install if @olkil imports fail.
 *
 * Usage: node scripts/link-olkil-engine.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const dest = path.join(root, 'packages', 'olkil-engine');
const olkilNm = path.join(root, 'node_modules', '@olkil');

const links = {
  shared: 'shared',
  llms: 'llms',
  agents: 'agents',
  core: 'core',
  engine: 'sdk',
};

const nested = [
  ['llms', path.join(root, 'node_modules', '@cline', 'llms', 'node_modules')],
  ['core', path.join(root, 'node_modules', '@cline', 'core', 'node_modules')],
];

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function junction(link, target) {
  if (fs.existsSync(link)) {
    fs.rmSync(link, { recursive: true, force: true });
  }
  execSync(`cmd /c mklink /J "${link}" "${target}"`, { stdio: 'inherit' });
}

ensureDir(olkilNm);
for (const [name, folder] of Object.entries(links)) {
  const target = path.join(dest, folder);
  if (!fs.existsSync(target)) {
    console.error('missing', target);
    process.exit(1);
  }
  junction(path.join(olkilNm, name), target);
}

for (const [pkg, from] of nested) {
  if (!fs.existsSync(from)) {
    console.warn('skip nested deps (optional):', from);
    continue;
  }
  const to = path.join(dest, pkg, 'node_modules');
  if (fs.existsSync(to)) {
    // already linked/copied
    continue;
  }
  junction(to, from);
}

console.log('Linked @olkil/* engine packages.');
