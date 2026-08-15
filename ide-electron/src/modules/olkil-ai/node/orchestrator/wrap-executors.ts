import * as path from 'path';
import { FailedCommandMemory, rewriteKnownBadCommand } from './failed-commands';
import { powershellJoinHint, type EnvironmentInfo, findGitRoot } from './environment';
import { relocateTempScript } from './temp-workspace';
import { readFileText, resolveWorkspacePath, verifyNewText, verifyOldText } from './patch-engine';
import type { SessionState } from './session-state';
import type { ToolResultCache } from './tool-cache';

const SEARCH_FILE_CAP = 14;
const SEARCH_LINE_CAP = 40;

export function wrapSearchExecutor(
  original: ((query: string, cwd: string, ctx: any) => Promise<string>) | undefined,
  opts: { cache: ToolResultCache; session: SessionState },
) {
  if (!original) return original;
  return async (query: string, cwd: string, ctx: any) => {
    opts.session.noteSearch(query);
    const cached = opts.cache.getSearch(cwd, query);
    if (cached) {
      return `${cached}\n[cache hit — do not search this pattern again]`;
    }
    const raw = await original(query, cwd, ctx);
    const ranked = capSearchOutput(raw);
    opts.cache.setSearch(cwd, query, ranked);
    return ranked;
  };
}

export function wrapReadExecutor(
  original: ((request: any, ctx: any) => Promise<any>) | undefined,
  opts: { cache: ToolResultCache; session: SessionState; cwd: string },
) {
  if (!original) return original;
  return async (request: any, ctx: any) => {
    const filePath = String(request?.path || request?.file_path || '');
    const abs = filePath ? resolveWorkspacePath(opts.cwd, filePath) : '';
    if (abs) opts.session.noteRead(abs);
    const cached = abs ? opts.cache.getRead(abs, request?.start_line, request?.end_line) : undefined;
    if (cached) {
      return `${cached}\n[cache hit — file unchanged]`;
    }
    const result = await original(request, ctx);
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    if (abs) opts.cache.setRead(abs, text, request?.start_line, request?.end_line);
    return result;
  };
}

export function wrapEditorExecutor(
  original: ((input: any, cwd: string, ctx: any) => Promise<string>) | undefined,
  opts: {
    cwd: string;
    cache: ToolResultCache;
    session: SessionState;
    runId: string;
    onRedirect?: (from: string, to: string) => void;
  },
) {
  if (!original) return original;
  return async (input: any, cwd: string, ctx: any) => {
    const toolCwd = cwd || opts.cwd;
    const requested = String(input?.path || '');
    const relocated = requested ? relocateTempScript(opts.cwd, requested, opts.runId) : requested;
    const safeInput = relocated !== requested ? { ...input, path: relocated } : input;
    if (relocated !== requested) {
      opts.onRedirect?.(requested, relocated);
    }
    const abs = relocated ? resolveWorkspacePath(toolCwd, relocated) : '';
    if (abs && safeInput?.old_text && !safeInput.insert_line) {
      const current = readFileText(abs);
      if (current != null) {
        const check = verifyOldText(current, String(safeInput.old_text));
        if (!check.ok) {
          throw new Error(check.hint || 'old_text not found; re-read the file.');
        }
      }
    }
    const result = await original(safeInput, opts.cwd, ctx);
    if (abs) {
      opts.cache.invalidatePath(abs);
      opts.session.noteEdit(abs);
      if (safeInput?.new_text) {
        const after = readFileText(abs);
        if (after != null && !verifyNewText(after, String(safeInput.new_text))) {
          throw new Error(
            `Edit applied but expected new_text was not found in ${path.basename(abs)}. Re-read the region before retrying.`,
          );
        }
      }
    }
    return result;
  };
}

export function wrapBashExecutor(
  original: ((command: string, cwd: string, ctx: any) => Promise<string>) | undefined,
  opts: {
    cwd: string;
    env: EnvironmentInfo;
    failures: FailedCommandMemory;
    session: SessionState;
  },
) {
  if (!original) return original;
  const legacyPs = powershellJoinHint(opts.env);
  return async (command: string, cwd: string, ctx: any) => {
    const gitRoot = opts.env.gitRoot || findGitRoot(opts.cwd);
    const rewritten = rewriteKnownBadCommand(command, {
      powershellLegacy: legacyPs,
      python: opts.env.python,
      gitRoot,
    });
    const prior = opts.failures.lookup(rewritten) || opts.failures.lookup(command);
    if (prior) {
      throw new Error(
        `Refusing to repeat a command that already failed.\nPrevious error: ${prior.error}` +
          (prior.suggestion ? `\nUse this instead: ${prior.suggestion}` : ''),
      );
    }
    try {
      return await original(rewritten, cwd || opts.cwd, ctx);
    } catch (error: any) {
      const message = error?.message || String(error);
      const suggestion = opts.failures.suggestRewrite(rewritten, message, {
        powershellLegacy: legacyPs,
        python: opts.env.python,
        gitRoot,
      });
      if (suggestion && suggestion !== rewritten && !opts.failures.lookup(suggestion)) {
        try {
          const retried = await original(suggestion, cwd || opts.cwd, ctx);
          opts.failures.remember(rewritten, message, suggestion);
          return `${retried}\n[auto-retried once with: ${suggestion}]`;
        } catch (retryErr: any) {
          const retryMsg = retryErr?.message || String(retryErr);
          opts.failures.remember(rewritten, message, suggestion);
          opts.failures.remember(suggestion, retryMsg);
          throw new Error(`${message}\nRetry with ${suggestion} also failed: ${retryMsg}`);
        }
      }
      opts.failures.remember(rewritten, message, suggestion);
      throw new Error(suggestion ? `${message}\nSuggested alternative (do not repeat the same command): ${suggestion}` : message);
    }
  };
}

function capSearchOutput(raw: string): string {
  if (!raw) return raw;
  const blocks = raw.split(/\n(?=\S)/);
  if (blocks.length <= SEARCH_FILE_CAP && raw.length < 8_000) {
    return raw;
  }
  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];
  let files = 0;
  let lineBudget = SEARCH_LINE_CAP;
  for (const line of lines) {
    if (/^[^:\s].*:/.test(line) || /\.(ts|tsx|js|jsx|py|java|go|cs)\b/.test(line)) {
      files += 1;
      if (files > SEARCH_FILE_CAP) break;
    }
    if (lineBudget-- <= 0) break;
    kept.push(line);
  }
  const extra = files > SEARCH_FILE_CAP ? `\n…[ranked to strongest ${SEARCH_FILE_CAP} files; narrow the pattern to expand]` : '';
  return kept.join('\n') + extra;
}
