/**
 * OLKIL coding-agent runtime host (Node).
 * Engine: vendored @olkil/engine (forked Cline SDK source under packages/olkil-engine).
 * User-facing branding: OLKIL only.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findModel, AiProviderId } from '../common/models';
import { buildClineStyleSystemPrompt, chatModeToUserMode, type ChatMode } from '../common/cline-prompt';
import type { FileChangeKind } from '../common';
import {
  EMBEDDED_DEEPSEEK_API_KEY,
  EMBEDDED_ENV,
  EMBEDDED_POOLSIDE_API_KEY,
} from './embedded-secrets';
import { startOrchestrator } from './orchestrator';
import { tryFastPath } from './orchestrator/fast-path';
import type { ActivitySinkEvent } from './orchestrator/types';

export type ClineRuntimeMode = ChatMode;

export interface ClineRunRequest {
  runId: string;
  prompt: string;
  workspaceRoot: string;
  activeFile?: string;
  mode: ClineRuntimeMode;
  modelId?: string;
  rules?: string;
  autoApprove?: boolean;
}

export interface ClineRuntimeActivity {
  id: string;
  kind: 'thinking' | 'reading' | 'searching' | 'editing' | 'running' | 'browsing' | 'todo' | 'done' | 'indexing' | 'info';
  label: string;
  done?: boolean;
  filePath?: string;
  command?: string;
  argsPreview?: string;
  resultPreview?: string;
  groupId?: string;
  parentId?: string;
  lineRange?: string;
  filesExplored?: number;
  searchCount?: number;
}

export interface ClineRuntimeFileChange {
  id: string;
  kind: FileChangeKind;
  path: string;
  beforeContent: string | null;
  afterContent: string | null;
}

export interface ClineRuntimeState {
  runId: string;
  done: boolean;
  text: string;
  reasoning?: string;
  error?: string;
  activities: ClineRuntimeActivity[];
  status?: string;
  fileChanges: ClineRuntimeFileChange[];
}

type ClineSdk = {
  Agent: new (config: any) => {
    run: (input: string) => Promise<any>;
    continue: (input?: string) => Promise<any>;
    abort: (reason?: unknown) => void;
  };
  createDefaultExecutors: (options?: any) => any;
  createDefaultTools: (options: any) => Array<{ name: string }>;
};

/** Per-run tool-loop budget. Large repos need many read/search/edit turns. */
function maxIterationsForMode(mode: ClineRuntimeMode, hasWorkspace: boolean): number {
  if (!hasWorkspace) {
    return 4;
  }
  if (mode === 'ask') {
    return 32;
  }
  if (mode === 'plan') {
    return 64;
  }
  return 160;
}

function isMaxIterationsError(error: unknown): boolean {
  const msg =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : error && typeof error === 'object' && 'message' in error
          ? String((error as { message?: unknown }).message || '')
          : String(error || '');
  return /exceeded maxIterations/i.test(msg);
}

let sdkPromise: Promise<ClineSdk> | null = null;
let runtimeGlobalsReady = false;

function patchUtilStyleText(): void {
  const apply = (id: string) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const util = require(id) as { styleText?: unknown };
      if (typeof util.styleText !== 'function') {
        util.styleText = (_format: unknown, text: unknown) => String(text ?? '');
      }
    } catch {
      // ignore
    }
  };
  apply('util');
  apply('node:util');
}

function ensureClineRuntimeGlobals(): void {
  if (runtimeGlobalsReady) {
    return;
  }
  runtimeGlobalsReady = true;
  patchUtilStyleText();
  const g = globalThis as any;

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const web = require('stream/web') as Record<string, unknown>;
    for (const key of [
      'TransformStream',
      'ReadableStream',
      'WritableStream',
      'ByteLengthQueuingStrategy',
      'CountQueuingStrategy',
      'TextEncoderStream',
      'TextDecoderStream',
    ]) {
      if (typeof g[key] === 'undefined' && typeof web[key] !== 'undefined') {
        g[key] = web[key];
      }
    }
  } catch {
    // ignore
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const undici = require('undici') as Record<string, unknown>;
    for (const key of ['fetch', 'Headers', 'Request', 'Response', 'FormData', 'File', 'Blob']) {
      if (typeof g[key] === 'undefined' && typeof undici[key] !== 'undefined') {
        g[key] = undici[key];
      }
    }
  } catch {
    // ignore
  }
}

async function loadSdk(): Promise<ClineSdk> {
  if (!sdkPromise) {
    ensureClineRuntimeGlobals();
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (
      specifier: string,
    ) => Promise<ClineSdk>;
    sdkPromise = dynamicImport('@olkil/engine').catch((err) => {
      sdkPromise = null;
      throw err;
    });
  }
  return sdkPromise;
}

