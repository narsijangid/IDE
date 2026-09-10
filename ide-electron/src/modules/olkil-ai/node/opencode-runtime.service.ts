import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  ClineEngineActivity,
  ClineEngineFileChange,
  ClineEngineRunRequest,
  ClineEngineRunState,
  FileChangeKind,
} from '../common';
import { findModel, applyCustomModelEndpoints, customEndpointFor, DEFAULT_MODEL_ID, type AiProviderId, type CustomModelEndpoint } from '../common/models';
import { isHeavyProjectBuildCommand, userAskedToRunBuild } from '../common/shell-policy';
import { routeOpenRouterModel } from '../common/auto-router';
import {
  EMBEDDED_DEEPSEEK_API_KEY,
  EMBEDDED_ENV,
  EMBEDDED_OPENROUTER_API_KEY,
  EMBEDDED_POOLSIDE_API_KEY,
} from './embedded-secrets';
import { assertOlkilWallet, chargeOlkilWallet, addApiUsage, parseProviderUsage, type OlkilApiUsage } from './olkil-wallet.service';
import { opencodeAgentForMode, opencodeModelRef, toOpencodeMcp } from './opencode/config';
import { OpencodeSidecar } from './opencode/sidecar';
import { startOpencodeDownload } from './opencode/binary';
import type { OpencodeMcpServer, OpencodeProviderSecrets } from './opencode/config';
import { refreshOpenRouterCatalog } from './openrouter';

type ActivityKind = ClineEngineActivity['kind'];

interface SessionHandle {
  id: string;
  directory: string;
  turns: number;
  createdAt: number;
}

interface LiveRun {
  runId: string;
  sessionId: string;
  directory: string;
  mode: 'agent' | 'plan' | 'ask';
  state: ClineEngineRunState;
  autoApprove: boolean;
  autoApproveEdits: boolean;
  autoApproveWeb: boolean;
  terminalAutoRun: 'always' | 'allowlist' | 'never';
  terminalAllowlist: string[];
  userPrompt: string;
  inputTokens: number;
  outputTokens: number;
  apiUsage: OlkilApiUsage | null;
  userMessageIds: Set<string>;
  fileBefore: Map<string, string | null>;
  lastDiffAt: number;
  sawTool?: boolean;
  finish: (error?: string) => void;
}

function isHiddenEngineWrap(text: string): boolean {
  const t = text || '';
  return (
    /You are the coding agent inside OLKIL/i.test(t) ||
    /<user_input\s+mode=/i.test(t) ||
    /<userinput\s+mode=/i.test(t)
  );
}

function isInsideWorkspace(directory: string, filePath: string): boolean {
  const abs = resolveWorkspacePath(directory, filePath);
  if (!abs) {
    return false;
  }
  const root = path.resolve(directory);
  const rel = path.relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const MAX_FILE_SNAPSHOT_CHARS = 180_000;
const MAX_LIVE_ACTIVITIES = 40;
const SESSION_ROTATE_TURNS = 32;
const SESSION_MAX_AGE_MS = 30 * 60 * 1000;
const SIDECAR_IDLE_MS = 12 * 60 * 1000;

function resolveWorkspacePath(directory: string, filePath: string): string {
  const raw = String(filePath || '').trim();
  if (!raw) {
    return raw;
  }
  if (path.isAbsolute(raw)) {
    return path.normalize(raw);
  }
  return path.resolve(directory, raw);
}

function clipSnapshot(text: string | null): string | null {
  if (text == null) {
    return null;
  }
  if (text.length <= MAX_FILE_SNAPSHOT_CHARS) {
    return text;
  }
  return text.slice(0, MAX_FILE_SNAPSHOT_CHARS);
}

const DEFAULT_DEEPSEEK_BASE = 'https://api.deepseek.com';
const DEFAULT_OLLAMA_BASE = 'http://127.0.0.1:11434';
const DEFAULT_OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

function readEnvFile(): Record<string, string> {
  const out: Record<string, string> = { ...EMBEDDED_ENV };
  try {
    const envPath = path.join(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) {
      return out;
    }
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) {
        continue;
      }
      let v = m[2] || '';
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[m[1]] = v;
    }
  } catch {
    // ignore
  }
  return out;
}

function firstKey(...vals: Array<string | undefined>): string {
  for (const val of vals) {
    const v = String(val || '').trim();
    if (v && !/your_|changeme|placeholder/i.test(v)) {
      return v;
    }
  }
  return '';
}

