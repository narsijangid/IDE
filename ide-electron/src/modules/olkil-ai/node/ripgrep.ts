/**
 * Livegrep/Zoekt-class exact search using the ripgrep binary that OpenSumi
 * already ships (rg.exe). Extreme-perf layer:
 * - sticky LRU result cache (agent re-greps same UI labels constantly)
 * - adaptive thread count from CPU cores
 * - early kill once maxResults filled
 * - short default timeout (Cursor-class snappy searches)
 */
import * as fs from 'fs';
import * as os from 'os';
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
  cached?: boolean;
}

let cachedBinary: string | null | undefined;

const RESULT_CACHE = new Map<string, { at: number; result: RipgrepResult }>();
const RESULT_CACHE_TTL_MS = 45_000;
const RESULT_CACHE_MAX = 256;

function adaptiveThreads(): number {
  const n = os.cpus()?.length || 4;
  return Math.max(4, Math.min(16, n));
}

function cacheKey(
  root: string,
  query: string,
  options?: {
    maxResults?: number;
    regex?: boolean;
    caseSensitive?: boolean;
    globs?: string[];
  },
): string {
  return [
    root.toLowerCase(),
    query,
    options?.maxResults ?? 60,
    options?.regex ? 1 : 0,
    options?.caseSensitive ? 1 : 0,
    (options?.globs || []).join(','),
  ].join('|');
}

/** Drop sticky rg results when files change under a workspace. */
export function invalidateRipgrepCache(root?: string): void {
  if (!root) {
    RESULT_CACHE.clear();
    return;
  }
  const prefix = root.toLowerCase();
  for (const key of [...RESULT_CACHE.keys()]) {
    if (key.startsWith(prefix)) {
      RESULT_CACHE.delete(key);
    }
  }
}

export function ripgrepBinary(): string | null {
  if (cachedBinary !== undefined) return cachedBinary;
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const candidates = [
    path.join(__dirname, '..', 'bin', exe),
    path.join(__dirname, 'bin', exe),
    path.join(__dirname, '..', '..', 'node_modules', '@opensumi', 'vscode-ripgrep', 'bin', exe),
    path.join(process.cwd(), 'node_modules', '@opensumi', 'vscode-ripgrep', 'bin', exe),
  ];
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rgModule = require('@opensumi/vscode-ripgrep');
    if (rgModule?.rgPath) candidates.unshift(rgModule.rgPath);
  } catch {
    // packaged probe
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

  const key = cacheKey(root, query, options);
  const hit = RESULT_CACHE.get(key);
  if (hit && Date.now() - hit.at < RESULT_CACHE_TTL_MS) {
    return Promise.resolve({
      ...hit.result,
      elapsedMs: Date.now() - started,
      cached: true,
    });
  }

  const args = [
    '--line-number',
    '--no-heading',
    '--color',
    'never',
    '--max-columns',
    '400',
    '--max-columns-preview',
    '--max-filesize',
    '2M',
    '--max-count',
    '24',
    '--threads',
    String(adaptiveThreads()),
    ...(options?.caseSensitive ? [] : ['--ignore-case']),
    ...(options?.regex ? [] : ['--fixed-strings']),
  ];
  for (const glob of options?.globs || []) {
    args.push('--glob', glob);
  }
  for (const skip of [
    'node_modules',
    'dist',
    'build',
    'out',
    '.git',
    'coverage',
    '__pycache__',
    '.next',
    '.nuxt',
    'vendor',
    'target',
  ]) {
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
      const result: RipgrepResult = {
        engine: 'ripgrep',
        query,
        elapsedMs: Date.now() - started,
        truncated,
        matches: matches.slice(0, maxResults),
      };
      if (RESULT_CACHE.size >= RESULT_CACHE_MAX) {
        const oldest = RESULT_CACHE.keys().next().value;
        if (oldest !== undefined) RESULT_CACHE.delete(oldest);
      }
      RESULT_CACHE.set(key, { at: Date.now(), result });
      resolve(result);
    };

    const timeout = setTimeout(() => {
      truncated = true;
      try {
        child.kill();
      } catch {
        /* already dead */
      }
      finish();
    }, Math.max(400, options?.timeoutMs ?? 2500));

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line) continue;
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
          try {
            child.kill();
          } catch {
            /* already dead */
          }
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
