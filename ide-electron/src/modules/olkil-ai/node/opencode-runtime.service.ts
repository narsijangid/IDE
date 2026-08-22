import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { findModel, type AiProviderId } from '../common/models';
import type {
  ClineEngineActivity,
  ClineEngineFileChange,
  ClineEngineRunRequest,
  ClineEngineRunState,
  FileChangeKind,
} from '../common';
import {
  EMBEDDED_DEEPSEEK_API_KEY,
  EMBEDDED_ENV,
  EMBEDDED_POOLSIDE_API_KEY,
} from './embedded-secrets';
import { assertOlkilWallet, chargeOlkilWallet, countOlkilTokens, isLocalProvider } from './olkil-wallet.service';
import { opencodeAgentForMode, opencodeModelRef } from './opencode/config';
import { OpencodeSidecar } from './opencode/sidecar';
import type { OpencodeProviderSecrets } from './opencode/config';

type ActivityKind = ClineEngineActivity['kind'];

interface SessionHandle {
  id: string;
  directory: string;
}

interface LiveRun {
  runId: string;
  sessionId: string;
  directory: string;
  state: ClineEngineRunState;
  autoApprove: boolean;
  inputTokens: number;
  outputTokens: number;
  userMessageIds: Set<string>;
  fileBefore: Map<string, string | null>;
  lastDiffAt: number;
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

const DEFAULT_DEEPSEEK_BASE = 'https://api.deepseek.com';
const DEFAULT_OLLAMA_BASE = 'http://127.0.0.1:11434';

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

function providerSecrets(): OpencodeProviderSecrets {
  const env = readEnvFile();
  return {
    deepseekKey:
      process.env.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY || EMBEDDED_DEEPSEEK_API_KEY || '',
    deepseekBase:
      process.env.DEEPSEEK_BASE_URL || env.DEEPSEEK_BASE_URL || DEFAULT_DEEPSEEK_BASE,
    poolsideKey:
      process.env.POOLSIDE_API_KEY || env.POOLSIDE_API_KEY || EMBEDDED_POOLSIDE_API_KEY || '',
    ollamaBase: process.env.OLLAMA_BASE_URL || env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE,
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
  return 'info';
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
      return query ? `Search “${truncate(query, 48)}”` : 'Searching';
    case 'glob':
      return base ? `Find ${base}` : 'Finding files';
    case 'bash':
      return command ? truncate(command, 64) : 'Running command';
    case 'list':
      return base ? `List ${base}` : 'Listing files';
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
      event?.properties?.id ||
      '',
  );
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
  private readonly usage = new Map<string, { inputTokens: number; outputTokens: number }>();
  private eventsBound = false;

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
      status: 'Thinking',
    };
    this.states.set(runId, state);