function providerSecrets(): OpencodeProviderSecrets {
  const env = readEnvFile();
  return {
    deepseekKey: firstKey(
      process.env.DEEPSEEK_API_KEY,
      env.DEEPSEEK_API_KEY,
      EMBEDDED_DEEPSEEK_API_KEY,
    ),
    deepseekBase:
      process.env.DEEPSEEK_BASE_URL || env.DEEPSEEK_BASE_URL || DEFAULT_DEEPSEEK_BASE,
    poolsideKey: firstKey(
      process.env.POOLSIDE_API_KEY,
      env.POOLSIDE_API_KEY,
      EMBEDDED_POOLSIDE_API_KEY,
    ),
    ollamaBase: process.env.OLLAMA_BASE_URL || env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE,
    openrouterKey: firstKey(
      process.env.OPENROUTER_API_KEY,
      env.OPENROUTER_API_KEY,
      EMBEDDED_OPENROUTER_API_KEY,
    ),
    openrouterBase:
      process.env.OPENROUTER_BASE_URL || env.OPENROUTER_BASE_URL || DEFAULT_OPENROUTER_BASE,
  };
}

function truncate(text: string, max = 240): string {
  const value = String(text || '');
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}…`;
}

function toolKind(name: string): ActivityKind {
  const n = name.toLowerCase();
  if (/edit|write|patch|apply/.test(n)) {
    return 'editing';
  }
  if (/bash|shell|cmd|terminal/.test(n)) {
    return 'running';
  }
  if (/grep|glob|search|find|lsp|symbol/.test(n)) {
    return 'searching';
  }
  if (/read|list|ls|file/.test(n)) {
    return 'reading';
  }
  if (/web|fetch|browser/.test(n)) {
    return 'browsing';
  }
  if (/todo/.test(n)) {
    return 'todo';
  }
  if (/task|explore|agent/.test(n)) {
    return 'searching';
  }
  return 'info';
}

function isInternalToolName(name: string): boolean {
  return /^question$/i.test(String(name || '').trim());
}

function looksLikeSessionRecap(text: string): boolean {
  const t = text || '';
  let n = 0;
  if (/\bObjective\b/i.test(t)) n++;
  if (/\bWork State\b/i.test(t)) n++;
  if (/\bNext Move\b/i.test(t)) n++;
  if (/\bImportant Details\b/i.test(t)) n++;
  if (/\bRelevant Files\b/i.test(t)) n++;
  if (/\bAwait the user's actual task\b/i.test(t)) n++;
  if (/\bCompacting context\b/i.test(t)) n++;
  return n >= 2;
}

function friendlyToolLabel(name: string, input: Record<string, unknown>): string {
  const file = String(input.path || input.file_path || input.filePath || input.target_file || input.glob || '');
  const query = String(input.pattern || input.query || input.search || '');
  const command = String(input.command || '');
  const base = path.basename(file.replace(/\\/g, '/')) || file;
  switch (name) {
    case 'read':
      return base ? `Reading ${base}` : 'Reading file';
    case 'edit':
    case 'write':
      return base ? `Editing ${base}` : 'Editing file';
    case 'grep':
    case 'glob':
    case 'list':
    case 'semanticsearch':
    case 'codesearch':
      return query ? `Reading codebase · ${truncate(query, 40)}` : 'Reading codebase';
    case 'bash':
      return command ? truncate(command, 64) : 'Running command';
    case 'task':
      return String(input.description || input.prompt || input.subagent_type || 'Exploring codebase');
    default:
      return name;
  }
}

function inputFromPart(part: any): Record<string, unknown> {
  const state = part?.state;
  if (state && typeof state.input === 'object' && state.input) {
    return state.input as Record<string, unknown>;
  }
  return {};
}

function sessionIdOf(event: any): string {
  return String(
    event?.properties?.sessionID ||
      event?.properties?.part?.sessionID ||
      event?.properties?.info?.sessionID ||
      '',
  );
}

function permissionIdOf(permission: any): string {
  return String(permission?.id || permission?.permissionID || permission?.requestID || permission?.info?.id || '');
}

function errorMessage(error: any): string {
  if (!error) {
    return '';
  }
  if (typeof error === 'string') {
    return error;
  }
  return String(error?.data?.message || error?.message || error?.name || error);
}

/**
 * OpenCode runtime behind the existing clineRun/getState/cancel IPC.
 * OpenCode owns the agent loop, compaction, LSP, and tool execution in a
 * sidecar process so large repos cannot freeze the IDE node host.
 */
export class OlkilOpencodeRuntimeHost {
  private sidecar: OpencodeSidecar | null = null;
  private readonly states = new Map<string, ClineEngineRunState>();
  private readonly lives = new Map<string, LiveRun>();
  private readonly sessions = new Map<string, SessionHandle>();
  private readonly runBySession = new Map<string, string>();
  private readonly usage = new Map<string, OlkilApiUsage>();
  private eventsBound = false;
  private mcpKey = '';
  private lastMcpServers: OpencodeMcpServer[] | undefined;
  private customKey = '';
  private lastCustomModels: CustomModelEndpoint[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  async prewarm(): Promise<void> {
    await this.ensureSidecar();
  }

  getState(runId: string): ClineEngineRunState {
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

  async cancel(runId: string): Promise<boolean> {
    const live = this.lives.get(runId);
    const state = this.states.get(runId);
    if (live && this.sidecar) {
      try {
        await this.sidecar.request('POST', `/session/${live.sessionId}/abort`, {
          query: { directory: live.directory },
        });
      } catch {
        // ignore
      }
      live.finish('Stopped');
    }
    if (state && !state.done) {
      state.done = true;
      state.status = 'Stopped';
      state.error = state.error || 'Stopped';
    }
    return Boolean(live || state);
  }

  async run(request: ClineEngineRunRequest): Promise<ClineEngineRunState> {
    const { runId } = request;
    const state: ClineEngineRunState = {
      runId,
      done: false,
      text: '',
      reasoning: '',
      activities: [],
      fileChanges: [],
      status: 'Planning next move',
    };
    this.states.set(runId, state);

    try {
      applyCustomModelEndpoints(request.customModels);
      const routedId = routeOpenRouterModel({
        modelId: request.modelId || DEFAULT_MODEL_ID,
        optimizeFor: request.autoOptimizeFor,
        userText: request.prompt,
        messageCount: 2,
      });
      const option = findModel(routedId);
      if (option.provider === 'custom') {
        const ep = customEndpointFor(option.id);
        if (!ep?.baseUrl) {
          throw new Error('This custom model has no API base URL. Open Settings → Models and edit it.');
        }
        if (!ep.apiKey) {
          throw new Error('This custom model has no API key. Open Settings → Models and add one.');
        }
      }
      await assertOlkilWallet(option.provider);
      const secrets = providerSecrets();
      if (option.provider === 'openrouter' && secrets.openrouterKey) {
        await refreshOpenRouterCatalog(secrets.openrouterKey, secrets.openrouterBase);
      }
      if (option.provider === 'openrouter' && !secrets.openrouterKey) {
        throw new Error(
          'Cloud models are not configured in this OLKIL build. Reinstall the latest app from olkil.com.',
        );
      }
      if (option.provider === 'deepseek' && !secrets.deepseekKey) {
        throw new Error(
          'This model is not configured in this OLKIL build. Reinstall the latest app from olkil.com.',
        );
      }
      this.syncMcp(this.mergeMcp(request));
      this.syncCustomModels(request.customModels);
      const sidecar = await this.ensureSidecar();
      const directory = this.sessionDirectory(request.workspaceRoot);
      const conversationKey = `${directory}::${request.conversationId || runId}`;
      const session = await this.ensureSession(sidecar, conversationKey, directory);
      const model = opencodeModelRef(option);
      const agent = opencodeAgentForMode(request.mode);
      const autoApprove = request.autoApprove !== false && request.mode === 'agent';
      const terminalAutoRun =
        request.mode === 'agent' ? request.terminalAutoRun || (autoApprove ? 'always' : 'never') : 'never';
      const autoApproveEdits = request.mode === 'agent' && request.autoApproveEdits !== false;
      const autoApproveWeb = request.mode === 'agent' && request.autoApproveWeb !== false;

      for (const [rid, prev] of this.lives) {
        if (prev.sessionId === session.id && rid !== runId) {
          prev.finish('Stopped');
        }
      }

      const done = new Promise<void>((resolve) => {
        const live: LiveRun = {
          runId,
          sessionId: session.id,
          directory,
          mode: request.mode,
          state,
          autoApprove,
          autoApproveEdits,
          autoApproveWeb,
          terminalAutoRun,
          terminalAllowlist: request.terminalAllowlist || [],
          userPrompt: request.prompt || '',
          inputTokens: 0,
          outputTokens: 0,
          apiUsage: null,
          userMessageIds: new Set<string>(),
          fileBefore: new Map<string, string | null>(),
          lastDiffAt: 0,
          sawTool: false,
          finish: (error?: string) => {
            if (state.done) {
              resolve();
              return;
            }
            if (error && error !== 'Stopped') {
              state.error = error;
              state.status = 'Failed';
            } else {
              state.status = '';
            }
            state.done = true;
            this.lives.delete(runId);
            for (const [sid, rid] of [...this.runBySession.entries()]) {
              if (rid === runId) {
                this.runBySession.delete(sid);
              }
            }
            this.armIdleRecycle();
            resolve();
          },
        };
        this.lives.set(runId, live);
        this.runBySession.set(session.id, runId);
      });

      const parts: Array<Record<string, unknown>> = [];
      parts.push({
        type: 'text',
        text: this.wrapPrompt(request, session.turns),
      });

      const tools =
        request.mode === 'ask'
          ? { edit: false, write: false, bash: false, patch: false }
          : request.mode === 'plan'
            ? { edit: false, write: false, bash: false }
            : undefined;

      await sidecar.request('POST', `/session/${session.id}/prompt_async`, {
        query: { directory },
        body: {
          agent,
          model,
          tools,
          parts,
        },
      });

      await done;
      const billed = this.usage.get(runId) || null;
      await this.syncDiffs(session.id, directory, state);
      await this.charge(option.provider, option.model, runId, billed);
      this.usage.delete(runId);
      return state;
    } catch (error: any) {
      const live = this.lives.get(runId);
      if (live && !state.done) {
        live.finish(error?.message || String(error));
      }
      state.error = error?.message || String(error);
      state.status = 'Failed';
      state.done = true;
      this.lives.delete(runId);
      for (const [sid, rid] of [...this.runBySession.entries()]) {
        if (rid === runId) {
          this.runBySession.delete(sid);
        }
      }
      return state;
    } finally {
      setTimeout(() => {
        const cur = this.states.get(runId);
        if (cur?.done) {
          this.states.delete(runId);
        }
      }, 120_000).unref?.();
    }
  }

  private wrapPrompt(request: ClineEngineRunRequest, sessionTurns = 1): string {
    const user = String(request.prompt || '').trim();
    const active =
      request.activeFile && isInsideWorkspace(this.sessionDirectory(request.workspaceRoot), request.activeFile)
        ? `Active file: ${request.activeFile}`
        : '';
    if (sessionTurns > 1) {
      return [active, user].filter(Boolean).join('\n\n');
    }
    const bits: string[] = [];
    const root = request.workspaceRoot?.trim();
    if (root) {
      bits.push(`Workspace: ${root}. Stay inside this folder.`);
    }
    bits.push(
      `You are OLKIL's coding agent. Product name is OLKIL. Never say you are OpenCode, Cursor, Cline, ChatGPT, or Claude.`,
    );
    bits.push(
      `Never run npm run build, yarn build, pnpm build, vite build, or next build after edits unless the user explicitly asked. Those commands are too slow as a verify step.`,
    );
    if (active) {
      bits.push(active);
    }
    if (request.rules?.trim()) {
      bits.push(`<project_rules>\n${request.rules.trim()}\n</project_rules>`);
    }
    bits.push(user);
    return bits.join('\n\n');
  }

  private sessionDirectory(workspaceRoot?: string): string {
    const root = (workspaceRoot || '').trim();
    if (root) {
      return path.resolve(root);
    }
    const fallback = path.join(os.homedir(), '.olkil', 'no-workspace');
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }

  async ensureSidecar(): Promise<OpencodeSidecar> {
    if (!this.sidecar) {
      this.sidecar = new OpencodeSidecar(providerSecrets(), {
        mcp: toOpencodeMcp(this.lastMcpServers),
        customModels: this.lastCustomModels,
      });
    }
    await this.sidecar.ensureStarted();
    if (!this.eventsBound) {
      this.eventsBound = true;
      this.sidecar.onEvent((event) => this.handleEvent(event));
    }
    this.armIdleRecycle();
    return this.sidecar;
  }

  private armIdleRecycle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      if (this.lives.size > 0) {
        this.armIdleRecycle();
        return;
      }
      this.sidecar?.close();
      this.sidecar = null;
      this.eventsBound = false;
      this.sessions.clear();
      this.idleTimer = null;
    }, SIDECAR_IDLE_MS);
    this.idleTimer.unref?.();
  }

  private async ensureSession(
    sidecar: OpencodeSidecar,
    key: string,
    directory: string,
  ): Promise<SessionHandle> {
    const existing = this.sessions.get(key);
    const stale =
      existing &&
      (existing.turns >= SESSION_ROTATE_TURNS || Date.now() - existing.createdAt > SESSION_MAX_AGE_MS);
    if (existing && existing.directory === directory && !stale) {
      existing.turns += 1;
      return existing;
    }
    if (existing && stale) {
      this.sessions.delete(key);
    }
    const created = await sidecar.request<any>('POST', '/session', {
      query: { directory },
      body: { title: 'OLKIL' },
    });
    const id = created?.id || created?.data?.id;
    if (!id) {
      throw new Error('OpenCode session.create returned no id');
    }
    const handle = { id: String(id), directory, turns: 1, createdAt: Date.now() };
    this.sessions.set(key, handle);
    return handle;
  }

  private bindChildSession(event: any): void {
    const info = event?.properties?.info || event?.properties;
    const id = String(info?.id || event?.properties?.sessionID || '');
    const parent = String(info?.parentID || info?.parentId || '');
    if (!id || !parent) {
      return;
    }
    const runId = this.runBySession.get(parent);
    if (runId) {
      this.runBySession.set(id, runId);
    }
  }

  private liveForEvent(event: any): LiveRun | undefined {
    const sid = sessionIdOf(event);
    if (sid) {
      const runId = this.runBySession.get(sid);
      if (runId) {
        return this.lives.get(runId);
      }
    }
    if (this.lives.size === 1) {
      return this.lives.values().next().value;
    }
    return undefined;
  }

  private handleEvent(event: any): void {
    if (!event || typeof event !== 'object') {
      return;
    }
    if (event.type === 'session.created' || event.type === 'session.updated') {
      this.bindChildSession(event);
    }
    const live = this.liveForEvent(event);
    if (!live) {
      return;
    }
    const state = live.state;
    switch (event.type) {
      case 'message.updated': {
        const info = event.properties?.info;
        if (info?.role === 'user' && info.id) {
          live.userMessageIds.add(String(info.id));
        }
        break;
      }
      case 'message.part.updated': {
        const part = event.properties?.part;
        if (!part) {
          return;
        }
        if (part.type === 'text' && typeof part.text === 'string' && !part.synthetic) {
          if (live.userMessageIds.has(String(part.messageID || '')) || isHiddenEngineWrap(part.text)) {
            break;
          }
          if (looksLikeSessionRecap(part.text)) {
            break;
          }
          state.text = part.text;
          state.status = 'Writing';
          const think = state.activities.find((a) => a.id === 'thinking_live' && !a.done);
          if (think) {
            think.done = true;
            think.label = 'Thought';
          }
        } else if (part.type === 'reasoning' && typeof part.text === 'string') {
          state.reasoning = part.text;
          const think = state.activities.find((a) => a.id === 'thinking_live' && !a.done);
          if (live.sawTool) {
            if (think) {
              think.done = true;
              think.label = 'Thought';
            }
            break;
          }
          state.status = 'Planning next move';
          this.upsertActivity(state, {
            id: 'thinking_live',
            kind: 'thinking',
            label: 'Planning next move',
            done: false,
            resultPreview: truncate(part.text, 800),
          });
        } else if (part.type === 'tool') {
          this.applyToolPart(live, part);
        } else if (part.type === 'patch' && Array.isArray(part.files)) {
          for (const file of part.files) {
            this.noteFileTouch(live, String(file || ''));
          }
          this.queueDiffSync(live);
        } else if (part.type === 'compaction') {
          break;
        } else if (part.type === 'step-finish') {
          const stepUsage = parseProviderUsage(part.tokens || part.usage);
          if (stepUsage) {
            live.apiUsage = addApiUsage(live.apiUsage, stepUsage);
            live.inputTokens = live.apiUsage.promptTokens;
            live.outputTokens = live.apiUsage.completionTokens;
            this.usage.set(live.runId, live.apiUsage);
          }
        }
        break;
      }
      case 'permission.asked': {
        const permission = event.properties;
        const id = permissionIdOf(permission);
        if (!id) {
          break;
        }
        const response = decidePermissionResponse(live, permission);
        const sid = sessionIdOf(event) || live.sessionId;
        void this.sidecar
          ?.request('POST', `/session/${sid}/permissions/${id}`, {
            query: { directory: live.directory },
            body: { response },
          })
          .catch(() => undefined);
        break;
      }
      case 'question.asked': {
        const q = event.properties || {};
        const header = String(q.questions?.[0]?.header || q.questions?.[0]?.question || q.text || '');
        if (header) {
          state.status = truncate(header, 72);
        }
        break;
      }
      case 'file.edited': {
        const filePath = String(event.properties?.file || '');
        if (filePath) {
          state.status = `Editing ${path.basename(filePath)}`;
          this.noteFileTouch(live, filePath);
          this.queueDiffSync(live);
        }
        break;
      }
      case 'session.diff': {
        const diffs = event.properties?.diff;
        if (Array.isArray(diffs)) {
          this.applyDiffs(state, diffs, live.directory);
        }
        break;
      }
      case 'session.status': {
        const status = event.properties?.status;
        if (status?.type === 'busy') {
          state.status = state.status || 'Working';
        } else if (status?.type === 'retry') {
          state.status = `Retrying${status.message ? ` · ${status.message}` : ''}`;
        }
        break;
      }
      case 'session.compacted':
        break;
      case 'todo.updated': {
        const todos = event.properties?.todos || [];
        const active = todos.find((t: any) => t.status === 'in_progress') || todos[0];
        if (active?.content && !looksLikeSessionRecap(String(active.content))) {
          this.upsertActivity(state, {
            id: `todo_${active.id || 'live'}`,
            kind: 'todo',
            label: String(active.content),
            done: active.status === 'completed',
          });
        }
        break;
      }
      case 'session.error': {
        const errSid = String(event.properties?.sessionID || '');
        if (errSid && errSid !== live.sessionId) {
          break;
        }
        const msg = errorMessage(event.properties?.error);
        if (msg && !/abort/i.test(msg)) {
          live.finish(msg);
        }
        break;
      }
      case 'session.idle': {
        const sid = String(event.properties?.sessionID || event.properties?.info?.id || '');
        if (sid && sid !== live.sessionId) {
          break;
        }
        const think = state.activities.find((a) => a.id === 'thinking_live' && !a.done);
        if (think) {
          think.done = true;
          think.label = 'Thought';
        }
        live.finish();
        break;
      }
      default:
        break;
    }
  }

  private applyToolPart(live: LiveRun, part: any): void {
    const state = live.state;
    const name = String(part.tool || 'tool');
    if (isInternalToolName(name)) {
      const think = state.activities.find((a) => a.id === 'thinking_live' && !a.done);
      if (think) {
        think.done = true;
        think.label = 'Thought';
      }
      return;
    }
    const id = String(part.callID || part.id);
    const input = inputFromPart(part);
    const meta = part.state?.metadata && typeof part.state.metadata === 'object' ? part.state.metadata : {};
    const childSid = String(meta.sessionId || meta.sessionID || '');
    if (childSid && /^task$/i.test(name)) {
      this.runBySession.set(childSid, live.runId);
    }
    const status = part.state?.status;
    const filePath = String(
      input.path ||
        input.file_path ||
        input.filePath ||
        input.target_file ||
        meta.filepath ||
        meta.file ||
        meta.path ||
        '',
    );
    const command = typeof input.command === 'string' ? input.command : undefined;
    const done = status === 'completed' || status === 'error';
    const resultPreview =
      status === 'error'
        ? truncate(String(part.state?.error || 'error'), 400)
        : truncate(String(part.state?.output || part.state?.title || ''), 400);
    this.upsertActivity(state, {
      id,
      kind: toolKind(name),
      label: part.state?.title || friendlyToolLabel(name, input),
      done,
      filePath: filePath || undefined,
      command,
      argsPreview: truncate(JSON.stringify(input)),
      resultPreview: resultPreview || undefined,
    });
    live.sawTool = true;
    if (!done) {
      state.status = friendlyToolLabel(name, input);
    } else if (!state.text) {
      const stillRunning = state.activities.some(
        (a) => a.id !== 'thinking_live' && a.kind !== 'thinking' && !a.done,
      );
      if (!stillRunning) {
        state.status = 'Planning next move';
      }
    }
    const think = state.activities.find((a) => a.id === 'thinking_live' && !a.done);
    if (think) {
      think.done = true;
      think.label = 'Thought';
    }
    if (filePath && /edit|write|patch|apply/i.test(name)) {
      const abs = resolveWorkspacePath(live.directory, filePath);
      if (status === 'pending' || status === 'running') {
        this.snapshotBefore(live, abs);
      }
      if (status === 'completed') {
        this.recordDiskChange(live, abs);
        this.queueDiffSync(live);
      }
    }
  }

  private snapshotBefore(live: LiveRun, abs: string): void {
    if (!isInsideWorkspace(live.directory, abs) || live.fileBefore.has(abs)) {
      return;
    }
    try {
      const stat = fs.statSync(abs);
      if (stat.size > MAX_FILE_SNAPSHOT_CHARS) {
        live.fileBefore.set(abs, null);
        return;
      }
      const text = fs.readFileSync(abs, 'utf8');
      live.fileBefore.set(abs, text.length > MAX_FILE_SNAPSHOT_CHARS ? text.slice(0, MAX_FILE_SNAPSHOT_CHARS) : text);
    } catch {
      live.fileBefore.set(abs, null);
    }
  }

  private recordDiskChange(live: LiveRun, abs: string): void {
    if (!isInsideWorkspace(live.directory, abs)) {
      return;
    }
    let after: string | null = null;
    try {
      const stat = fs.statSync(abs);
      if (stat.size <= MAX_FILE_SNAPSHOT_CHARS) {
        after = fs.readFileSync(abs, 'utf8');
        if (after.length > MAX_FILE_SNAPSHOT_CHARS) {
          after = after.slice(0, MAX_FILE_SNAPSHOT_CHARS);
        }
      }
    } catch {
      after = null;
    }
    const before = live.fileBefore.has(abs) ? live.fileBefore.get(abs) ?? null : null;
    const kind: FileChangeKind =
      before == null ? (after == null ? 'edit' : 'create') : after == null ? 'delete' : 'edit';
    this.upsertFileChange(live.state, {
      id: `edit_${abs}`,
      kind,
      path: abs,
      beforeContent: before,
      afterContent: after,
    });
  }

  private upsertActivity(state: ClineEngineRunState, row: ClineEngineActivity): void {
    const existing = state.activities.find((a) => a.id === row.id);
    if (existing) {
      Object.assign(existing, row);
      return;
    }
    state.activities.push(row);
    if (state.activities.length > MAX_LIVE_ACTIVITIES) {
      const keep = state.activities.filter((a) => a.id === 'thinking_live' || !a.done);
      state.activities = keep.slice(-MAX_LIVE_ACTIVITIES);
    }
  }

  private noteFileTouch(live: LiveRun, filePath: string): void {
    const abs = resolveWorkspacePath(live.directory, filePath);
    if (!abs || !isInsideWorkspace(live.directory, abs)) {
      return;
    }
    this.recordDiskChange(live, abs);
  }

  private upsertFileChange(state: ClineEngineRunState, change: ClineEngineFileChange): void {
    if (!state.fileChanges) {
      state.fileChanges = [];
    }
    const existing = state.fileChanges.find(
      (c) =>
        path.normalize(c.path) === path.normalize(change.path) ||
        path.basename(c.path) === path.basename(change.path),
    );
    if (existing) {
      if (change.beforeContent != null) {
        existing.beforeContent = change.beforeContent;
      }
      if (change.afterContent != null) {
        existing.afterContent = change.afterContent;
      }
      existing.kind = change.kind;
      return;
    }
    state.fileChanges.push(change);
  }

  private applyDiffs(
    state: ClineEngineRunState,
    diffs: Array<{ file?: string; before?: string; after?: string }>,
    directory: string,
  ): void {
    for (const diff of diffs) {
      const filePath = String(diff.file || '');
      if (!filePath) {
        continue;
      }
      const abs = resolveWorkspacePath(directory, filePath);
      if (!isInsideWorkspace(directory, abs)) {
        continue;
      }
      const kind: FileChangeKind = diff.before == null || diff.before === '' ? 'create' : 'edit';
      this.upsertFileChange(state, {
        id: `diff_${abs}`,
        kind,
        path: abs,
        beforeContent: clipSnapshot(diff.before ?? null),
        afterContent: clipSnapshot(diff.after ?? null),
      });
    }
  }

  private queueDiffSync(live: LiveRun): void {
    const now = Date.now();
    if (now - live.lastDiffAt < 250) {
      return;
    }
    live.lastDiffAt = now;
    void this.syncDiffs(live.sessionId, live.directory, live.state);
  }

  private async syncDiffs(sessionId: string, directory: string, state: ClineEngineRunState): Promise<void> {
    if (!this.sidecar) {
      return;
    }
    try {
      const diffs = await this.sidecar.request<any>('GET', `/session/${sessionId}/diff`, {
        query: { directory },
      });
      const list = Array.isArray(diffs) ? diffs : diffs?.diff;
      if (Array.isArray(list)) {
        this.applyDiffs(state, list, directory);
      }
    } catch {
      // ignore
    }
  }

  private async charge(
    provider: AiProviderId,
    model: string,
    runId: string,
    billed?: OlkilApiUsage | null,
  ): Promise<void> {
    if (!billed || billed.totalTokens < 1) {
      if (provider === 'deepseek' || provider === 'openrouter') {
        console.warn('[olkil-wallet] skip charge: OpenCode run had no usage');
      }
      return;
    }
    await chargeOlkilWallet({
      provider,
      model,
      inputTokens: billed.promptTokens,
      outputTokens: billed.completionTokens,
      requestId: `${runId}:opencode`,
      usage: billed,
    });
  }

  private mergeMcp(request: ClineEngineRunRequest): OpencodeMcpServer[] {
    // Only MCP added in OLKIL Settings. Auto-wiring Cursor/Hostinger servers
    // floods the agent with extra tools and triggers endless compaction.
    const byName = new Map<string, OpencodeMcpServer>();
    for (const server of request.mcpServers || []) {
      if (!server?.name || server.enabled === false) {
        continue;
      }
      byName.set(server.name, { ...server, enabled: true });
    }
    return [...byName.values()];
  }

  private syncMcp(servers?: OpencodeMcpServer[]) {
    const enabled = (servers || []).filter((server) => server.enabled);
    const key = JSON.stringify(
      enabled.map((server) => ({
        name: server.name,
        type: server.type,
        command: server.command || '',
        url: server.url || '',
        env: fingerprintMap(server.env),
        headers: fingerprintMap(server.headers),
      })),
    );
    this.lastMcpServers = enabled;
    if (key === this.mcpKey) {
      return;
    }
    this.mcpKey = key;
    if (this.lives.size > 0) {
      return;
    }
    this.sidecar?.close();
    this.sidecar = null;
    this.eventsBound = false;
  }

  private syncCustomModels(models?: CustomModelEndpoint[]) {
    const enabled = (models || []).filter((m) => m?.id && m.model && m.baseUrl && m.apiKey);
    const key = JSON.stringify(
      enabled.map((m) => ({
        id: m.id,
        model: m.model,
        baseUrl: m.baseUrl,
        apiKey: m.apiKey,
      })),
    );
    this.lastCustomModels = enabled;
    if (key === this.customKey) {
      return;
    }
    this.customKey = key;
    if (this.lives.size > 0) {
      return;
    }
    this.sidecar?.close();
    this.sidecar = null;
    this.eventsBound = false;
  }
}

