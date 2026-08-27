/**
 * Locate or download the OpenCode sidecar binary.
 *
 * Production installers do NOT embed the ~170MB binary (keeps Setup.exe fast).
 * First launch downloads it into ~/.olkil/opencode-bin in the background.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';

export const OPENCODE_VERSION = process.env.OPENCODE_VERSION || 'v1.18.21';
export const OPENCODE_EXE = process.platform === 'win32' ? 'opencode.exe' : 'opencode';

const MIN_BYTES = 5 * 1024 * 1024;

let inflight: Promise<string> | null = null;

function existsFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size >= MIN_BYTES;
  } catch {
    return false;
  }
}

function walkForBinary(dir: string, depth = 0): string | undefined {
  if (depth > 3 || !dir) {
    return undefined;
  }
  try {
    const direct = path.join(dir, OPENCODE_EXE);
    if (existsFile(direct)) {
      return direct;
    }
    for (const name of fs.readdirSync(dir)) {
      const child = path.join(dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(child);
      } catch {
        continue;
      }
      if (stat.isFile() && name === OPENCODE_EXE && stat.size >= MIN_BYTES) {
        return child;
      }
      if (stat.isDirectory() && !name.startsWith('.')) {
        const nested = walkForBinary(child, depth + 1);
        if (nested) {
          return nested;
        }
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

export function opencodeCacheDir(): string {
  return path.join(os.homedir(), '.olkil', 'opencode-bin');
}

export function opencodeCacheBinary(): string {
  return path.join(opencodeCacheDir(), OPENCODE_EXE);
}

function resourceDirs(): string[] {
  const dirs: string[] = [];
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    dirs.push(path.join(resourcesPath, 'opencode'));
  }
  try {
    const execDir = path.dirname(process.execPath);
    dirs.push(path.join(execDir, 'resources', 'opencode'));
    dirs.push(path.join(execDir, '..', 'Resources', 'opencode'));
  } catch {
    // ignore
  }
  dirs.push(path.join(__dirname, '..', 'opencode'));
  dirs.push(path.join(__dirname, '..', '..', 'opencode'));
  dirs.push(path.join(__dirname, '..', '..', '..', 'opencode'));
  dirs.push(path.join(process.cwd(), 'build', 'opencode'));
  dirs.push(opencodeCacheDir());
  dirs.push(path.join(os.homedir(), '.opencode', 'bin'));
  return dirs;
}

export function resolveOpencodeBinary(): string | undefined {
  const envPath = process.env.OLKIL_OPENCODE_BIN || process.env.OPENCODE_BIN;
  if (envPath && existsFile(envPath)) {
    return envPath;
  }
  for (const dir of resourceDirs()) {
    const found = walkForBinary(dir);
    if (found) {
      return found;
    }
  }
  return undefined;
}

export function opencodeBinaryName(): string {
  return OPENCODE_EXE;
}

function assetName(): string {
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

function download(url: string, dest: string, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirects > 8) {
      reject(new Error(`Too many redirects for ${url}`));
      return;
    }
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'olkil-opencode' } }, (res) => {
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
      const total = Number(res.headers['content-length'] || 0);
      let received = 0;
      let lastPct = -1;
      const out = fs.createWriteStream(dest);
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (total > 0) {
          const pct = Math.round((received / total) * 100);
          if (pct !== lastPct && (pct === 0 || pct === 100 || pct % 10 === 0)) {
            lastPct = pct;
            console.log(`[olkil-opencode] download ${pct}%`);
          }
        }
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(10 * 60 * 1000, () => {
      req.destroy(new Error('OpenCode download timed out'));
    });
  });
}

function extractArchive(archive: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  if (process.platform === 'win32') {
    const ps = `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${dest.replace(
      /'/g,
      "''",
    )}' -Force`;
    execSync(`powershell -NoProfile -NonInteractive -Command "${ps}"`, { stdio: 'ignore', timeout: 120000 });
    return;
  }
  if (archive.endsWith('.tar.gz') || archive.endsWith('.tgz')) {
    execSync(`tar -xzf "${archive}" -C "${dest}"`, { stdio: 'ignore' });
    return;
  }
  execSync(`unzip -o "${archive}" -d "${dest}"`, { stdio: 'ignore' });
}

function writeStatus(state: string, extra: Record<string, unknown> = {}): void {
  try {
    const file = path.join(opencodeCacheDir(), '.status.json');
    fs.mkdirSync(opencodeCacheDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ state, at: Date.now(), ...extra }), 'utf8');
  } catch {
    // ignore
  }
}

async function downloadIntoCache(): Promise<string> {
  const destDir = opencodeCacheDir();
  const destBin = opencodeCacheBinary();
  fs.mkdirSync(destDir, { recursive: true });
  if (existsFile(destBin)) {
    process.env.OLKIL_OPENCODE_BIN = destBin;
    return destBin;
  }

  const lock = path.join(destDir, '.download.lock');
  const now = Date.now();
  try {
    const age = now - fs.statSync(lock).mtimeMs;
    if (age < 12 * 60 * 1000) {
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (existsFile(destBin)) {
          process.env.OLKIL_OPENCODE_BIN = destBin;
          return destBin;
        }
      }
    }
  } catch {
    // no lock
  }
  fs.writeFileSync(lock, String(process.pid), 'utf8');
  writeStatus('downloading', { version: OPENCODE_VERSION });

  const name = assetName();
  const url = `https://github.com/anomalyco/opencode/releases/download/${OPENCODE_VERSION}/${name}`;
  const tmp = path.join(os.tmpdir(), `olkil-${name}`);
  const extractDir = path.join(destDir, '.extract');
  try {
    console.log('[olkil-opencode] downloading', url);
    await download(url, tmp);
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
    extractArchive(tmp, extractDir);
    const found = walkForBinary(extractDir);
    if (!found) {
      throw new Error(`Extracted OpenCode archive but ${OPENCODE_EXE} was missing`);
    }
    fs.copyFileSync(found, destBin);
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(destBin, 0o755);
      } catch {
        // ignore
      }
    }
    if (!existsFile(destBin)) {
      throw new Error('OpenCode binary was not written');
    }
    writeStatus('ready', { version: OPENCODE_VERSION, path: destBin });
    process.env.OLKIL_OPENCODE_BIN = destBin;
    console.log('[olkil-opencode] ready', destBin);
    return destBin;
  } catch (err) {
    writeStatus('error', { message: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    try {
      fs.rmSync(extractDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

/** Resolve immediately, or download into the user cache. Safe to call from main + node. */
export function ensureOpencodeBinary(): Promise<string> {
  const existing = resolveOpencodeBinary();
  if (existing) {
    process.env.OLKIL_OPENCODE_BIN = existing;
    return Promise.resolve(existing);
  }
  if (!inflight) {
    inflight = downloadIntoCache().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

export function startOpencodeDownload(): void {
  void ensureOpencodeBinary().catch((err) => {
    console.warn('[olkil-opencode] background download failed', err instanceof Error ? err.message : err);
  });
}