/** Fire-and-forget warm-up so the first chat turn does not pay SDK import latency. */
export function prewarmClineSdk(): void {
  void loadSdk().catch(() => undefined);
}

/**
 * Do not warm the engine while the IDE is still starting. Importing @olkil/engine
 * pulls a Node-22 ESM graph (OpenTelemetry, SAP provider, …) that starves the
 * extension-host IPC listen and used to show "Extension Host Process is restarting".
 */
export function scheduleClineSdkPrewarm(delayMs = 20_000): void {
  setTimeout(() => {
    prewarmClineSdk();
  }, delayMs).unref?.();
}

const TOOL_RESULT_KEEP_FULL = 6;
const TOOL_RESULT_MAX_CHARS = 6_000;

function truncateToolOutput(output: unknown, maxChars: number): unknown {
  if (typeof output === 'string') {
    if (output.length <= maxChars) return output;
    return `${output.slice(0, maxChars)}\n…[truncated for speed]`;
  }
  if (output == null) return output;
  try {
    const raw = JSON.stringify(output);
    if (raw.length <= maxChars) return output;
    return `${raw.slice(0, maxChars)}…[truncated for speed]`;
  } catch {
    return output;
  }
}

/** Shrink older tool results in the *provider request only* so later turns stay fast. */
function prepareTurnForSpeed(context: {
  iteration: number;
  messages: readonly any[];
  aggressive?: boolean;
}): { messages: any[] } | undefined {
  const aggressive = Boolean(context.aggressive);
  const minIter = aggressive ? 1 : 4;
  const minMsgs = aggressive ? 4 : 8;
  if (context.iteration < minIter || !Array.isArray(context.messages) || context.messages.length < minMsgs) {
    return undefined;
  }
  const toolMsgIndexes: number[] = [];
  for (let i = 0; i < context.messages.length; i++) {
    const m = context.messages[i];
    if (m?.role === 'tool') {
      toolMsgIndexes.push(i);
    } else if (
      Array.isArray(m?.content) &&
      m.content.some((p: any) => p?.type === 'tool-result')
    ) {
      toolMsgIndexes.push(i);
    }
  }
  if (toolMsgIndexes.length <= TOOL_RESULT_KEEP_FULL) {
    return undefined;
  }
  const trimSet = new Set(toolMsgIndexes.slice(0, -TOOL_RESULT_KEEP_FULL));
  const messages = context.messages.map((msg, idx) => {
    if (!trimSet.has(idx)) return msg;
    if (!Array.isArray(msg.content)) return msg;
    return {
      ...msg,
      content: msg.content.map((part: any) => {
        if (part?.type !== 'tool-result') return part;
        return {
          ...part,
          output: truncateToolOutput(part.output, TOOL_RESULT_MAX_CHARS),
        };
      }),
    };
  });
  return { messages };
}

function readEnvFile(): Record<string, string> {
  const out: Record<string, string> = { ...EMBEDDED_ENV };
  try {
    const envPath = path.join(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) {
      return out;
    }
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      let v = m[2] || '';
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      out[m[1]] = v;
    }
  } catch {
    // ignore
  }
  return out;
}

function getKey(provider: AiProviderId, env: Record<string, string>): string {
  if (provider === 'ollama') {
    return process.env.OLLAMA_API_KEY || env.OLLAMA_API_KEY || 'ollama';
  }
  if (provider === 'deepseek') {
    return (
      process.env.DEEPSEEK_API_KEY ||
      env.DEEPSEEK_API_KEY ||
      EMBEDDED_DEEPSEEK_API_KEY ||
      ''
    );
  }
  return (
    process.env.POOLSIDE_API_KEY ||
    env.POOLSIDE_API_KEY ||
    EMBEDDED_POOLSIDE_API_KEY ||
    ''
  );
}

function getBaseUrl(provider: AiProviderId, env: Record<string, string>): string | undefined {
  if (provider === 'ollama') {
    const raw =
      process.env.OLLAMA_BASE_URL || env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
    return raw.replace(/\/$/, '');
  }
  if (provider === 'deepseek') {
    const raw =
      process.env.DEEPSEEK_BASE_URL || env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
    return raw.replace(/\/$/, '').replace(/\/v1$/, '') + '/v1';
  }
  if (provider === 'poolside') {
    return 'https://inference.poolside.ai/v1';
  }
  return undefined;
}

function mapProvider(provider: AiProviderId): string {
  if (provider === 'deepseek') return 'deepseek';
  if (provider === 'poolside') return 'poolside';
  if (provider === 'ollama') return 'ollama';
  return 'openai-compatible';
}

