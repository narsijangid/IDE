export interface FailedCommand {
  command: string;
  error: string;
  suggestion?: string;
  at: number;
}

const MAX = 40;

export class FailedCommandMemory {
  private items: FailedCommand[] = [];

  remember(command: string, error: string, suggestion?: string) {
    const normalized = normalizeCommand(command);
    this.items = this.items.filter((item) => item.command !== normalized);
    this.items.push({ command: normalized, error, suggestion, at: Date.now() });
    if (this.items.length > MAX) this.items.shift();
  }

  lookup(command: string): FailedCommand | undefined {
    const normalized = normalizeCommand(command);
    return this.items.find((item) => item.command === normalized);
  }

  suggestRewrite(command: string, error: string, env?: { powershellLegacy?: boolean; python?: string; gitRoot?: string }): string | undefined {
    const lower = `${command}\n${error}`.toLowerCase();
    if (/\bjoin-string\b/i.test(command) || /join-string/i.test(error)) {
      return command.replace(/\bJoin-String\b/gi, "[string]::Join(' ', @(").replace(/\)$/, '))');
    }
    if (env?.powershellLegacy && /&&/.test(command) && /parsererror|token|syntax/i.test(error)) {
      return command.replace(/\s*&&\s*/g, '; ');
    }
    if (/python(3)?(\.exe)? is (not recognized|not found)|can't open file|python: command not found/i.test(error)) {
      if (env?.python && !command.trim().startsWith(env.python)) {
        return command.replace(/^\s*python3?(\.exe)?\b/i, env.python);
      }
    }
    if (/not a git repository|not a git repo/i.test(error) && env?.gitRoot) {
      if (!/\bgit\s+-C\s+/i.test(command) && /^\s*git\b/i.test(command)) {
        return command.replace(/^\s*git\b/i, `git -C "${env.gitRoot}"`);
      }
    }
    if (/is not recognized as (an internal|a cmdlet)|command not found/i.test(error) && /join-string/i.test(lower)) {
      return "[string]::Join(' ', (...))";
    }
    return undefined;
  }
}

export function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim();
}

export function rewriteKnownBadCommand(
  command: string,
  env?: { powershellLegacy?: boolean; python?: string; gitRoot?: string },
): string {
  let next = command;
  if (env?.powershellLegacy) {
    next = next.replace(
      /([^|\n]+?)\s*\|\s*Join-String(?:\s+-Separator\s+(['"])(.*?)\2)?/gi,
      (_m, expr, _q, sep) => `[string]::Join('${sep || ' '}', @(${String(expr).trim()}))`,
    );
    if (/\bJoin-String\b/i.test(next)) {
      next = next.replace(/\bJoin-String\b/gi, '[string]::Join');
    }
    if (/\s&&\s/.test(next)) {
      next = next.replace(/\s*&&\s*/g, '; ');
    }
  }
  if (env?.python && /^\s*python3?\b/i.test(next) && env.python !== 'python' && env.python !== 'python3') {
    next = next.replace(/^\s*python3?\b/i, env.python);
  }
  if (env?.gitRoot && /^\s*git\b/i.test(next) && !/\bgit\s+-C\s+/i.test(next) && !/\b--git-dir\b/i.test(next)) {
    // Only inject -C when the command looks repo-relative (status/diff/log/blame).
    if (/\bgit\s+(status|diff|log|blame|show|rev-parse|ls-files)\b/i.test(next)) {
      next = next.replace(/^\s*git\b/i, `git -C "${env.gitRoot}"`);
    }
  }
  return next;
}
