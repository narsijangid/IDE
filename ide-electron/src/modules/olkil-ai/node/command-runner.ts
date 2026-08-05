import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import {
  CommandRunRequest,
  CommandRunResult,
  DevServerDetectResult,
} from '../common';

interface RunningCommand {
  id: string;
  command: string;
  cwd: string;
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
  startedAt: number;
  exitCode: number | null;
  background: boolean;
}

const MAX_LOG_CHARS = 80_000;
const MAX_LINES = 400;

const BLOCKED = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\b/,
  /\bdel\s+\/[sf]\b/i,
  /\bformat\s+[a-z]:/i,
  /\bmkfs\b/,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bRemove-Item\b.*-Recurse.*\bC:\\/i,
  /\bcurl\b.*\|\s*(ba)?sh\b/i,
];

function nextId(): string {
  return `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function pushCapped(buf: string[], chunk: string) {
  for (const line of chunk.split(/\r?\n/)) {
    if (!line && buf.length === 0) {
      continue;
    }
    buf.push(line);
  }
  while (buf.length > MAX_LINES) {
    buf.shift();
  }
}

function joinLog(lines: string[]): string {
  let text = lines.join('\n');
  if (text.length > MAX_LOG_CHARS) {
    text = `…(truncated)\n${text.slice(-MAX_LOG_CHARS)}`;
  }
  return text;
}

/** Parse common Vite/Next/Webpack/CRA ready URLs from process output. */
export function extractLocalUrls(text: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+\S*/gi,
    /Local:\s*(https?:\/\/\S+)/gi,
    /Network:\s*(https?:\/\/\S+)/gi,
    /ready on\s+(https?:\/\/\S+)/gi,
    /started server on.+(https?:\/\/\S+)/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      let url = (m[1] || m[0]).replace(/[),.;]+$/, '');
      url = url.replace('0.0.0.0', '127.0.0.1');
      if (/^https?:\/\/(localhost|127\.0\.0\.1):\d+/i.test(url)) {
        found.add(url.replace(/\/$/, ''));
      }
    }
  }
  // bare "localhost:3000"
  const bare = text.match(/\b(?:localhost|127\.0\.0\.1):(\d{2,5})\b/g);
  if (bare) {
    for (const hit of bare) {
      found.add(`http://${hit.replace('0.0.0.0', '127.0.0.1')}`);
    }
  }
  return [...found];
}

export class CommandRunner {
  private processes = new Map<string, RunningCommand>();

  detectDevServer(workspaceRoot: string): DevServerDetectResult {
    const root = workspaceRoot || process.cwd();
    const pkgPath = path.join(root, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      return {
        root,
        packageManager: this.detectPackageManager(root),
        scripts: [],
        recommendedCommand: null,
        suggestedUrls: ['http://127.0.0.1:3000', 'http://127.0.0.1:5173'],
        frameworkHints: [],
        error: 'No package.json found in workspace root',
      };
    }

    let pkg: any = {};
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch {
      return {
        root,
        packageManager: this.detectPackageManager(root),
        scripts: [],
        recommendedCommand: null,
        suggestedUrls: ['http://127.0.0.1:3000'],
        frameworkHints: [],
        error: 'package.json is not valid JSON',
      };
    }

    const scripts = Object.keys(pkg.scripts || {});
    const deps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
    };
    const hints: string[] = [];
    if (deps.next) {
      hints.push('next');
    }
    if (deps.vite || deps['@vitejs/plugin-react']) {
      hints.push('vite');
    }
    if (deps['react-scripts']) {
      hints.push('cra');
    }
    if (deps.nuxt) {
      hints.push('nuxt');
    }
    if (deps['@angular/core']) {
      hints.push('angular');
    }
    if (deps.express || deps.fastify || deps.koa) {
      hints.push('node-server');
    }

    const pm = this.detectPackageManager(root);
    const run = (script: string) =>
      pm === 'yarn' ? `yarn ${script}` : pm === 'pnpm' ? `pnpm ${script}` : `npm run ${script}`;

    const preference = ['dev', 'start:dev', 'develop', 'serve', 'start', 'preview'];
    let recommended: string | null = null;
    for (const name of preference) {
      if (scripts.includes(name)) {
        recommended = run(name);
        break;
      }
    }

    const suggestedUrls = hints.includes('vite')
      ? ['http://127.0.0.1:5173', 'http://127.0.0.1:4173', 'http://127.0.0.1:3000']
      : hints.includes('next')
        ? ['http://127.0.0.1:3000', 'http://127.0.0.1:3001']
        : ['http://127.0.0.1:3000', 'http://127.0.0.1:5173', 'http://127.0.0.1:8080'];