function toolKind(name: string): ClineRuntimeActivity['kind'] {
  const n = (name || '').toLowerCase();
  if (/list_dir|list_files|glob|ls\b/.test(n)) return 'searching';
  if (/read|file/.test(n) && !/edit|write|create|replace/.test(n)) return 'reading';
  if (
    /search|grep|find|codebase|investigate|definition|reference|module|related_files|exact_code|git_info/.test(
      n,
    )
  ) {
    return /git_info/.test(n) ? 'running' : 'searching';
  }
  if (/edit|write|patch|apply|create|replace|insert/.test(n)) return 'editing';
  if (/run|bash|shell|command/.test(n)) return 'running';
  if (/web|fetch|browser/.test(n)) return 'browsing';
  if (/skill|todo|ask|question/.test(n)) return 'todo';
  return 'thinking';
}

function truncate(s: string, n = 400): string {
  const t = (s || '').trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n)}…`;
}

/** Strip third-party agent brand names from any user-visible status. */
function olkilStatus(raw?: string): string {
  if (!raw) return '';
  return raw
    .replace(/\bCline\b/gi, 'OLKIL')
    .replace(/\bcline\b/g, 'OLKIL')
    .replace(/\bOLKIL agent starting…?/gi, 'Thinking')
    .replace(/\bWorking…?/gi, 'Thinking')
    .trim();
}

function firstReadRequest(input: any): any {
  if (Array.isArray(input?.files) && input.files[0]) return input.files[0];
  if (Array.isArray(input?.paths) && input.paths[0]) {
    return typeof input.paths[0] === 'string' ? { path: input.paths[0] } : input.paths[0];
  }
  return input;
}

function toolFileBase(input: any): string {
  const req = firstReadRequest(input);
  const file =
    req?.path ||
    req?.file_path ||
    req?.filePath ||
    input?.path ||
    input?.file_path ||
    input?.filePath ||
    input?.target_file ||
    input?.paths?.[0] ||
    '';
  return file ? path.basename(String(file)) : '';
}

function toolLineRange(input: any): string | undefined {
  const req = firstReadRequest(input);
  const start = req?.start_line ?? req?.startLine;
  const end = req?.end_line ?? req?.endLine;
  if (start == null && end == null) return undefined;
  return `L${start ?? 1}-${end ?? 'EOF'}`;
}

/** Cursor-style present-tense labels while a step is live. */
function friendlyToolLabel(toolName: string, input: any): string {
  const n = (toolName || 'tool').toLowerCase();
  const base = toolFileBase(input);
  if (/read_files|read_file|read/.test(n)) {
    const range = toolLineRange(input);
    return base ? `Reading ${base}${range ? ` ${range}` : ''}` : 'Reading';
  }
  if (/list_dir|list_files|glob|ls\b/.test(n)) {
    const p = input?.path || input?.target_directory || '.';
    return p && p !== '.' ? `Exploring ${truncate(String(p), 40)}` : 'Exploring';
  }
  if (/search_codebase|repository_search|exact_code|find_module|investigate/.test(n)) {
    const q = input?.query || input?.pattern || input?.queries?.[0] || input?.symbol || '';
    if (/grep|exact/.test(n)) {
      return q ? `Searching for “${truncate(String(q), 36)}”` : 'Searching';
    }
    return q ? `Exploring “${truncate(String(q), 36)}”` : 'Exploring';
  }
  if (/goto_definition|find_references/.test(n)) {
    const q = input?.symbol || '';
    return q ? `Searching references “${truncate(String(q), 36)}”` : 'Searching references';
  }
  if (/git_info/.test(n)) return 'Checking git';
  if (/related_files/.test(n)) return 'Checking related files';
  if (/run_commands|bash|shell|command/.test(n)) {
    const cmd = typeof input?.command === 'string' ? input.command : '';
    return cmd ? `Running ${truncate(cmd, 48)}` : 'Running command';
  }
  if (/editor|apply_patch|write|edit|str_replace|create/.test(n)) {
    return base ? `Editing ${base}` : 'Editing';
  }
  if (/fetch_web|web/.test(n)) return 'Browsing web';
  if (/ask_question/.test(n)) return 'Asking';
  return base ? `${toolName} · ${base}` : 'Working';
}

/** Cursor-style past-tense labels once a step finishes. */
function completedToolLabel(toolName: string, input: any, liveLabel?: string): string {
  const n = (toolName || 'tool').toLowerCase();
  const base = toolFileBase(input);
  if (/read_files|read_file|read/.test(n)) {
    const range = toolLineRange(input);
    return base ? `Read ${base}${range ? ` ${range}` : ''}` : 'Read files';
  }
  if (/list_dir|list_files|glob|ls\b/.test(n)) return 'Explored';
  if (/search_codebase|search|find/.test(n) && !/grep/.test(n)) {
    const q = input?.query || input?.pattern || '';
    return q ? `Explored “${truncate(String(q), 36)}”` : 'Explored';
  }
  if (/grep/.test(n)) {
    const q = input?.query || input?.pattern || '';
    return q ? `Grepped “${truncate(String(q), 36)}”` : 'Grepped';
  }
  if (/run_commands|bash|shell|command/.test(n)) {
    const cmd = typeof input?.command === 'string' ? input.command : '';
    return cmd ? `Ran ${truncate(cmd, 48)}` : 'Ran command';
  }
  if (/editor|apply_patch|write|edit|str_replace|create/.test(n)) {
    return base ? `Edited ${base}` : 'Edited files';
  }
  if (/fetch_web|web/.test(n)) return 'Browsed web';
  if (/ask_question/.test(n)) return 'Asked';
  if (liveLabel) {
    return liveLabel
      .replace(/^Reading\b/i, 'Read')
      .replace(/^Exploring\b/i, 'Explored')
      .replace(/^Grepping\b/i, 'Grepped')
      .replace(/^Editing\b/i, 'Edited')
      .replace(/^Running\b/i, 'Ran')
      .replace(/^Browsing\b/i, 'Browsed')
      .replace(/^Thinking\b/i, 'Thought');
  }
  return 'Done';
}

function readFileSafe(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function resolveEditPath(cwd: string, inputPath: string): string {
  return path.isAbsolute(inputPath) ? path.normalize(inputPath) : path.resolve(cwd, inputPath);
}

/**
 * Prefer the folder the user opened. Empty string means "no project" —
 * never invent process.cwd() (IDE install) as a workspace.
 */
function resolveAgentCwd(requested: string | undefined): string {
  const raw = (requested || '').trim();
  if (!raw) return '';
  try {
    const cwd = path.resolve(raw);
    if (fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) {
      return cwd;
    }
  } catch {
    // ignore
  }
  return '';
}

function assertPathInsideWorkspace(absPath: string, workspaceRoot: string): void {
  if (!workspaceRoot) {
    throw new Error('No project folder is open.');
  }
  const root = path.resolve(workspaceRoot);
  const file = path.resolve(absPath);
  const rel = path.relative(root, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `Refusing to edit outside the opened workspace (${root}): ${file}`,
    );
  }
}

/**
 * Wrap Cline's editor executor so each write also emits an Olkil file-change
 * record (before/after) for Accept / Revert cards in chat.
 */
function wrapEditorForFileChanges(
  editor: ((input: any, cwd: string, ctx: any) => Promise<string>) | undefined,
  onChange: (change: ClineRuntimeFileChange) => void,
  workspaceRoot: string,
): typeof editor {
  if (!editor) return editor;
  return async (input: any, cwd: string, ctx: any) => {
    const toolCwd = cwd || workspaceRoot;
    const rel = String(input?.path || '');
    const abs = rel ? resolveEditPath(toolCwd, rel) : '';
    if (abs) {
      assertPathInsideWorkspace(abs, workspaceRoot);
    }
    // Force relative paths to resolve against the opened workspace, not IDE cwd.
    const safeInput =
      rel && !path.isAbsolute(rel)
        ? { ...input, path: path.relative(toolCwd, abs).replace(/\\/g, '/') || '.' }
        : abs
          ? { ...input, path: abs }
          : input;
    const before = abs ? readFileSafe(abs) : null;
    const kind: FileChangeKind =
      before == null ? 'create' : input?.insert_line != null ? 'edit' : 'edit';

    const result = await editor(safeInput, workspaceRoot, ctx);

    const after = abs ? readFileSafe(abs) : null;
    if (abs && (before !== after || kind === 'create')) {
      onChange({
        id: `fc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        kind: before == null ? 'create' : 'edit',
        path: abs,
        beforeContent: before,
        afterContent: after,
      });
    }
    return result;
  };
}

