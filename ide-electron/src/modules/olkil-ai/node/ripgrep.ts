/**
 * Livegrep/Zoekt-class exact search using the ripgrep binary that OpenSumi
 * already ships (rg.exe). Native SIMD scanning beats any JS index walk for
 * verified substring/regex matches, and respects .gitignore for free.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

export interface RipgrepMatch {
  path: string;
  line: number;
  text: string;
}

export interface RipgrepResult {
  engine: 'ripgrep' | 'unavailable';
  query: string;
  elapsedMs: number;
  truncated: boolean;
  matches: RipgrepMatch[];
}

let cachedBinary: string | null | undefined;

export function ripgrepBinary(): string | null {
  if (cachedBinary !== undefined) return cachedBinary;
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const candidates = [
    // packaged app layout (build copies to app/bin next to node bundle)
    path.join(__dirname, '..', 'bin', exe),
    path.join(__dirname, 'bin', exe),
    // dev layout
    path.join(__dirname, '..', '..', 'node_modules', '@opensumi', 'vscode-ripgrep', 'bin', exe),
    path.join(process.cwd(), 'node_modules', '@opensumi', 'vscode-ripgrep', 'bin', exe),
  ];
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rgModule = require('@opensumi/vscode-ripgrep');
    if (rgModule?.rgPath) candidates.unshift(rgModule.rgPath);
  } catch {
    // module unavailable in packaged bundle; fall through to path probing
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        cachedBinary = candidate;
        return candidate;
      }
    } catch {
      // keep probing
    }
  }
  cachedBinary = null;
  return null;
}

export function ripgrepSearch(
  root: string,
  query: string,
  options?: {
    maxResults?: number;
    regex?: boolean;
    caseSensitive?: boolean;
    timeoutMs?: number;
    globs?: string[];
  },
): Promise<RipgrepResult> {
  const binary = ripgrepBinary();
  const started = Date.now();
  const maxResults = Math.max(1, Math.min(500, options?.maxResults ?? 60));
  if (!binary || !query.trim() || !root) {
    return Promise.resolve({
      engine: 'unavailable',
      query,
      elapsedMs: 0,
      truncated: false,
      matches: [],
    });
  }

  const args = [
    '--line-number',
    '--no-heading',
    '--color', 'never',
    '--max-columns', '400',
    '--max-columns-preview',
    '--max-filesize', '2M',
    '--max-count', '40',
    '--threads', '4',
    ...(options?.caseSensitive ? [] : ['--ignore-case']),
    ...(options?.regex ? [] : ['--fixed-strings']),
  ];
  for (const glob of options?.globs || []) {
    args.push('--glob', glob);
  }
  // Never index build artifacts even outside git repos.
  for (const skip of ['node_modules', 'dist', 'build', 'out', '.git', 'coverage', '__pycache__']) {
    args.push('--glob', `!**/${skip}/**`);
  }
  args.push('--', query, '.');

  return new Promise((resolve) => {
    const child = spawn(binary, args, { cwd: root, windowsHide: true });
    const matches: RipgrepMatch[] = [];
    let buffer = '';
    let truncated = false;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({
        engine: 'ripgrep',
        query,
        elapsedMs: Date.now() - started,
        truncated,
        matches: matches.slice(0, maxResults),
      });
    };

    const timeout = setTimeout(() => {
      truncated = true;
      try { child.kill(); } catch { /* already dead */ }
      finish();
    }, Math.max(1000, options?.timeoutMs ?? 6000));

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line) continue;
        // Windows paths contain a drive colon only when absolute; rg with cwd
        // emits relative paths, so the first two colons split path:line:text.
        const first = line.indexOf(':');
        const second = line.indexOf(':', first + 1);
        if (first <= 0 || second <= first) continue;
        const lineNumber = Number(line.slice(first + 1, second));
        if (!Number.isFinite(lineNumber)) continue;
        matches.push({
          path: line.slice(0, first).replace(/\\/g, '/'),
          line: lineNumber,
          text: line.slice(second + 1).trim().slice(0, 240),
        });
        if (matches.length >= maxResults) {
          truncated = true;
          try { child.kill(); } catch { /* already dead */ }
          clearTimeout(timeout);
          finish();
          return;
        }
      }
    });
    child.on('error', () => {
      clearTimeout(timeout);
      finish();
    });
    child.on('close', () => {
      clearTimeout(timeout);
      finish();
    });
  });
}
