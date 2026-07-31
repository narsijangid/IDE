/**
 * Prepare / publish OLKIL auto-update artifacts.
 *
 * Flow (Cursor-style release updates):
 * 1. Bump product.json version (or pass PRODUCT_VERSION=1.4.0)
 * 2. yarn pack:publish → builds installer + latest.yml into ide-electron/out
 * 3. node scripts/publish-update.js
 *    - Stages updates-feed/ (full artifacts)
 *    - Uploads binaries to GitHub Releases (GH_TOKEN)
 *    - Stages updates-feed-hostinger/ (tiny: yml with absolute GitHub URLs)
 * 4. Deploy updates-feed-hostinger/ → https://updates.olkil.com
 *
 * Apps poll Hostinger; downloads come from GitHub (large .exe stay off Hostinger).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'out');
const feedDir = path.join(root, 'updates-feed');
const hostingerFeedDir = path.join(root, 'updates-feed-hostinger');
const product = require('../product.json');

const UPDATE_URL = process.env.OLKIL_UPDATE_URL || 'https://updates.olkil.com';
const GH_OWNER = process.env.OLKIL_GH_OWNER || 'narsijangid';
const GH_REPO = process.env.OLKIL_GH_REPO || 'IDE';
const version = String(product.version).replace(/^v/, '');
const tag = `v${version}`;
const releaseBase = `https://github.com/${GH_OWNER}/${GH_REPO}/releases/download/${tag}`;

function ensureOutArtifacts() {
  if (!fs.existsSync(outDir)) {
    throw new Error(`Missing ${outDir}. Run \`yarn pack:publish\` first.`);
  }
  const yml = ['latest.yml', 'latest-mac.yml', 'latest-linux.yml'].find((f) =>
    fs.existsSync(path.join(outDir, f)),
  );
  if (!yml) {
    console.warn(
      '[publish-update] No latest.yml in out/.\n' +
        '                Re-run: yarn pack:publish',
    );
  }
  return yml;
}

function copyOutFiles(destDir, { binaries = true } = {}) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });

  for (const name of fs.readdirSync(outDir)) {
    if (name === 'win-unpacked' || name === 'mac' || name === 'linux-unpacked' || name === 'builder-debug.yml') {
      continue;
    }
    const src = path.join(outDir, name);
    if (!fs.statSync(src).isFile()) continue;

    const isMeta = /\.yml$/i.test(name) || name === 'builder-effective-config.yaml';
    const isBinary = /\.(exe|dmg|deb|AppImage|zip|blockmap)$/i.test(name);
    if (!binaries && isBinary) continue;
    if (!binaries && !isMeta && !/\.yml$/i.test(name)) continue;

    fs.copyFileSync(src, path.join(destDir, name));
    console.log('[publish-update] staged', path.basename(destDir) + '/' + name);
  }
}

function writeLanding(destDir) {
  fs.writeFileSync(
    path.join(destDir, 'index.html'),
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OLKIL Updates</title>
  <style>
    body { font-family: Segoe UI, system-ui, sans-serif; background:#0b0d10; color:#e8eaed; margin:0; padding:48px 24px; }
    main { max-width:640px; margin:0 auto; }
    h1 { font-size:1.6rem; margin:0 0 8px; }
    p { color:#9aa0a6; line-height:1.5; }
    code { background:#1a1d23; padding:2px 6px; border-radius:4px; }
    a { color:#8ab4f8; }
  </style>
</head>
<body>
  <main>
    <h1>OLKIL update feed</h1>
    <p>Current channel version: <code>${version}</code></p>
    <p>Installed OLKIL apps check this host automatically.</p>
    <p>Feed: <a href="./latest.yml">latest.yml</a> · Site: <a href="https://olkil.com">olkil.com</a></p>
  </main>
</body>
</html>
`,
  );

  fs.writeFileSync(
    path.join(destDir, '.htaccess'),
    `Options -Indexes
<IfModule mod_mime.c>
  AddType text/yaml .yml
  AddType application/octet-stream .exe .blockmap .dmg .deb .AppImage .zip
</IfModule>
<IfModule mod_headers.c>
  Header set Cache-Control "no-cache, must-revalidate"
</IfModule>
`,
  );
}

/** Rewrite relative artifact names in electron-builder yml to absolute GitHub Release URLs. */
function rewriteYmlAbsolute(ymlText) {
  return ymlText
    .replace(/^(\s*-\s*url:\s*)([^\s]+)\s*$/gm, (full, prefix, url) => {
      if (/^https?:\/\//i.test(url)) return full;
      return `${prefix}${releaseBase}/${url}`;
    })
    .replace(/^(path:\s*)([^\s]+)\s*$/gm, (full, prefix, p) => {
      if (/^https?:\/\//i.test(p) || p === '""' || p === "''" || p === '""') return full;
      if (!p || p === '""') return full;
      const clean = p.replace(/^["']|["']$/g, '');
      if (!clean || /^https?:\/\//i.test(clean)) return full;
      return `${prefix}${releaseBase}/${clean}`;
    });
}

function stageHostingerLightFeed() {
  fs.rmSync(hostingerFeedDir, { recursive: true, force: true });
  fs.mkdirSync(hostingerFeedDir, { recursive: true });

  for (const name of ['latest.yml', 'latest-mac.yml', 'latest-linux.yml']) {
    const src = path.join(outDir, name);
    if (!fs.existsSync(src)) continue;
    const rewritten = rewriteYmlAbsolute(fs.readFileSync(src, 'utf8'));
    fs.writeFileSync(path.join(hostingerFeedDir, name), rewritten);
    console.log('[publish-update] hostinger meta', name, '→ GitHub URLs');
  }

  writeLanding(hostingerFeedDir);
  console.log('[publish-update] hostinger feed (light) at', hostingerFeedDir);
}

function stageFeed() {
  copyOutFiles(feedDir, { binaries: true });
  writeLanding(feedDir);
  console.log('[publish-update] full feed at', feedDir);
  stageHostingerLightFeed();
}

function tryGitHubRelease() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    console.log('[publish-update] GH_TOKEN not set — skip GitHub Release upload');
    console.log('[publish-update] Without GitHub Release, Hostinger light feed URLs will 404 until you upload binaries.');
    return;
  }

  const files = fs
    .readdirSync(feedDir)
    .filter((f) => !['index.html', '.htaccess'].includes(f))
    .map((f) => path.join(feedDir, f));

  try {
    try {
      execSync(`gh release view ${tag} --repo ${GH_OWNER}/${GH_REPO}`, {
        stdio: 'ignore',
        env: process.env,
      });
      console.log('[publish-update] GitHub release exists', tag);
    } catch {
      execSync(
        `gh release create ${tag} --repo ${GH_OWNER}/${GH_REPO} --title "OLKIL ${tag}" --notes "OLKIL desktop update ${tag}"`,
        { stdio: 'inherit', env: process.env },
      );
    }

    if (files.length) {
      const quoted = files.map((f) => `"${f}"`).join(' ');
      execSync(`gh release upload ${tag} ${quoted} --repo ${GH_OWNER}/${GH_REPO} --clobber`, {
        stdio: 'inherit',
        env: process.env,
      });
      console.log('[publish-update] uploaded assets to GitHub Release', tag);
    }
  } catch (err) {
    console.warn('[publish-update] GitHub release step failed:', err.message || err);
  }
}

function writeDeployHint() {
  const hint = path.join(root, 'AUTO-UPDATE.md');
  // keep the committed guide; just print next steps
  console.log('');
  console.log('=== NEXT: deploy Hostinger light feed ===');
  console.log(`1. Zip: ide-electron/updates-feed-hostinger/  (tiny — yml only)`);
  console.log(`2. Deploy zip to Hostinger domain updates.olkil.com`);
  console.log(`   or: node scripts/zip-updates-feed.js`);
  console.log(`3. Confirm ${UPDATE_URL}/latest.yml`);
  console.log(`Binaries live on GitHub: ${releaseBase}/`);
  console.log(`Guide: ${hint}`);
}

function main() {
  console.log('[publish-update] product version', version);
  ensureOutArtifacts();
  stageFeed();
  tryGitHubRelease();
  writeDeployHint();
}

main();