interface RunGrouping {
  phase: 'explore' | 'apply' | 'validate';
  liveBatch: string[];
  orch?: { noteTools: (names: string[]) => void };
}

function phaseForTool(name: string, command?: string): RunGrouping['phase'] {
  const n = (name || '').toLowerCase();
  if (/edit|write|patch|apply|create|replace|insert/.test(n)) return 'apply';
  if (
    /run|bash|shell|command/.test(n) &&
    /test|lint|typecheck|tsc|jest|vitest|eslint|validate/i.test(command || name)
  ) {
    return 'validate';
  }
  return 'explore';
}

function groupMeta(phase: RunGrouping['phase']): { groupId: string; parentLabel: string } {
  if (phase === 'apply') return { groupId: 'apply_changes', parentLabel: 'Applying changes' };
  if (phase === 'validate') return { groupId: 'validate_changes', parentLabel: 'Validating' };
  return { groupId: 'explore_loop', parentLabel: 'Exploring files' };
}

export class OlkilClineRuntimeHost {
  private states = new Map<string, ClineRuntimeState>();
  private aborts = new Map<string, { abort: (reason?: unknown) => void }>();

  getState(runId: string): ClineRuntimeState {
    return (
      this.states.get(runId) || {
        runId,
        done: true,
        text: '',
        activities: [],
        fileChanges: [],
        error: 'Unknown run',
      }
    );
  }

