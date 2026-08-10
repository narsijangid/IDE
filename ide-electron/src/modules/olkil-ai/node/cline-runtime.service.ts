/**
 * OLKIL coding-agent runtime host (Node).
 * Engine: @cline/sdk Agent + default tools. User-facing branding: OLKIL only.
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
  kind: 'thinking' | 'reading' | 'searching' | 'editing' | 'running' | 'browsing' | 'todo' | 'done';
  label: string;
  done?: boolean;
  filePath?: string;
  command?: string;
  argsPreview?: string;
  resultPreview?: string;
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
    abort: (reason?: unknown) => void;
  };
  createDefaultExecutors: (options?: any) => any;
  createDefaultTools: (options: any) => Array<{ name: string }>;
};

let sdkPromise: Promise<ClineSdk> | null = null;
let runtimeGlobalsReady = false;

function ensureClineRuntimeGlobals(): void {
  if (runtimeGlobalsReady) {
    return;
  }
  runtimeGlobalsReady = true;
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
    sdkPromise = dynamicImport('@cline/sdk').catch((err) => {
      sdkPromise = null;
      throw err;
    });
  }
  return sdkPromise;
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
  if (/read|file/.test(n) && !/edit|write|create|replace/.test(n)) return 'reading';
  if (/search|grep|find|codebase/.test(n)) return 'searching';
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
    .trim();
}

function friendlyToolLabel(toolName: string, input: any): string {
  const n = (toolName || 'tool').toLowerCase();
  const file =
    input?.path || input?.file_path || input?.filePath || input?.target_file || '';
  const base = file ? path.basename(String(file)) : '';
  if (/read_files|read_file|read/.test(n)) return base ? `Reading ${base}` : 'Reading files';
  if (/search_codebase|search|grep/.test(n)) {
    const q = input?.query || input?.pattern || '';
    return q ? `Searching “${truncate(String(q), 36)}”` : 'Searching codebase';
  }
  if (/run_commands|bash|shell|command/.test(n)) {
    const cmd = typeof input?.command === 'string' ? input.command : '';
    return cmd ? `Running $ ${truncate(cmd, 48)}` : 'Running command';
  }
  if (/editor|apply_patch|write|edit|str_replace|create/.test(n)) {
    return base ? `Editing ${base}` : 'Editing files';
  }
  if (/fetch_web|web/.test(n)) return 'Fetching web content';
  if (/ask_question/.test(n)) return 'Asking a question';
  return base ? `${toolName} · ${base}` : toolName || 'Working…';
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
 * Wrap Cline's editor executor so each write also emits an Olkil file-change
 * record (before/after) for Accept / Revert cards in chat.
 */
