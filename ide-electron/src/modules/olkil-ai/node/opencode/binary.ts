import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const EXE = process.platform === 'win32' ? 'opencode.exe' : 'opencode';

function existsFile(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function walkForBinary(dir: string, depth = 0): string | undefined {
  if (depth > 3 || !dir) {
    return undefined;
  }
  try {
    const direct = path.join(dir, EXE);
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
      if (stat.isFile() && name === EXE) {
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

/**
 * Locate the official OpenCode CLI binary. Never loads OpenCode source into
 * Electron — the binary is spawned as an isolated sidecar.
 */
export function resolveOpencodeBinary(): string | undefined {
  const envPath = process.env.OLKIL_OPENCODE_BIN || process.env.OPENCODE_BIN;
  if (envPath && existsFile(envPath)) {
    return envPath;
  }

  const dirs: string[] = [];
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    dirs.push(path.join(resourcesPath, 'opencode'));
  }
  try {
    dirs.push(path.join(path.dirname(process.execPath), 'resources', 'opencode'));
  } catch {
    // ignore
  }
  dirs.push(path.join(__dirname, '..', 'opencode'));
  dirs.push(path.join(__dirname, '..', '..', 'opencode'));
  dirs.push(path.join(process.cwd(), 'build', 'opencode'));
  dirs.push(path.join(__dirname, '..', '..', 'build', 'opencode'));
  dirs.push(path.join(__dirname, '..', '..', '..', 'build', 'opencode'));
  dirs.push(path.join(os.homedir(), '.opencode', 'bin'));
  dirs.push(path.join(os.homedir(), 'bin'));

  for (const dir of dirs) {
    const found = walkForBinary(dir);
    if (found) {
      return found;
    }
  }

  const vendor = path.join(__dirname, '..', '..', '..', '..', 'vendor', 'opencode-bin');
  const fromVendor = walkForBinary(path.resolve(vendor));
  if (fromVendor) {
    return fromVendor;
  }

  return undefined;
}

export function opencodeBinaryName(): string {
  return EXE;
}