function decidePermissionResponse(live: LiveRun, permission: any): 'always' | 'once' | 'reject' {
  const kind = String(
    permission?.permission || permission?.type || permission?.tool || permission?.name || '',
  ).toLowerCase();
  const command = permissionCommand(permission);

  if (/(external.?directory|outside)/.test(kind)) {
    return 'reject';
  }
  if (isHeavyProjectBuildCommand(command) && !userAskedToRunBuild(live.userPrompt)) {
    return 'reject';
  }
  // Agent mode: never silently reject — that freezes the UI on "Planning next move"
  // while OpenCode waits. Plan/Ask still block writes.
  if (live.mode === 'agent') {
    return 'always';
  }
  if (/(bash|shell|command|terminal|cmd)/.test(kind) || (!kind && command)) {
    return 'reject';
  }
  if (/(edit|write|patch|file)/.test(kind)) {
    return 'reject';
  }
  return 'always';
}

function permissionCommand(permission: any): string {
  if (!permission) {
    return '';
  }
  const meta = permission.metadata || {};
  if (typeof meta.command === 'string') {
    return meta.command;
  }
  if (typeof permission.command === 'string') {
    return permission.command;
  }
  if (typeof permission.pattern === 'string') {
    return permission.pattern;
  }
  if (Array.isArray(permission.patterns) && permission.patterns[0]) {
    return String(permission.patterns[0]);
  }
  return '';
}

function fingerprintMap(map?: Record<string, string>): string {
  if (!map || !Object.keys(map).length) {
    return '';
  }
  return crypto
    .createHash('sha256')
    .update(
      Object.keys(map)
        .sort()
        .map((key) => `${key}:${map[key]}`)
        .join('|'),
    )
    .digest('hex')
    .slice(0, 16);
}

let host: OlkilOpencodeRuntimeHost | null = null;

export function getOlkilOpencodeRuntime(): OlkilOpencodeRuntimeHost {
  if (!host) {
    host = new OlkilOpencodeRuntimeHost();
  }
  return host;
}

/** Warm OpenCode after the window is usable. Binary download still starts immediately. */
export function scheduleOpencodePrewarm(delayMs = 12_000): void {
  startOpencodeDownload();
  setTimeout(() => {
    void getOlkilOpencodeRuntime().prewarm().catch(() => undefined);
  }, delayMs).unref?.();
}