function wrapEditorForFileChanges(
  editor: ((input: any, cwd: string, ctx: any) => Promise<string>) | undefined,
  onChange: (change: ClineRuntimeFileChange) => void,
): typeof editor {
  if (!editor) return editor;
  return async (input: any, cwd: string, ctx: any) => {
    const rel = String(input?.path || '');
    const abs = rel ? resolveEditPath(cwd, rel) : '';
    const before = abs ? readFileSafe(abs) : null;
    const kind: FileChangeKind =
      before == null ? 'create' : input?.insert_line != null ? 'edit' : 'edit';

    const result = await editor(input, cwd, ctx);

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
      status: 'OLKIL agent starting…',
    };
    this.states.set(runId, state);

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

      const cwd = request.workspaceRoot || process.cwd();
      const mode = request.mode;
      const userMode = chatModeToUserMode(mode);

      const systemPrompt = buildClineStyleSystemPrompt({
        mode,
        workspaceRoot: cwd,
        activeFile: request.activeFile,
        platform: `${os.platform()} ${os.release()}`,
        ideName: 'OLKIL',
        rules: request.rules,
        identity: `# Identity
- Product / IDE: OLKIL. You are the coding agent inside OLKIL.
- Never claim to be Cline, ChatGPT, Claude, Gemini, Laguna, or Poolside as the product name.
- Selected model: ${option.publicName || option.displayName || option.label}.`,
      });

      const baseExecutors = sdk.createDefaultExecutors
        ? sdk.createDefaultExecutors({})
        : {};

      const executors = {
        ...baseExecutors,
        editor: wrapEditorForFileChanges(baseExecutors.editor, (change) => {
          // Merge successive edits to same path into one card baseline
          const existing = state.fileChanges.find(
            (c) => path.resolve(c.path) === path.resolve(change.path),
          );
          if (existing) {
            existing.afterContent = change.afterContent;
            existing.kind = existing.beforeContent == null ? 'create' : 'edit';
          } else {
            state.fileChanges.push(change);
          }
          state.status = `Edited ${path.basename(change.path)}`;
        }),
      };

      const isPlanOrAsk = mode === 'plan' || mode === 'ask';
      const tools = sdk.createDefaultTools({
        executors,
        enableReadFiles: true,
        enableSearch: true,
        enableBash: true,
        enableWebFetch: true,
        enableEditor: !isPlanOrAsk,
        enableApplyPatch: false,
        enableSkills: false,
        enableAskQuestion: false,
        enableSubmitAndExit: false,
      });

      const autoApprove = request.autoApprove !== false && mode === 'agent';

      const AgentCtor = sdk.Agent;
      const agent = new AgentCtor({
        providerId,
        modelId: option.model,
        apiKey,
        baseUrl,
        systemPrompt,
        tools,
        maxIterations: mode === 'ask' ? 12 : mode === 'plan' ? 16 : 48,
        toolExecution: 'parallel',
        requestToolApproval: async () => ({ approved: autoApprove || mode === 'agent' }),
        onEvent: (event: any) => {
          this.handleEvent(state, event);
        },
      } as any);

      this.aborts.set(runId, agent);
      state.status = 'Working…';

      const wrappedPrompt = `<user_input mode="${userMode}">${request.prompt}</user_input>`;
      const result = await agent.run(wrappedPrompt);

      state.text = (result?.outputText || state.text || '').trim();
      if (result?.error) {
        state.error = result.error.message || String(result.error);
      }
      state.status = state.error ? 'Failed' : 'Done';
      state.done = true;
      return state;
    } catch (e: any) {
      state.error = e?.message || String(e);
      state.status = 'Failed';
      state.done = true;
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

  private handleEvent(state: ClineRuntimeState, event: any) {
    if (!event || !event.type) return;
    switch (event.type) {
      case 'assistant-text-delta':
        state.text = event.accumulatedText || state.text + (event.text || '');
        state.status = 'Writing…';
        break;
      case 'assistant-reasoning-delta': {
        state.reasoning = event.accumulatedText || state.reasoning || '';
        state.status = 'Thinking…';
        // Mirror reasoning into a live thinking activity for the chat timeline
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
        const filePath = input.path || input.file_path || input.filePath || input.target_file;
        state.activities.push({
          id,
          kind: toolKind(name),
          label,
          done: false,
          filePath: filePath ? String(filePath) : undefined,
          command: typeof input.command === 'string' ? input.command : undefined,
          argsPreview: truncate(JSON.stringify(input)),
        });
        state.status = label;
        break;
      }
      case 'tool-finished': {
        const tc = event.toolCall || {};
        const id = tc.toolCallId || tc.id || '';
        const row =
          state.activities.find((a) => a.id === id) ||
          state.activities.filter((a) => a.id !== 'thinking_live').slice(-1)[0];
        if (row) {
          row.done = true;
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
        break;
      }
      case 'status-notice':
        state.status = olkilStatus(event.message) || state.status;
        break;
      case 'run-failed':
        state.error = event.error?.message || String(event.error || 'Run failed');
        state.status = 'Failed';
        break;
      case 'run-finished':
        if (event.result?.outputText) {
          state.text = event.result.outputText;
        }
        state.status = 'Done';
        break;
      default:
        break;
    }
  }
}

export const olkilClineRuntime = new OlkilClineRuntimeHost();