  cancel(runId: string): boolean {
    const agent = this.aborts.get(runId);
    if (!agent) return false;
    try {
      agent.abort('cancelled');
    } catch {
      // ignore
    }
    const st = this.states.get(runId);
    if (st && !st.done) {
      st.done = true;
      st.status = 'Stopped';
      st.error = st.error || 'Stopped';
    }
    return true;
  }

  async run(request: ClineRunRequest): Promise<ClineRuntimeState> {
    const { runId } = request;
    const state: ClineRuntimeState = {
      runId,
      done: false,
      text: '',
      reasoning: '',
      activities: [],
      fileChanges: [],
      status: 'Thinking',
    };
    this.states.set(runId, state);
    let orchFinish: ((ok: boolean) => void) | undefined;

    try {
      const sdk = await loadSdk();
      const env = readEnvFile();
      const option = findModel(request.modelId);
      const providerId = mapProvider(option.provider);
      const apiKey = getKey(option.provider, env);
      const baseUrl = getBaseUrl(option.provider, env);

      if (option.provider !== 'ollama' && !apiKey) {
        throw new Error(
          `Missing API key for ${option.provider}. Set ${
            option.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'POOLSIDE_API_KEY'
          }.`,
        );
      }

      const cwd = resolveAgentCwd(request.workspaceRoot);
      const hasWorkspace = Boolean(cwd);
      const mode = request.mode;
      const userMode = chatModeToUserMode(mode);

      // Deterministic fast-path: title/config edits in <1s without LLM agent loop.
      if (hasWorkspace && mode === 'agent') {
        const fast = await tryFastPath({
          prompt: request.prompt,
          workspaceRoot: cwd,
          mode,
          runId,
        });
        if (fast) {
          state.text = fast.text;
          state.fileChanges = fast.fileChanges.map((c) => ({
            id: c.id,
            kind: c.kind,
            path: c.path,
            beforeContent: c.beforeContent,
            afterContent: c.afterContent,
          }));
          state.status = 'Done';
          state.done = true;
          state.activities.push({
            id: 'fast_path_edit',
            kind: 'editing',
            label: 'Applied edit',
            done: true,
            resultPreview: fast.text,
          });
          return state;
        }
      }

      const prefetchAbort = new AbortController();
      let agentRef: { abort: (reason?: unknown) => void } | null = null;
      this.aborts.set(runId, {
        abort: (reason?: unknown) => {
          prefetchAbort.abort();
          try {
            agentRef?.abort(reason);
          } catch {
            // ignore
          }
        },
      });

      const grouping: RunGrouping = { phase: 'explore', liveBatch: [] };
      const orch = await startOrchestrator({
        runId,
        prompt: request.prompt,
        workspaceRoot: cwd,
        activeFile: request.activeFile,
        mode,
        signal: prefetchAbort.signal,
        onActivity: (event) => this.applyOrchestratorActivity(state, event),
      });
      grouping.orch = orch;
      orchFinish = (ok) => orch.finish(ok);
      if (prefetchAbort.signal.aborted) {
        state.status = 'Stopped';
        state.done = true;
        orchFinish?.(false);
        return state;
      }
      state.status = 'Thinking';

      const systemPrompt = buildClineStyleSystemPrompt({
        mode,
        workspaceRoot: cwd || '(no folder open)',
        activeFile: request.activeFile,
        platform: `${os.platform()} ${os.release()}`,
        ideName: 'OLKIL',
        taskSize: orch.route.size,
        rules: [request.rules, orch.orchestrationRules].filter(Boolean).join('\n\n'),
        identity: `# Identity
- Product / IDE: OLKIL. You are the coding agent inside OLKIL.
- Never claim to be Cline, ChatGPT, Claude, Gemini, Laguna, or Poolside as the product name.
- Selected model: ${option.publicName || option.displayName || option.label}.
${
  hasWorkspace
    ? `- Your ONLY workspace is: ${cwd}
- Never edit, create, or delete files outside this workspace. Never touch the OLKIL IDE source/install tree.`
    : `- No project folder is open. Answer general questions only.
- Do NOT invent or use the IDE install path as a workspace.
- If the user asks to create/edit project files, politely ask them to open their project folder first.`
}`,
      });

      const baseExecutors = hasWorkspace && sdk.createDefaultExecutors
        ? sdk.createDefaultExecutors({
            editor: { restrictToCwd: true },
            applyPatch: { restrictToCwd: true },
          })
        : {};

      const orchExecutors = hasWorkspace ? orch.wrapExecutors(baseExecutors) : {};
      const executors = hasWorkspace
        ? {
            ...orchExecutors,
            editor: wrapEditorForFileChanges(
              orchExecutors.editor || baseExecutors.editor,
              (change) => {
                const existing = state.fileChanges.find(
                  (c) => path.resolve(c.path) === path.resolve(change.path),
                );
                if (existing) {
                  existing.afterContent = change.afterContent;
                  existing.kind = existing.beforeContent == null ? 'create' : 'edit';
                } else {
                  state.fileChanges.push(change);
                }
                state.status = `Editing ${path.basename(change.path)}`;
              },
              cwd,
            ),
          }
        : {};

      const isPlanOrAsk = mode === 'plan' || mode === 'ask';
      // Only attach filesystem tools when a real project folder is open.
      // Never pass process.cwd() — that would point at the IDE itself.
      const defaultTools = hasWorkspace
        ? sdk.createDefaultTools({
            executors,
            cwd,
            enableReadFiles: true,
            enableSearch: true,
            enableBash: mode !== 'ask',
            // Web fetch is rarely needed for IDE coding and slows tool selection + turns.
            enableWebFetch: false,
            enableEditor: !isPlanOrAsk,
            enableApplyPatch: false,
            enableSkills: false,
            enableAskQuestion: false,
            enableSubmitAndExit: false,
          })
        : [];
      const extraTools =
        orch.route.size === 'simple'
          ? orch.extraTools.filter((t: { name: string }) =>
              /^(repository_search|exact_code_search|goto_definition|git_info)$/.test(t.name),
            )
          : orch.extraTools;
      const tools = hasWorkspace ? [...defaultTools, ...extraTools] : [];

      const autoApprove = request.autoApprove !== false && mode === 'agent';
      // Route budgets are primary; mode ceiling is a safety cap only.
      const modeCeiling = maxIterationsForMode(mode, hasWorkspace);
      const maxIterations = hasWorkspace
        ? Math.min(modeCeiling, orch.route.maxIterations)
        : modeCeiling;
      const maxContinues = hasWorkspace
        ? mode === 'ask'
          ? 2
          : Math.max(orch.route.maxContinues, mode === 'agent' ? 4 : 2)
        : 0;

      // Match legacy llm.service: disable extended thinking for agent speed/cost.
      // Simple tasks get a smaller completion budget so the model finishes faster.
      const modelOptions: Record<string, unknown> = {
        thinking: false,
        temperature: 0.2,
      };
      if (option.provider === 'poolside') {
        modelOptions.chat_template_kwargs = { enable_thinking: false };
        // Simple tasks need enough headroom for tool-call JSON without hitting output limit.
        modelOptions.maxTokens = orch.route.size === 'simple' ? 3072 : 2048;
      } else if (option.provider === 'deepseek') {
        modelOptions.maxTokens = orch.route.size === 'simple' ? 4096 : 4096;
      }

      const AgentCtor = sdk.Agent;
      const agent = new AgentCtor({
        providerId,
        modelId: option.model,
        apiKey,
        baseUrl,
        systemPrompt,
        tools,
        maxIterations,
        modelOptions,
        toolExecution: 'parallel',
        prepareTurn: (ctx: any) =>
          orch.prepareTurn(ctx) ||
          prepareTurnForSpeed({ ...ctx, aggressive: orch.route.size === 'simple' }),
        requestToolApproval: async () => ({ approved: autoApprove || mode === 'agent' }),
        onEvent: (event: any) => {
          this.handleEvent(state, event, grouping);
        },
      } as any);
      agentRef = agent;

      state.status = 'Thinking';

      const wrappedPrompt = `<user_input mode="${userMode}">${orch.wrapPrompt(request.prompt)}</user_input>`;
      let result = await agent.run(wrappedPrompt);
      let continues = 0;
      while (
        result?.error &&
        isMaxIterationsError(result.error) &&
        continues < maxContinues &&
        this.aborts.has(runId) &&
        !state.done
      ) {
        continues += 1;
        state.status = `Continuing work (${continues}/${maxContinues})…`;
        state.error = undefined;
        result = await agent.continue(
          `[SYSTEM] Iteration budget refreshed (${continues}/${maxContinues}). ` +
            `Continue the unfinished task from where you left off — do not restart from scratch. ` +
            `Prefer finishing remaining edits/checks over re-exploring the whole repo.`,
        );
      }

      state.text = (result?.outputText || state.text || '').trim();
      if (state.status === 'Stopped') {
        state.done = true;
        orchFinish?.(false);
        return state;
      }
      if (result?.error) {
        if (isMaxIterationsError(result.error)) {
          // Never fail the turn on step limits — keep partial progress; UI auto-continues if needed.
          state.error = undefined;
          if (!state.text?.trim()) {
            if (state.fileChanges.length) {
              state.text = `Applied changes to ${state.fileChanges.map((c) => path.basename(c.path)).join(', ')}.`;
            } else {
              state.text = 'Working…';
            }
          }
        } else if (!/abort|cancel/i.test(String(result.error?.message || result.error))) {
          state.error = result.error.message || String(result.error);
        }
      }
      state.status = state.error ? 'Failed' : 'Done';
      state.done = true;
      orchFinish?.(!state.error);
      return state;
    } catch (e: any) {
      state.error = e?.message || String(e);
      state.status = 'Failed';
      state.done = true;
      orchFinish?.(false);
      return state;
    } finally {
      this.aborts.delete(runId);
      setTimeout(() => {
        const cur = this.states.get(runId);
        if (cur?.done) {
          this.states.delete(runId);
        }
      }, 120_000);
    }
  }

