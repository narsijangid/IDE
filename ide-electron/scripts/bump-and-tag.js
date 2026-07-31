#!/usr/bin/env node
/**
 * Bump product version + create git tag for release pipeline.
 * Usage (from repo root or ide-electron):
 *   node ide-electron/scripts/bump-and-tag.js
 *   node ide-electron/scripts/bump-and-tag.js 1.4.0
 *   node ide-electron/scripts/bump-and-tag.js --push
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ideRoot = path.join(__dirname, '..');
const repoRoot = path.join(ideRoot, '..');
const productPath = path.join(ideRoot, 'product.json');
const args = process.argv.slice(2).filter((a) => a !== '--push');
const doPush = process.argv.includes('--push');

function bumpPatch(v) {
  const parts = String(v)
    .replace(/^v/, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  parts[2] += 1;
  return parts.join('.');
}

const product = JSON.parse(fs.readFileSync(productPath, 'utf8'));
const next = args[0] ? String(args[0]).replace(/^v/, '') : bumpPatch(product.version);
product.version = next;
fs.writeFileSync(productPath, JSON.stringify(product, null, 2) + '\n');

// Keep build/package.json in sync
process.chdir(ideRoot);
require('./apply-product');

const tag = `v${next}`;
console.log('[bump] version →', next, 'tag', tag);

execSync('git add ide-electron/product.json ide-electron/build/package.json', {
  cwd: repoRoot,
  stdio: 'inherit',
});
try {
  execSync(`git commit -m "release: OLKIL ${tag}"`, { cwd: repoRoot, stdio: 'inherit' });
} catch {
  console.log('[bump] nothing to commit or commit failed');
}

try {
  execSync(`git tag -a ${tag} -m "OLKIL ${tag}"`, { cwd: repoRoot, stdio: 'inherit' });
} catch {
  console.warn('[bump] tag may already exist');
}

if (doPush) {
  execSync('git push origin HEAD', { cwd: repoRoot, stdio: 'inherit' });
  execSync(`git push origin ${tag}`, { cwd: repoRoot, stdio: 'inherit' });
  console.log('[bump] pushed. CI will build & publish if workflow is enabled.');
} else {
  console.log('[bump] local only. Run with --push to push commit+tag.');
}
