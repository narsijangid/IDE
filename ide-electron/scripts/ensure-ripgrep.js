/**
 * Stage the ripgrep binary so Ctrl+Shift+F (OpenSumi search) can spawn it.
 *
 * OpenSumi bundles `@opensumi/vscode-ripgrep` and resolves:
 *   path.join(__dirname, '../bin/rg[.exe]')  →  app/bin
 * The package postinstall tries an Alipay CDN that often fails, so this script
 * copies a local Cursor/VS Code rg, then falls back to GitHub prebuilt.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const RG_VERSION = 'v13.0.0-4';
const root = path.join(__dirname, '..');
const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';

function destDirs() {
  return [
    path.join(root, 'node_modules', '@opensumi', 'vscode-ripgrep', 'bin'),
    path.join(root, 'app', 'bin'),
  ];
}

function isExe(file) {
  try {
    return fs.existsSync(file) && fs.statSync(file).isFile() && fs.statSync(file).size > 10_000;
  } catch {
    return false;
  }
}

function copyToDests(src) {
  for (const dir of destDirs()) {
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, exe);
    if (path.resolve(src) === path.resolve(dest)) {
      continue;
    }
    fs.copyFileSync(src, dest);
    if (process.platform !== 'win32') {
      fs.chmodSync(dest, 0o755);
    }
  }
}

function existingStaged() {
  for (const dir of destDirs()) {
    const file = path.join(dir, exe);
    if (isExe(file)) {
      return file;
    }
  }
  return null;
}

function localCandidates() {
  const local = process.env.LOCALAPPDATA || '';
  const home = os.homedir();
  const list = [];
  if (process.platform === 'win32') {
    list.push(
      path.join(local, 'Programs', 'cursor', 'resources', 'app', 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg.exe'),
      path.join(local, 'Programs', 'Cursor', 'resources', 'app', 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg.exe'),
      path.join(local, 'Programs', 'Microsoft VS Code', 'resources', 'app', 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg.exe'),
    );
  } else if (process.platform === 'darwin') {
    list.push(
      '/Applications/Cursor.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg',
      '/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg',
    );
  } else {
    list.push(
      path.join(home, '.cursor-server', 'bin', 'rg'),
      '/usr/bin/rg',
      '/usr/local/bin/rg',
    );
  }
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, ['rg'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)[0];
    if (out) {
      list.push(out);
    }
  } catch {
    // not on PATH
  }
  return list;
}

function githubAsset() {
  const arch = process.arch;
  if (process.platform === 'win32') {
    const triple = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
    const name = `ripgrep-${RG_VERSION}-${triple}.zip`;
    return { name, url: `https://github.com/microsoft/ripgrep-prebuilt/releases/download/${RG_VERSION}/${name}` };
  }
  if (process.platform === 'darwin') {
    const triple = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
    const name = `ripgrep-${RG_VERSION}-${triple}.tar.gz`;
    return { name, url: `https://github.com/microsoft/ripgrep-prebuilt/releases/download/${RG_VERSION}/${name}` };
  }
  const triple = arch === 'arm64' ? 'aarch64-unknown-linux-musl' : 'x86_64-unknown-linux-musl';
  const name = `ripgrep-${RG_VERSION}-${triple}.tar.gz`;
  return { name, url: `https://github.com/microsoft/ripgrep-prebuilt/releases/download/${RG_VERSION}/${name}` };
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (current, hops) => {
      if (hops > 8) {
        reject(new Error('too many redirects'));
        return;
      }
      https
        .get(current, { headers: { 'User-Agent': 'olkil-ide' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            follow(res.headers.location, hops + 1);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`download failed (${res.statusCode}) ${current}`));
            return;
          }
          const out = fs.createWriteStream(dest);
          res.pipe(out);
          out.on('finish', () => out.close(() => resolve()));
          out.on('error', reject);
        })
        .on('error', reject);
    };
    follow(url, 0);
  });
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) {
      return full;
    }
    if (entry.isDirectory()) {
      const nested = findFile(full, name);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

function tryOpensumiPostinstall() {
  const script = path.join(root, 'node_modules', '@opensumi', 'vscode-ripgrep', 'lib', 'postinstall.js');
  if (!fs.existsSync(script)) {
    return false;
  }
  try {
    execFileSync(process.execPath, [script], {
      cwd: path.dirname(script),
      stdio: 'inherit',
      timeout: 25_000,
    });
    return isExe(path.join(root, 'node_modules', '@opensumi', 'vscode-ripgrep', 'bin', exe));
  } catch {
    return false;
  }
}

async function fetchRipgrep() {
  if (tryOpensumiPostinstall()) {
    copyToDests(path.join(root, 'node_modules', '@opensumi', 'vscode-ripgrep', 'bin', exe));
    console.log('[ensure-ripgrep] downloaded via vscode-ripgrep postinstall');
    return;
  }
  const { name, url } = githubAsset();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olkil-rg-'));
  try {
    const archive = path.join(tmp, name);
    console.log('[ensure-ripgrep] downloading', url);
    await download(url, archive);
    const extractDir = path.join(tmp, 'out');
    fs.mkdirSync(extractDir, { recursive: true });
    const tarArgs = name.endsWith('.zip') ? ['-xf', archive, '-C', extractDir] : ['-xzf', archive, '-C', extractDir];
    execFileSync('tar', tarArgs, { stdio: 'inherit' });
    const found = findFile(extractDir, exe);
    if (!found) {
      throw new Error(`archive did not contain ${exe}`);
    }
    copyToDests(found);
    console.log('[ensure-ripgrep] installed from GitHub prebuilt');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function ensureRipgrep() {
  const staged = existingStaged();
  if (staged) {
    copyToDests(staged);
    return staged;
  }
  for (const candidate of localCandidates()) {
    if (isExe(candidate)) {
      copyToDests(candidate);
      console.log('[ensure-ripgrep] copied from', candidate);
      return path.join(destDirs()[1], exe);
    }
  }
  execFileSync(process.execPath, [__filename, '--fetch'], {
    stdio: 'inherit',
    timeout: 120_000,
    env: process.env,
  });
  const after = existingStaged();
  if (!after) {
    throw new Error('[ensure-ripgrep] could not find or download rg — Ctrl+Shift+F search will not work');
  }
  return after;
}

module.exports = { ensureRipgrep };

if (require.main === module) {
  if (process.argv.includes('--fetch')) {
    fetchRipgrep().catch((err) => {
      console.error('[ensure-ripgrep]', err && err.message ? err.message : err);
      process.exit(1);
    });
  } else {
    try {
      const file = ensureRipgrep();
      console.log('[ensure-ripgrep] ready', file);
    } catch (err) {
      console.error(err && err.message ? err.message : err);
      process.exit(1);
    }
  }
}
