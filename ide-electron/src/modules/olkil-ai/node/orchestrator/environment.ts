import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import type { EnvironmentInfo } from './types';

const envCache = new Map<string, EnvironmentInfo>();

function run(cmd: string, args: string[], cwd?: string, timeout = 2500): string {
  try {
    const result = spawnSync(cmd, args, {
      cwd,
      timeout,
      encoding: 'utf8',
      windowsHide: true,
      env: process.env,
    });
    if (result.error || result.status !== 0) {
      return '';
    }
    return (result.stdout || '').trim();
  } catch {
    return '';
  }
}

export function findGitRoot(start: string): string | undefined {
  if (!start) return undefined;
  let dir = path.resolve(start);
  for (let i = 0; i < 28; i++) {
    try {
      if (fs.existsSync(path.join(dir, '.git'))) {
        return dir;
      }
    } catch {
      // ignore
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function detectPackageManager(root: string): string | undefined {
  try {
    if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
    if (fs.existsSync(path.join(root, 'bun.lockb')) || fs.existsSync(path.join(root, 'bun.lock'))) {
      return 'bun';
    }
    if (fs.existsSync(path.join(root, 'package-lock.json')) || fs.existsSync(path.join(root, 'package.json'))) {
      return 'npm';
    }
    if (fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'requirements.txt'))) {
      return 'pip';
    }
    if (fs.existsSync(path.join(root, 'go.mod'))) return 'go';
    if (fs.existsSync(path.join(root, 'Cargo.toml'))) return 'cargo';
  } catch {
    // ignore
  }
  return undefined;
}

function detectProjectType(root: string): string | undefined {
  const hints: string[] = [];
  const has = (rel: string) => {
    try {
      return fs.existsSync(path.join(root, rel));
    } catch {
      return false;
    }
  };
  if (has('package.json')) hints.push('node');
  if (has('tsconfig.json')) hints.push('typescript');
  if (has('angular.json')) hints.push('angular');
  if (has('next.config.js') || has('next.config.ts')) hints.push('next');
  if (has('vite.config.ts') || has('vite.config.js')) hints.push('vite');
  if (has('pom.xml') || has('build.gradle')) hints.push('java');
  if (has('pyproject.toml') || has('requirements.txt')) hints.push('python');
  if (has('go.mod')) hints.push('go');
  return hints.length ? hints.join('+') : undefined;
}

function detectShell(): { shell: string; kind: EnvironmentInfo['shellKind'] } {
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec || '';
    if (/powershell/i.test(process.env.SHELL || '') || /pwsh/i.test(process.env.PSModulePath || '')) {
      const pwsh = run('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']);
      if (pwsh) return { shell: 'pwsh', kind: 'powershell' };
      return { shell: 'powershell', kind: 'powershell' };
    }
    if (/cmd\.exe/i.test(comspec)) {
      return { shell: comspec, kind: 'cmd' };
    }
    return { shell: 'powershell', kind: 'powershell' };
  }
  const sh = process.env.SHELL || '/bin/bash';
  return { shell: sh, kind: 'bash' };
}

function detectPython(): string | undefined {
  for (const cmd of process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python']) {
    const args = cmd === 'py' ? ['-3', '--version'] : ['--version'];
    const out = run(cmd, args);
    if (out) return cmd === 'py' ? 'py -3' : cmd;
  }
  return undefined;
}

export function detectEnvironment(workspaceRoot: string): EnvironmentInfo {
  const key = path.resolve(workspaceRoot || '') || 'none';
  const cached = envCache.get(key);
  if (cached && Date.now() - cached.detectedAt < 10 * 60_000) {
    return cached;
  }
  const { shell, kind } = detectShell();
  const gitRoot = findGitRoot(workspaceRoot);
  const info: EnvironmentInfo = {
    os: process.platform,
    osRelease: os.release(),
    arch: os.arch(),
    shell,
    shellKind: kind,
    powershellVersion:
      kind === 'powershell'
        ? run(shell === 'pwsh' ? 'pwsh' : 'powershell', [
            '-NoProfile',
            '-Command',
            '$PSVersionTable.PSVersion.ToString()',
          ]) || undefined
        : undefined,
    nodeVersion: process.versions.node,
    python: detectPython(),
    git: run('git', ['--version']) ? 'git' : undefined,
    gitRoot,
    packageManager: workspaceRoot ? detectPackageManager(workspaceRoot) : undefined,
    projectType: workspaceRoot ? detectProjectType(workspaceRoot) : undefined,
    detectedAt: Date.now(),
  };
  envCache.set(key, info);
  return info;
}

export function formatEnvironment(info: EnvironmentInfo): string {
  const ps =
    info.shellKind === 'powershell'
      ? info.powershellVersion && /^[12345]\./.test(info.powershellVersion)
        ? `PowerShell ${info.powershellVersion} (Windows PowerShell 5.x — do NOT use Join-String; use [string]::Join. Prefer ';' over '&&'. )`
        : `PowerShell ${info.powershellVersion || ''}`.trim()
      : info.shellKind;
  return [
    `OS=${info.os} ${info.osRelease} ${info.arch}`,
    `shell=${ps}`,
    `node=${info.nodeVersion || 'n/a'}`,
    `python=${info.python || 'not found'}`,
    `git=${info.git || 'not found'}`,
    `gitRoot=${info.gitRoot || '(not a git checkout from workspace — find the real .git parent)'}`,
    `packageManager=${info.packageManager || 'unknown'}`,
    `projectType=${info.projectType || 'unknown'}`,
  ].join('\n');
}

export function powershellJoinHint(info: EnvironmentInfo): boolean {
  return (
    info.shellKind === 'powershell' &&
    Boolean(info.powershellVersion && /^[12345]\./.test(info.powershellVersion))
  );
}