  private applyOrchestratorActivity(state: ClineRuntimeState, event: ActivitySinkEvent) {
    const existing = state.activities.find((a) => a.id === event.id);
    const row: ClineRuntimeActivity = {
      id: event.id,
      kind: event.kind === 'indexing' || event.kind === 'info' ? 'searching' : event.kind,
      label: event.label,
      done: event.done,
      filePath: event.filePath,
      command: event.command,
      argsPreview: event.argsPreview,
      resultPreview: event.resultPreview,
      groupId: event.groupId,
      parentId: event.parentId,
      lineRange: event.lineRange,
      filesExplored: event.filesExplored,
      searchCount: event.searchCount,
    };
    if (existing) {
      Object.assign(existing, row);
    } else {
      state.activities.push(row);
    }
    if (event.filesExplored != null && event.searchCount != null && event.done) {
      state.status = event.label;
    } else if (!event.done) {
      state.status = event.label;
    }
  }

  private ensurePhaseGroup(state: ClineRuntimeState, grouping: RunGrouping, phase: RunGrouping['phase']) {
    if (grouping.phase !== phase) {
      const prev = groupMeta(grouping.phase);
      const prevRow = state.activities.find((a) => a.id === prev.groupId && !a.parentId);
      if (prevRow && !prevRow.done) {
        const kids = state.activities.filter((a) => a.parentId === prev.groupId);
        const files = new Set(kids.map((k) => k.filePath).filter(Boolean)).size;
        const searches = kids.filter((k) => k.kind === 'searching').length;
        prevRow.done = true;
        prevRow.filesExplored = files;
        prevRow.searchCount = searches;
        if (grouping.phase === 'explore') {
          prevRow.label = `Explored ${files} files, ${searches} searches`;
        } else {
          prevRow.label = prevRow.label.replace(/ing\b/, 'ed');
        }
      }
      grouping.phase = phase;
    }
    const meta = groupMeta(phase);
    if (!state.activities.some((a) => a.id === meta.groupId)) {
      state.activities.push({
        id: meta.groupId,
        kind: phase === 'apply' ? 'editing' : phase === 'validate' ? 'running' : 'searching',
        label: meta.parentLabel,
        done: false,
        groupId: meta.groupId,
      });
    }
    return meta;
  }