    return {
      root,
      packageManager: pm,
      scripts,
      recommendedCommand: recommended,
      suggestedUrls,
      frameworkHints: hints,
    };
  }

  private detectPackageManager(root: string): 'npm' | 'yarn' | 'pnpm' {
    if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) {
      return 'pnpm';
    }
    if (fs.existsSync(path.join(root, 'yarn.lock'))) {
      return 'yarn';
    }
    return 'npm';
  }

  run(request: CommandRunRequest): Promise<CommandRunResult> {
    const cwd = path.resolve(request.cwd || process.cwd());
    const command = (request.command || '').trim();
    if (!command) {
      return Promise.resolve({
        id: '',
        command: '',
        cwd,
        background: false,
        running: false,
        exitCode: 1,
        stdout: '',
        stderr: 'Empty command',
        urls: [],
        error: 'Empty command',
      });
    }

    for (const re of BLOCKED) {
      if (re.test(command)) {
        return Promise.resolve({
          id: '',
          command,
          cwd,
          background: false,
          running: false,
          exitCode: 1,
          stdout: '',
          stderr: 'Blocked dangerous command',
          urls: [],
          error: 'Command blocked by OLKIL safety policy',
        });
      }
    }

    if (!fs.existsSync(cwd)) {
      return Promise.resolve({
        id: '',
        command,
        cwd,
        background: false,
        running: false,
        exitCode: 1,
        stdout: '',
        stderr: `cwd does not exist: ${cwd}`,
        urls: [],
        error: `cwd does not exist: ${cwd}`,
      });
    }

    const id = nextId();
    const background = Boolean(request.background);
    const timeoutMs = Math.min(Math.max(request.timeoutMs ?? (background ? 0 : 60_000), 0), 300_000);

    const isWin = process.platform === 'win32';
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        npm_config_yes: 'true',
        BROWSER: 'none', // prevent CRA opening system browser
      },
    }) as ChildProcessWithoutNullStreams;

    const entry: RunningCommand = {
      id,
      command,
      cwd,
      child,
      stdout: [],
      stderr: [],
      startedAt: Date.now(),
      exitCode: null,
      background,
    };
    this.processes.set(id, entry);

    child.stdout.on('data', (buf: Buffer) => pushCapped(entry.stdout, buf.toString('utf8')));
    child.stderr.on('data', (buf: Buffer) => pushCapped(entry.stderr, buf.toString('utf8')));
    child.on('error', (err) => {
      pushCapped(entry.stderr, err.message);
      entry.exitCode = 1;
    });
    child.on('close', (code) => {
      entry.exitCode = code ?? 1;
    });

    if (background) {
      // Brief settle so early banner lines (Vite/Next) are captured.
      return new Promise((resolve) => {
        setTimeout(() => {
          const combined = `${joinLog(entry.stdout)}\n${joinLog(entry.stderr)}`;
          resolve({
            id,
            command,
            cwd,
            background: true,
            running: entry.exitCode === null,
            exitCode: entry.exitCode,
            stdout: joinLog(entry.stdout),
            stderr: joinLog(entry.stderr),
            urls: extractLocalUrls(combined),
            pid: child.pid,
          });
        }, Math.min(request.settleMs ?? 1800, 8000));
      });
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        const combined = `${joinLog(entry.stdout)}\n${joinLog(entry.stderr)}`;
        resolve({
          id,
          command,
          cwd,
          background: false,
          running: false,
          exitCode: entry.exitCode,
          stdout: joinLog(entry.stdout),
          stderr: joinLog(entry.stderr),
          urls: extractLocalUrls(combined),
          pid: child.pid,
        });
        // Keep short-lived entries briefly for getCommandOutput, then GC.
        setTimeout(() => this.processes.delete(id), 60_000);
      };

      child.on('close', finish);
      if (timeoutMs > 0) {
        setTimeout(() => {
          if (entry.exitCode === null) {
            try {
              if (isWin) {
                spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
              } else {
                child.kill('SIGTERM');
              }
            } catch {
              // ignore
            }
            pushCapped(entry.stderr, `Timed out after ${timeoutMs}ms`);
            entry.exitCode = entry.exitCode ?? 124;
            finish();
          }
        }, timeoutMs);
      }
    });
  }

  getOutput(id: string): CommandRunResult | null {
    const entry = this.processes.get(id);
    if (!entry) {
      return null;
    }
    const combined = `${joinLog(entry.stdout)}\n${joinLog(entry.stderr)}`;
    return {
      id: entry.id,
      command: entry.command,
      cwd: entry.cwd,
      background: entry.background,
      running: entry.exitCode === null,
      exitCode: entry.exitCode,
      stdout: joinLog(entry.stdout),
      stderr: joinLog(entry.stderr),
      urls: extractLocalUrls(combined),
      pid: entry.child.pid,
      elapsedMs: Date.now() - entry.startedAt,
    };
  }

  stop(id: string): boolean {
    const entry = this.processes.get(id);
    if (!entry) {
      return false;
    }
    try {
      if (process.platform === 'win32' && entry.child.pid) {
        spawn('taskkill', ['/pid', String(entry.child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        entry.child.kill('SIGTERM');
      }
    } catch {
      return false;
    }
    return true;
  }

  list(): Array<{ id: string; command: string; running: boolean; urls: string[] }> {
    return [...this.processes.values()].map((e) => {
      const combined = `${joinLog(e.stdout)}\n${joinLog(e.stderr)}`;
      return {
        id: e.id,
        command: e.command,
        running: e.exitCode === null,
        urls: extractLocalUrls(combined),
      };
    });
  }
}