    try {
      const option = findModel(request.modelId);
      await assertOlkilWallet(option.provider);
      const sidecar = await this.ensureSidecar();
      const directory = this.sessionDirectory(request.workspaceRoot);
      const conversationKey = `${directory}::${request.conversationId || runId}`;
      const session = await this.ensureSession(sidecar, conversationKey, directory);
      const model = opencodeModelRef(option);
      const agent = opencodeAgentForMode(request.mode);
      const autoApprove = request.autoApprove !== false && request.mode === 'agent';

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
          state,
          autoApprove,
          inputTokens: 0,
          outputTokens: 0,
          userMessageIds: new Set<string>(),
          fileBefore: new Map<string, string | null>(),
          lastDiffAt: 0,
          finish: (error?: string) => {
            if (state.done) {
              resolve();
              return;
            }
            if (error && error !== 'Stopped') {
              state.error = error;
              state.status = 'Failed';
            } else {
              state.status = error === 'Stopped' ? 'Stopped' : 'Done';
            }
            state.done = true;
            this.lives.delete(runId);
            if (this.runBySession.get(session.id) === runId) {
              this.runBySession.delete(session.id);
            }
            resolve();
          },
        };
        this.lives.set(runId, live);
        this.runBySession.set(session.id, runId);
      });

      const parts: Array<Record<string, unknown>> = [];
      if (request.activeFile && fs.existsSync(request.activeFile)) {
        parts.push({
          type: 'file',
          mime: 'text/plain',
          filename: path.basename(request.activeFile),
          url: pathToFileURL(request.activeFile).href,
        });
      }
      parts.push({
        type: 'text',
        text: this.wrapPrompt(request),
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
      const billed = this.usage.get(runId) || { inputTokens: 0, outputTokens: 0 };
      await this.syncDiffs(session.id, directory, state);
      await this.charge(option.provider, option.model, runId, request.prompt, state, billed);
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

  private wrapPrompt(request: ClineEngineRunRequest): string {
    const bits: string[] = [
      `You are the coding agent inside OLKIL IDE. Product name: OLKIL. Workspace: ${
        request.workspaceRoot?.trim() || '(no folder open)'
      }.`,
    ];
    if (request.activeFile) {
      bits.push(`Active file: ${request.activeFile}`);
    }
    if (request.rules?.trim()) {
      bits.push(`<project_rules>\n${request.rules.trim()}\n</project_rules>`);
    }
    bits.push(`<user_input mode="${request.mode === 'agent' ? 'act' : request.mode}">${request.prompt}</user_input>`);
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
      this.sidecar = new OpencodeSidecar(providerSecrets());
    }
    await this.sidecar.ensureStarted();
    if (!this.eventsBound) {
      this.eventsBound = true;
      this.sidecar.onEvent((event) => this.handleEvent(event));
    }
    return this.sidecar;
  }

  private async ensureSession(
    sidecar: OpencodeSidecar,
    key: string,
    directory: string,
  ): Promise<SessionHandle> {
    const existing = this.sessions.get(key);
    if (existing && existing.directory === directory) {
      return existing;
    }
    const created = await sidecar.request<any>('POST', '/session', {
      query: { directory },
      body: { title: 'OLKIL' },
    });
    const id = created?.id || created?.data?.id;
    if (!id) {
      throw new Error('OpenCode session.create returned no id');
    }
    const handle = { id: String(id), directory };
    this.sessions.set(key, handle);
    return handle;
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
          state.text = part.text;
          state.status = 'Writing';
        } else if (part.type === 'reasoning' && typeof part.text === 'string') {
          state.reasoning = part.text;
          state.status = 'Thinking';
          this.upsertActivity(state, {
            id: 'thinking_live',
            kind: 'thinking',
            label: 'Thinking',
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
          state.status = 'Compacting context';
          this.upsertActivity(state, {
            id: `compact_${part.id}`,
            kind: 'info',
            label: 'Compacting context for this large project',
            done: false,
          });
        } else if (part.type === 'step-finish' && part.tokens) {
          live.inputTokens += Math.max(0, Number(part.tokens.input || 0));
          live.outputTokens += Math.max(0, Number(part.tokens.output || 0) + Number(part.tokens.reasoning || 0));
          this.usage.set(live.runId, { inputTokens: live.inputTokens, outputTokens: live.outputTokens });
        }
        break;
      }
      case 'permission.updated': {
        const permission = event.properties;
        if (!permission?.id) {
          return;
        }
        const response = live.autoApprove ? 'always' : 'reject';
        void this.sidecar
          ?.request('POST', `/session/${live.sessionId}/permissions/${permission.id}`, {
            query: { directory: live.directory },
            body: { response },
          })
          .catch(() => undefined);
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
        this.upsertActivity(state, {
          id: `compacted_${Date.now()}`,
          kind: 'done',
          label: 'Context compacted',
          done: true,
        });
        break;
      case 'todo.updated': {
        const todos = event.properties?.todos || [];
        const active = todos.find((t: any) => t.status === 'in_progress') || todos[0];
        if (active?.content) {
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
        const msg = errorMessage(event.properties?.error);
        if (msg && !/abort/i.test(msg)) {
          live.finish(msg);
        }
        break;
      }
      case 'session.idle':
        live.finish();
        break;
      default:
        break;
    }
  }

  private applyToolPart(live: LiveRun, part: any): void {
    const state = live.state;
    const name = String(part.tool || 'tool');
    const id = String(part.callID || part.id);
    const input = inputFromPart(part);
    const meta = part.state?.metadata && typeof part.state.metadata === 'object' ? part.state.metadata : {};
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
    if (!done) {
      state.status = friendlyToolLabel(name, input);
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
    if (live.fileBefore.has(abs)) {
      return;
    }
    try {
      live.fileBefore.set(abs, fs.readFileSync(abs, 'utf8'));
    } catch {
      live.fileBefore.set(abs, null);
    }
  }

  private recordDiskChange(live: LiveRun, abs: string): void {
    let after: string | null = null;
    try {
      after = fs.readFileSync(abs, 'utf8');
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
  }

  private noteFileTouch(live: LiveRun, filePath: string): void {
    const abs = resolveWorkspacePath(live.directory, filePath);
    if (!abs) {
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
      const kind: FileChangeKind = diff.before == null || diff.before === '' ? 'create' : 'edit';
      this.upsertFileChange(state, {
        id: `diff_${abs}`,
        kind,
        path: abs,
        beforeContent: diff.before ?? null,
        afterContent: diff.after ?? null,
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
    prompt: string,
    state: ClineEngineRunState,
    billed?: { inputTokens: number; outputTokens: number },
  ): Promise<void> {
    if (isLocalProvider(provider)) {
      return;
    }
    const inputTokens = billed?.inputTokens || countOlkilTokens(prompt || '');
    const outputTokens = billed?.outputTokens || countOlkilTokens(state.text || '');
    if (inputTokens + outputTokens < 1) {
      return;
    }
    await chargeOlkilWallet({
      provider,
      model,
      inputTokens,
      outputTokens,
      requestId: `${runId}:opencode`,
    });
  }
}

let host: OlkilOpencodeRuntimeHost | null = null;

export function getOlkilOpencodeRuntime(): OlkilOpencodeRuntimeHost {
  if (!host) {
    host = new OlkilOpencodeRuntimeHost();
  }
  return host;
}

export function scheduleOpencodePrewarm(delayMs = 8_000): void {
  setTimeout(() => {
    void getOlkilOpencodeRuntime().prewarm().catch(() => undefined);
  }, delayMs).unref?.();
}
