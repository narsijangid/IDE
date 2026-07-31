/**
 * Zip updates-feed-hostinger/ (preferred) or updates-feed/ for Hostinger deploy.
 * Usage: node scripts/zip-updates-feed.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const light = path.join(root, 'updates-feed-hostinger');
const full = path.join(root, 'updates-feed');
const feedDir = fs.existsSync(light) ? light : full;
const repoRoot = path.join(root, '..');

if (!fs.existsSync(feedDir)) {
  console.error('Missing updates feed. Run: node scripts/publish-update.js');
  process.exit(1);
}

const ts = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const zipName = `olkil-updates_${ts}.zip`;
const zipPath = path.join(repoRoot, zipName);

if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

if (process.platform === 'win32') {
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${feedDir}\\*' -DestinationPath '${zipPath}' -Force"`,
    { stdio: 'inherit' },
  );
} else {
  execSync(`cd "${feedDir}" && zip -r "${zipPath}" .`, { stdio: 'inherit' });
}

console.log('[zip-updates-feed] from', feedDir);
console.log('[zip-updates-feed] created', zipPath);
console.log('[zip-updates-feed] Deploy to Hostinger domain: updates.olkil.com');
