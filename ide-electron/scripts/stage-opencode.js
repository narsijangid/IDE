/**
 * Download the official OpenCode CLI binary into build/opencode so OLKIL can
 * spawn it as an isolated sidecar (not bundled into Electron/webpack).
 *
 * Usage: node scripts/stage-opencode.js
 * Override: OPENCODE_VERSION=v1.18.21 OPENCODE_SRC=C:\\path\\to\\opencode.exe
 */
const fs = require('fs');
const https = require('https');
const http = require('http');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const VERSION = process.env.OPENCODE_VERSION || 'v1.18.21';
const destDir = path.join(__dirname, '..', 'build', 'opencode');
const exeName = process.platform === 'win32' ? 'opencode.exe' : 'opencode';

function assetName() {
  const plat = process.platform;
  const arch = process.arch;
  if (plat === 'win32' && arch === 'arm64') {
    return 'opencode-windows-arm64.zip';
  }
  if (plat === 'win32') {
    return 'opencode-windows-x64.zip';
  }
  if (plat === 'darwin' && arch === 'arm64') {
    return 'opencode-darwin-arm64.zip';
  }
  if (plat === 'darwin') {
    return 'opencode-darwin-x64.zip';
  }
  if (arch === 'arm64') {
    return 'opencode-linux-arm64.tar.gz';
  }
  return 'opencode-linux-x64.tar.gz';
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) {
      reject(new Error(`Too many redirects for ${url}`));
      return;
    }
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(
      url,
      {
        headers: { 'User-Agent': 'olkil-stage-opencode' },
      },
      (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          download(res.headers.location, dest, redirects + 1).then(resolve, reject);
          return;
        }
        if (code !== 200) {
          res.resume();
          reject(new Error(`Download failed ${code} ${url}`));
          return;
        }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve()));
        out.on('error', reject);
      },
    );
    req.on('error', reject);
  });
}

function extract(archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (process.platform === 'win32') {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${archive.replace(
        /'/g,
        "''",
      )}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force"`,
      { stdio: 'inherit' },
    );
    return;
  }
  if (archive.endsWith('.tar.gz') || archive.endsWith('.tgz')) {
    execSync(`tar -xzf "${archive}" -C "${dest}"`, { stdio: 'inherit' });
    return;
  }
  execSync(`unzip -o "${archive}" -d "${dest}"`, { stdio: 'inherit' });
}

function findBinary(dir, depth = 0) {
  if (depth > 4) {
    return null;
  }
  const entries = fs.readdirSync(dir);
  for (const name of entries) {
    const full = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isFile() && name === exeName) {
      return full;
    }
    if (stat.isDirectory()) {
      const nested = findBinary(full, depth + 1);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

async function main() {
  fs.mkdirSync(destDir, { recursive: true });
  const destBin = path.join(destDir, exeName);

  if (process.env.OPENCODE_SRC) {
    const src = process.env.OPENCODE_SRC;
    if (!fs.existsSync(src)) {
      throw new Error(`OPENCODE_SRC not found: ${src}`);
    }
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      const found = findBinary(src);
      if (!found) {
        throw new Error(`No ${exeName} under OPENCODE_SRC=${src}`);
      }
      fs.copyFileSync(found, destBin);
    } else {
      fs.copyFileSync(src, destBin);
    }
    console.log('[stage-opencode] Copied', destBin);
    return;
  }

  if (fs.existsSync(destBin)) {
    console.log('[stage-opencode] Already staged:', destBin);
    return;
  }

  const name = assetName();
  const url = `https://github.com/anomalyco/opencode/releases/download/${VERSION}/${name}`;
  const tmp = path.join(os.tmpdir(), name);
  console.log('[stage-opencode] Downloading', url);
  await download(url, tmp);
  console.log('[stage-opencode] Extracting to', destDir);
  extract(tmp, destDir);
  try {
    fs.unlinkSync(tmp);
  } catch {
    // ignore
  }

  const found = findBinary(destDir);
  if (!found) {
    throw new Error(`Extracted archive but ${exeName} was not found in ${destDir}`);
  }
  if (path.resolve(found) !== path.resolve(destBin)) {
    fs.copyFileSync(found, destBin);
  }
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(destBin, 0o755);
    } catch {
      // ignore
    }
  }
  console.log('[stage-opencode] Staged', destBin);
}

main().catch((err) => {
  console.error('[stage-opencode]', err.message || err);
  process.exit(1);
});