  private handleEvent(state: ClineRuntimeState, event: any, grouping?: RunGrouping) {
    if (!event || !event.type) return;
    switch (event.type) {
      case 'assistant-text-delta':
        state.text = event.accumulatedText || state.text + (event.text || '');
        state.status = 'Writing';
        break;
      case 'assistant-reasoning-delta': {
        state.reasoning = event.accumulatedText || state.reasoning || '';
        state.status = 'Thinking';
        const thinkId = 'thinking_live';
        let row = state.activities.find((a) => a.id === thinkId);
        if (!row) {
          row = {
            id: thinkId,
            kind: 'thinking',
            label: 'Thinking',
            done: false,
            resultPreview: '',
          };
          state.activities.push(row);
        } else if (row.done) {
          row.done = false;
          row.label = 'Thinking';
        }
        row.resultPreview = truncate(state.reasoning || '', 800);
        break;
      }
      case 'assistant-message': {
        const parts = event.message?.content || event.message?.parts || [];
        const text = parts
          .filter((p: any) => p.type === 'text')
          .map((p: any) => p.text || '')
          .join('');
        if (text) state.text = text;
        const think = state.activities.find((a) => a.id === 'thinking_live' && !a.done);
        if (think) {
          think.done = true;
          think.label = 'Thought';
        }
        break;
      }
      case 'tool-started': {
        const tc = event.toolCall || {};
        const name = tc.toolName || tc.name || 'tool';
        const id = tc.toolCallId || tc.id || `tool_${state.activities.length + 1}`;
        const input = (typeof tc.input === 'object' && tc.input) || tc.arguments || {};
        const label = friendlyToolLabel(name, input);
        const req = firstReadRequest(input);
        const filePath = req?.path || req?.file_path || input.path || input.file_path || input.filePath || input.target_file;
        const command = typeof input.command === 'string' ? input.command : Array.isArray(input.commands) ? String(input.commands[0] || '') : undefined;
        const think = state.activities.find((a) => a.id === 'thinking_live' && !a.done);
        if (think) {
          think.done = true;
          think.label = 'Thought';
        }
        const phase = grouping ? phaseForTool(name, command) : 'explore';
        const meta = grouping ? this.ensurePhaseGroup(state, grouping, phase) : undefined;
        grouping?.liveBatch.push(name);
        state.activities.push({
          id,
          kind: toolKind(name),
          label,
          done: false,
          filePath: filePath ? String(filePath) : undefined,
          command,
          argsPreview: truncate(JSON.stringify(input)),
          groupId: meta?.groupId,
          parentId: meta?.groupId,
          lineRange: toolLineRange(input),
        });
        state.status = label;
        break;
      }
      case 'tool-finished': {
        const tc = event.toolCall || {};
        const id = tc.toolCallId || tc.id || '';
        const name = tc.toolName || tc.name || '';
        const input = (typeof tc.input === 'object' && tc.input) || tc.arguments || {};
        const row =
          state.activities.find((a) => a.id === id) ||
          state.activities.filter((a) => a.id !== 'thinking_live').slice(-1)[0];
        if (row) {
          row.done = true;
          row.label = completedToolLabel(name || row.label, input, row.label);
          const msg = event.message;
          const parts = msg?.content || msg?.parts || [];
          const preview = parts
            .map((p: any) => {
              if (typeof p.text === 'string') return p.text;
              if (p.type === 'tool-result') {
                return typeof p.output === 'string' ? p.output : JSON.stringify(p.output);
              }
              return '';
            })
            .filter(Boolean)
            .join('\n');
          if (preview) row.resultPreview = truncate(preview, 600);
        }
        if (grouping) {
          grouping.liveBatch = grouping.liveBatch.filter((n) => n !== name);
          grouping.orch?.noteTools([name]);
        }
        const stillLive = state.activities.some((a) => !a.done && a.id !== 'thinking_live');
        const liveKids = state.activities.filter((a) => !a.done && a.id !== 'thinking_live' && Boolean(a.parentId));
        state.status = liveKids.length
          ? liveKids[liveKids.length - 1]?.label || 'Thinking'
          : stillLive
            ? state.activities.filter((a) => !a.done).slice(-1)[0]?.label || 'Thinking'
            : 'Thinking';
        break;
      }
      case 'status-notice':
        state.status = olkilStatus(event.message) || state.status;
        break;
      case 'run-failed': {
        const failMsg = event.error?.message || String(event.error || 'Run failed');
        if (isMaxIterationsError(failMsg)) {
          // Continue loop handles this — do not surface as a hard failure mid-run.
          state.status = state.fileChanges.length ? 'Editing' : 'Thinking';
          break;
        }
        state.error = failMsg;
        state.status = 'Failed';
        break;
      }
      case 'run-finished':
        if (event.result?.outputText) {
          state.text = event.result.outputText;
        }
        state.status = 'Done';
        if (grouping) {
          this.ensurePhaseGroup(state, grouping, grouping.phase);
          const meta = groupMeta(grouping.phase);
          const parent = state.activities.find((a) => a.id === meta.groupId);
          if (parent) parent.done = true;
        }
        break;
      default:
        break;
    }
  }
}

let runtimeHost: OlkilClineRuntimeHost | null = null;

export function getOlkilClineRuntime(): OlkilClineRuntimeHost {
  if (!runtimeHost) {
    runtimeHost = new OlkilClineRuntimeHost();
  }
  return runtimeHost;
}
