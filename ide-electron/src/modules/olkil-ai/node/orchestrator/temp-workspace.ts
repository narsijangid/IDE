import * as fs from 'fs';
import * as path from 'path';

const TEMP_NAME =
  /^_?(revert_|tmp_|temp_|olkil_|agent_)[\w.-]+\.(py|js|mjs|cjs|ts|ps1|sh|bat|cmd)$/i;

export function olkilDir(workspaceRoot: string, ...parts: string[]): string {
  return path.join(workspaceRoot, '.olkil', ...parts);
}

export function ensureOlkilLayout(workspaceRoot: string): { temp: string; sessions: string; cache: string; index: string } {
  const dirs = {
    temp: olkilDir(workspaceRoot, 'temp'),
    sessions: olkilDir(workspaceRoot, 'sessions'),
    cache: olkilDir(workspaceRoot, 'cache'),
    index: olkilDir(workspaceRoot, 'index'),
  };
  for (const dir of Object.values(dirs)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const gitignore = path.join(workspaceRoot, '.olkil', '.gitignore');
  if (!fs.existsSync(gitignore)) {
    try {
      fs.writeFileSync(gitignore, '*\n', 'utf8');
    } catch {
      // ignore
    }
  }
  return dirs;
}

export function isTempScriptName(filePath: string): boolean {
  const base = path.basename(filePath);
  return TEMP_NAME.test(base);
}

export function relocateTempScript(workspaceRoot: string, requestedPath: string, runId?: string): string {
  const abs = path.isAbsolute(requestedPath)
    ? path.normalize(requestedPath)
    : path.resolve(workspaceRoot, requestedPath);
  if (!isTempScriptName(abs)) {
    return abs;
  }
  const rel = path.relative(workspaceRoot, abs);
  const atRoot = !rel.includes(path.sep) && !rel.includes('/');
  const alreadyInOlkil = rel.replace(/\\/g, '/').startsWith('.olkil/');
  if (!atRoot || alreadyInOlkil) {
    return abs;
  }
  const { temp } = ensureOlkilLayout(workspaceRoot);
  const dest = path.join(temp, runId || 'session', path.basename(abs));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  return dest;
}

export function cleanupRunTemp(workspaceRoot: string, runId: string) {
  const dir = olkilDir(workspaceRoot, 'temp', runId);
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }
}

export function cleanupStaleTemp(workspaceRoot: string, maxAgeMs = 24 * 60 * 60 * 1000) {
  const root = olkilDir(workspaceRoot, 'temp');
  try {
    if (!fs.existsSync(root)) return;
    const now = Date.now();
    for (const name of fs.readdirSync(root)) {
      const full = path.join(root, name);
      try {
        const st = fs.statSync(full);
        if (now - st.mtimeMs > maxAgeMs) {
          fs.rmSync(full, { recursive: true, force: true });
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}
