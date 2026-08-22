import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { Injectable } from '@opensumi/di';
import fetch from 'node-fetch';
import {
  BrowserActionRequest,
  BrowserActionResult,
  BrowserDevToolsRequest,
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatMessage,
  ChatStreamState,
  ChatToolCall,
  CommandRunRequest,
  CommandRunResult,
  DevServerDetectResult,
  InvestigationResult,
  IOlkilAiNodeService,
  LiveTestRequest,
  LiveTestResult,
  OllamaSetupState,
  RepositoryIndexStatus,
  RepositoryGrepResult,
  RepositoryOverview,
  RepositorySearchResult,
  RepositorySymbolResult,
} from '../common';
import { AI_MODELS, DEFAULT_MODEL_ID, findModel, AiProviderId } from '../common/models';
import { AGENT_TOOLS } from '../common/tools';
import { getSharedRepositoryIndex } from './repository-index.service';
import { ripgrepSearch } from './ripgrep';
import {
  EMBEDDED_DEEPSEEK_API_KEY,
  EMBEDDED_ENV,
  EMBEDDED_POOLSIDE_API_KEY,
} from './embedded-secrets';
import { CommandRunner } from './command-runner';
import { BrowserTestService } from './browser-test.service';
import { getOlkilAgentRuntime } from './agent-runtime';
import type { ClineEngineRunRequest, ClineEngineRunState } from '../common';
import { assertOlkilWallet, chargeOlkilWallet, countOlkilTokensFromUnknown } from './olkil-wallet.service';

const POOLSIDE_URL = 'https://inference.poolside.ai/v1/chat/completions';
const DEFAULT_DEEPSEEK_BASE = 'https://api.deepseek.com';
const DEFAULT_OLLAMA_BASE = 'http://127.0.0.1:11434';

/** Known tool names for collapsing duplicated stream fragments. */
const KNOWN_TOOL_NAMES: string[] = (AGENT_TOOLS || []).map((t) => t.function.name).filter(Boolean);

/**
 * Merge streamed tool-name deltas without doubling.
 * Providers may send: (a) full name once, (b) full name every chunk, (c) char fragments.
 */
function mergeStreamedToolName(current: string, incoming: string): string {
  const next = (incoming || '').trim();
  if (!next) {
    return current || '';
  }
  const cur = current || '';
  if (!cur) {
    return next;
  }
  if (next === cur) {
    return cur;
  }
  // Growing name: "re" → "read" → "read_file"
  if (next.startsWith(cur)) {
    return next;
  }
  // Shorter/equal prefix resent
  if (cur.startsWith(next)) {
    return cur;
  }
  // Full name duplicated: "read_file" + "read_file" → keep once
  if (cur.endsWith(next) || next.endsWith(cur)) {
    return cur.length >= next.length ? cur : next;
  }
  // Tiny token fragment
  if (next.length <= 4 && !KNOWN_TOOL_NAMES.includes(next)) {
    const merged = cur + next;
    return sanitizeToolName(merged) || merged;
  }
  return sanitizeToolName(cur + next) || cur;
}

/**
 * Merge streamed tool-argument deltas without doubling.
 * DeepSeek/Poolside sometimes re-send the FULL JSON args every SSE chunk;
 * naïve `+=` corrupts paths into `string=` / duplicated JSON.
 */
function mergeStreamedToolArguments(current: string, incoming: string): string {
  const next = incoming || '';
  if (!next) return current || '';
  const cur = current || '';
  if (!cur) return next;
  if (next === cur) return cur;
  // Full JSON resent / growing JSON object
  if (/^\s*\{/.test(next)) {
    if (next.startsWith(cur)) return next;
    if (cur.startsWith(next)) return cur;
    try {
      JSON.parse(cur);
      // cur already valid — incoming is likely a full resend (or start of new)
      try {
        JSON.parse(next);
        return next;
      } catch {
        // next incomplete replacement
        return next;
      }
    } catch {
      // cur incomplete — keep appending unless next is a fresh start that supersedes
      if (/^\s*\{/.test(cur) && next.length >= cur.length && next.startsWith(cur.slice(0, Math.min(12, cur.length)))) {
        return next.length > cur.length ? next : cur + next;
      }
      return cur + next;
    }
  }
  if (cur.endsWith(next)) return cur;
  if (next.startsWith(cur)) return next;
  return cur + next;
}

/** Collapse read_fileread_file → read_file using known catalog names. */
function sanitizeToolName(raw: string): string {
  const name = (raw || '').trim();
  if (!name) {
    return '';
  }
  if (KNOWN_TOOL_NAMES.includes(name)) {
    return name;
  }
  // Prefer longest known name that tiles the raw string, or that raw starts with.
  const sorted = [...KNOWN_TOOL_NAMES].sort((a, b) => b.length - a.length);
  for (const known of sorted) {
    if (name === known) {
      return known;
    }
    // Exact N repetitions: read_fileread_file
    if (name.length % known.length === 0) {
      const times = name.length / known.length;
      if (times > 1 && known.repeat(times) === name) {
        return known;
      }
    }
    if (name.startsWith(known) && name.slice(known.length).startsWith(known)) {
      return known;
    }
  }
  // Prefix match: take first known name that is a prefix
  for (const known of sorted) {
    if (name.startsWith(known)) {
      return known;
    }
  }
  return name;
}
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) {
    return '0 B';
  }
  const gb = n / (1024 * 1024 * 1024);
  if (gb >= 1) {
    return `${gb.toFixed(2)} GB`;
  }
  const mb = n / (1024 * 1024);
  if (mb >= 1) {
    return `${mb.toFixed(1)} MB`;
  }
  return `${Math.round(n / 1024)} KB`;
}

function loadDotEnv(): Record<string, string> {
  const candidates: string[] = [];

  // Packaged Electron resources (main process / when resourcesPath exists)
  if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'olkil.env'));
  }

  // OpenSumi node child often has no resourcesPath — resolve next to the .exe
  try {
    const execDir = path.dirname(process.execPath);
    candidates.push(path.join(execDir, 'resources', 'olkil.env'));
    candidates.push(path.join(execDir, 'olkil.env'));
  } catch {
    // ignore
  }

  if (process.env.OLKIL_RESOURCES_PATH) {
    candidates.push(path.join(process.env.OLKIL_RESOURCES_PATH, 'olkil.env'));
  }
  if (process.env.MAC_RESOURCES_PATH) {
    candidates.push(path.join(process.env.MAC_RESOURCES_PATH, 'olkil.env'));
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as {
      app?: { getAppPath: () => string; getPath: (name: string) => string };
    };
    const app = electron.app;
    if (app?.getAppPath) {
      const appPath = app.getAppPath();
      candidates.push(path.join(appPath, '..', 'olkil.env'));
      candidates.push(path.join(path.dirname(appPath), 'olkil.env'));
      candidates.push(path.join(appPath, 'olkil.env'));
    }
    if (app?.getPath) {
      candidates.push(path.join(app.getPath('userData'), 'olkil.env'));
      candidates.push(path.join(app.getPath('userData'), '.env'));
    }
  } catch {
    // non-electron / OpenSumi node process
  }

  candidates.push(
    path.join(process.cwd(), '.env'),
    path.join(__dirname, '../../.env'),
    path.join(__dirname, '../../../.env'),
    path.join(__dirname, '../../../../.env'),
  );

  const out: Record<string, string> = { ...EMBEDDED_ENV };
  for (const file of candidates) {
    try {
      if (!file || !fs.existsSync(file)) {
        continue;
      }
      const text = fs.readFileSync(file, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
          continue;
        }
        const eq = trimmed.indexOf('=');
        if (eq <= 0) {
          continue;
        }
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (value && !value.includes('your_')) {
          // File values override embedded defaults
          out[key] = value;
        }
      }
    } catch {
      // try next
    }
  }
  return out;
}

function providerLabel(provider: AiProviderId): string {
  if (provider === 'ollama') {
    return 'Ollama';
  }
  if (provider === 'deepseek') {
    return 'DeepSeek';
  }
  return 'Dazzlone';
}

/** Normalize OpenAI-style content (string | parts array | null). */
export function normalizeMessageContent(content: unknown): string {
  if (content == null) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part === 'object') {
          if (typeof (part as any).text === 'string') {
            return (part as any).text;
          }
          if (typeof (part as any).content === 'string') {
            return (part as any).content;
          }
        }
        return '';
      })
      .join('');
  }
  if (typeof content === 'object' && typeof (content as any).text === 'string') {
    return (content as any).text;
  }
  return '';
}

@Injectable()
export class OlkilAiNodeService implements IOlkilAiNodeService {
  private env = loadDotEnv();
  private streams = new Map<string, ChatStreamState>();
  private setup: OllamaSetupState = { phase: 'idle' };
  private setupRunning = false;
  private serveStarted = false;
  private pullAbort: { abort: () => void } | null = null;
  private pullIntent: 'run' | 'pause' | 'cancel' = 'run';
  private readonly repositoryIndex = getSharedRepositoryIndex();
  private readonly commandRunner = new CommandRunner();
  private readonly browserTest = new BrowserTestService(this.commandRunner);

  private refreshEnv() {
    this.env = { ...loadDotEnv(), ...this.env };
    // Prefer freshly loaded file values for keys that were empty
    const fresh = loadDotEnv();
    for (const [k, v] of Object.entries(fresh)) {
      if (v) {
        this.env[k] = v;
      }
    }
  }

  ensureRepositoryIndex(root: string): Promise<RepositoryIndexStatus> {
    return this.repositoryIndex.ensure(root);
  }

  async getRepositoryIndexStatus(root: string): Promise<RepositoryIndexStatus> {
    return this.repositoryIndex.statusFor(root);
  }

  searchRepository(root: string, query: string, limit?: number): Promise<RepositorySearchResult> {
    return this.repositoryIndex.search(root, query, limit);
  }

  exactRepositorySearch(root: string, query: string, limit?: number): Promise<RepositorySearchResult> {
    return this.repositoryIndex.exactSearch(root, query, limit);
  }

  grepRepository(
    root: string,
    query: string,
    options?: { maxResults?: number; regex?: boolean; caseSensitive?: boolean },
  ): Promise<RepositoryGrepResult> {
    return ripgrepSearch(root, query, options);
  }

  findSymbolDefinitions(root: string, symbol: string, limit?: number): Promise<RepositorySymbolResult> {
    return this.repositoryIndex.symbolDefinitions(root, symbol, limit);
  }

  findSymbolReferences(root: string, symbol: string, limit?: number): Promise<RepositorySymbolResult> {
    return this.repositoryIndex.symbolReferences(root, symbol, limit);
  }

  getRepositoryOverview(root: string): Promise<RepositoryOverview> {
    return this.repositoryIndex.overview(root);
  }

  getRelatedFiles(root: string, filePath: string, limit?: number): Promise<RepositorySearchResult> {
    return this.repositoryIndex.related(root, filePath, limit);
  }

  findModules(root: string, query: string, limit?: number): Promise<RepositorySearchResult> {
    return this.repositoryIndex.findModules(root, query, limit);
  }

  findFilesByName(
    root: string,
    query: string,
    limit?: number,
  ): Promise<{ files: string[]; engine: 'index' | 'empty'; elapsedMs: number }> {
    return this.repositoryIndex.findFilesByName(root, query, limit);
  }

  investigateRepository(root: string, query: string, limit?: number): Promise<InvestigationResult> {
    return this.repositoryIndex.investigate(root, query, limit);
  }

  refreshRepositoryFiles(root: string, filePaths: string[]): Promise<void> {
    return this.repositoryIndex.refreshFiles(root, filePaths);
  }

  async detectDevServer(root: string): Promise<DevServerDetectResult> {
    return this.commandRunner.detectDevServer(root);
  }

  runCommand(request: CommandRunRequest): Promise<CommandRunResult> {
    return this.commandRunner.run(request);
  }

  async getCommandOutput(id: string): Promise<CommandRunResult | null> {
    return this.commandRunner.getOutput(id);
  }

  async stopCommand(id: string): Promise<boolean> {
    return this.commandRunner.stop(id);
  }

  browserLaunch(headed?: boolean): Promise<BrowserActionResult> {
    return this.browserTest.launch(headed !== false);
  }

  browserGoto(url: string): Promise<BrowserActionResult> {
    return this.browserTest.goto(url);
  }

  browserReload(): Promise<BrowserActionResult> {
    return this.browserTest.reload();
  }

  browserClick(request: BrowserActionRequest): Promise<BrowserActionResult> {
    return this.browserTest.click(request);
  }

  browserFill(request: BrowserActionRequest): Promise<BrowserActionResult> {
    return this.browserTest.fill(request);
  }

  browserType(request: BrowserActionRequest): Promise<BrowserActionResult> {
    return this.browserTest.type(request);
  }

  browserUpload(request: BrowserActionRequest): Promise<BrowserActionResult> {
    return this.browserTest.upload(request);
  }

  browserPress(key: string): Promise<BrowserActionResult> {
    return this.browserTest.press(key);
  }

  browserSnapshot(): Promise<BrowserActionResult> {
    return this.browserTest.snapshot();
  }

  browserScreenshot(): Promise<BrowserActionResult> {
    return this.browserTest.screenshot();
  }

  browserConsole(): Promise<BrowserActionResult> {
    return this.browserTest.consoleDump();
  }

  browserNetwork(): Promise<BrowserActionResult> {
    return this.browserTest.networkDump();
  }

  browserDevtools(request?: BrowserDevToolsRequest): Promise<BrowserActionResult> {
    return this.browserTest.devtools(request || {});
  }

  browserClose(): Promise<BrowserActionResult> {
    return this.browserTest.close();
  }

  liveTest(request: LiveTestRequest): Promise<LiveTestResult> {
    return this.browserTest.liveTest(request);
  }

  async clineRun(request: ClineEngineRunRequest): Promise<ClineEngineRunState> {
    return getOlkilAgentRuntime().run(request);
  }

  async clineGetState(runId: string): Promise<ClineEngineRunState> {
    return getOlkilAgentRuntime().getState(runId);
  }

  async clineCancel(runId: string): Promise<boolean> {
    return getOlkilAgentRuntime().cancel(runId);
  }

  private getKey(provider: AiProviderId): string {
    this.refreshEnv();
    if (provider === 'ollama') {
      return process.env.OLLAMA_API_KEY || this.env.OLLAMA_API_KEY || 'ollama';
    }
    if (provider === 'deepseek') {
      return (
        process.env.DEEPSEEK_API_KEY ||
        this.env.DEEPSEEK_API_KEY ||
        EMBEDDED_DEEPSEEK_API_KEY ||
        ''
      );
    }
    return (
      process.env.POOLSIDE_API_KEY ||
      this.env.POOLSIDE_API_KEY ||
      EMBEDDED_POOLSIDE_API_KEY ||
      ''
    );
  }

  private get ollamaBase(): string {
    const raw =
      process.env.OLLAMA_BASE_URL || this.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE;
    return raw.replace(/\/$/, '');
  }

  private get deepseekBase(): string {
    const raw =
      process.env.DEEPSEEK_BASE_URL ||
      this.env.DEEPSEEK_BASE_URL ||
      DEFAULT_DEEPSEEK_BASE;
    return raw.replace(/\/$/, '');
  }

  private chatCompletionsUrl(provider: AiProviderId): string {
    if (provider === 'ollama') {
      return `${this.ollamaBase}/v1/chat/completions`;
    }
    if (provider === 'deepseek') {
      // DeepSeek accepts both /chat/completions and /v1/chat/completions
      return `${this.deepseekBase}/chat/completions`;
    }
    return POOLSIDE_URL;
  }

  private get maxTokens(): number {
    const raw = process.env.OLKIL_MAX_TOKENS || this.env.OLKIL_MAX_TOKENS || '8192';
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 8192) : 8192;
  }

  /** Cap oversized tool/user payloads so cloud APIs don't burn tokens / 500. */
  private slimMessages(messages: ChatMessage[]): ChatMessage[] {
    const MAX_MSG = 10_000;
    const MAX_TOOL = 6_000;
    return messages.map((m) => {
      const content =
        typeof m.content === 'string'
          ? m.content.length > (m.role === 'tool' ? MAX_TOOL : MAX_MSG)
            ? `${m.content.slice(0, m.role === 'tool' ? MAX_TOOL : MAX_MSG)}\n\n/* truncated for API size */`
            : m.content
          : m.content;
      return { ...m, content };
    });
  }

  private async isOllamaReachable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.ollamaBase}/api/tags`, { method: 'GET' });
      return Boolean(res?.ok);
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Local AI (Ollama) auto-setup — zero manual steps for end users.
  // ---------------------------------------------------------------------------

  /** Candidate locations for the ollama executable (bundled first, then system). */
  private ollamaBinaryCandidates(): string[] {
    const exe = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
    const list: string[] = [];
    const envPath = process.env.OLLAMA_PATH || this.env.OLLAMA_PATH;
    if (envPath) {
      list.push(envPath);
    }
    // Bundled with the packaged app (see build/pack.js extraResources → "ollama/")
    const resourcesPath = (process as any).resourcesPath as string | undefined;
    if (resourcesPath) {
      list.push(path.join(resourcesPath, 'ollama', exe));
    }
    // Also relative to the running bundle during dev/packaged node fork
    list.push(path.join(__dirname, '..', 'ollama', exe));
    list.push(path.join(process.cwd(), 'ollama', exe));

    if (process.platform === 'win32') {
      const local = process.env.LOCALAPPDATA;
      if (local) {
        list.push(path.join(local, 'Programs', 'Ollama', exe));
      }
      list.push('C:\\Program Files\\Ollama\\ollama.exe');
    } else if (process.platform === 'darwin') {
      list.push('/Applications/Ollama.app/Contents/Resources/ollama');
      list.push('/opt/homebrew/bin/ollama');
      list.push('/usr/local/bin/ollama');
    } else {
      list.push('/usr/local/bin/ollama');
      list.push('/usr/bin/ollama');
    }
    // Last resort: rely on PATH
    list.push(exe);
    return list;
  }

  private findOllamaBinary(): string | undefined {
    for (const candidate of this.ollamaBinaryCandidates()) {
      try {
        // Bare "ollama" (PATH lookup) has no separator — accept as a fallback.
        if (!candidate.includes(path.sep) && !candidate.includes('/')) {
          return candidate;
        }
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      } catch {
        // ignore
      }
    }
    return undefined;
  }

  private async waitForOllama(timeoutMs = 20000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.isOllamaReachable()) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    return this.isOllamaReachable();
  }

  private async startOllamaServe(): Promise<boolean> {
    if (await this.isOllamaReachable()) {
      return true;
    }
    const bin = this.findOllamaBinary();
    if (!bin) {
      return false;
    }
    try {
      const child = spawn(bin, ['serve'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, OLLAMA_HOST: this.ollamaBase.replace(/^https?:\/\//, '') },
      });
      child.unref();
      this.serveStarted = true;
    } catch {
      return false;
    }
    return this.waitForOllama();
  }

  private async listInstalledModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.ollamaBase}/api/tags`, { method: 'GET' });
      if (!res.ok) {
        return [];
      }
      const data: any = await res.json();
      const models = Array.isArray(data?.models) ? data.models : [];
      return models.map((m: any) => String(m?.name || m?.model || ''));
    } catch {
      return [];
    }
  }

  private modelInstalled(installed: string[], model: string): boolean {
    // Ollama tags come back like "qwen2.5-coder:7b"; a name without a tag
    // implies ":latest".
    const want = model.includes(':') ? model : `${model}:latest`;
    return installed.some((name) => name === model || name === want);
  }

  async getSetupState(): Promise<OllamaSetupState> {
    return this.setup;
  }

  async pauseLocalModelDownload(): Promise<OllamaSetupState> {
    if (this.setup.phase !== 'pulling' && this.setup.phase !== 'starting' && this.setup.phase !== 'checking') {
      return this.setup;
    }
    this.pullIntent = 'pause';
    try {
      this.pullAbort?.abort();
    } catch {
      // ignore
    }
    this.setup = {
      ...this.setup,
      phase: 'paused',
      message: `Download paused at ${this.setup.percent ?? 0}%. Click Resume to continue.`,
    };
    return this.setup;
  }

  async cancelLocalModelDownload(): Promise<OllamaSetupState> {
    this.pullIntent = 'cancel';
    try {
      this.pullAbort?.abort();
    } catch {
      // ignore
    }
    const model = this.setup.model;
    this.setup = {
      phase: 'cancelled',
      model,
      percent: 0,
      message: 'Download cancelled. You can start again anytime.',
    };
    this.setupRunning = false;
    return this.setup;
  }

  async ensureLocalModel(modelId?: string): Promise<OllamaSetupState> {
    const option = findModel(modelId || DEFAULT_MODEL_ID);
    // Only meaningful for local provider.
    if (option.provider !== 'ollama') {
      this.setup = { phase: 'ready', model: option.model };
      return this.setup;
    }
    if (this.setupRunning && this.pullIntent === 'run') {
      return this.setup;
    }
    this.pullIntent = 'run';
    this.setupRunning = true;
    // Run in background; browser polls getSetupState().
    void this.runLocalSetup(option.model).finally(() => {
      this.setupRunning = false;
    });
    return this.setup;
  }

  private async runLocalSetup(model: string): Promise<void> {
    try {
      this.setup = { phase: 'checking', model, message: 'Checking local AI…' };

      if (!(await this.isOllamaReachable())) {
        this.setup = { phase: 'starting', model, message: 'Starting local AI engine…' };
        const started = await this.startOllamaServe();
        if (!started) {
          this.setup = {
            phase: 'error',
            model,
            error:
              'Local AI engine (Ollama) not found. Install Ollama from https://ollama.com or reinstall OLKIL with the bundled engine.',
          };
          return;
        }
      }

      if (this.pullIntent === 'cancel') {
        return;
      }

      const installed = await this.listInstalledModels();
      if (this.modelInstalled(installed, model)) {
        this.setup = {
          phase: 'ready',
          model,
          percent: 100,
          message: `${model} is ready on your machine.`,
        };
        return;
      }

      await this.pullModel(model);
    } catch (e: any) {
      if (this.pullIntent === 'pause') {
        this.setup = {
          ...this.setup,
          phase: 'paused',
          model,
          message: `Download paused at ${this.setup.percent ?? 0}%. Click Resume to continue.`,
        };
        return;
      }
      if (this.pullIntent === 'cancel') {
        this.setup = {
          phase: 'cancelled',
          model,
          percent: 0,
          message: 'Download cancelled. You can start again anytime.',
        };
        return;
      }
      this.setup = {
        phase: 'error',
        model,
        error: e?.message || String(e),
      };
    }
  }

  private async pullModel(model: string): Promise<void> {
    const prevPercent = this.setup.phase === 'paused' ? this.setup.percent || 0 : 0;
    this.setup = {
      phase: 'pulling',
      model,
      percent: prevPercent,
      totalBytes: this.setup.totalBytes,
      completedBytes: this.setup.completedBytes,
      message: `Downloading Ollama model ${model} to your computer…`,
    };

    let aborted = false;
    let bodyRef: any = null;
    const abortHandle = {
      abort: () => {
        aborted = true;
        try {
          bodyRef?.destroy?.();
        } catch {
          // ignore
        }
      },
    };
    this.pullAbort = abortHandle;

    const res = await fetch(`${this.ollamaBase}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model, stream: true }),
    });

    if (aborted || this.pullIntent !== 'run') {
      throw new Error('aborted');
    }

    if (!res.ok) {
      const raw = await res.text();
      throw new Error(`Model download failed (${res.status}): ${raw.slice(0, 300)}`);
    }

    const body: any = (res as any).body;
    bodyRef = body;

    if (!body || typeof body.on !== 'function') {
      await res.text();
      if (aborted || this.pullIntent !== 'run') {
        throw new Error('aborted');
      }
      this.setup = {
        phase: 'ready',
        model,
        percent: 100,
        message: `${model} downloaded — ready to use locally.`,
      };
      return;
    }

    let buffer = '';
    await new Promise<void>((resolve, reject) => {
      body.on('data', (chunk: Buffer) => {
        if (aborted || this.pullIntent !== 'run') {
          try {
            body.destroy();
          } catch {
            // ignore
          }
          reject(new Error('aborted'));
          return;
        }
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }
          try {
            const json = JSON.parse(trimmed);
            if (json.error) {
              reject(new Error(String(json.error)));
              return;
            }
            const total = Number(json.total) || 0;
            const completed = Number(json.completed) || 0;
            const percent =
              total > 0
                ? Math.min(100, Math.round((completed / total) * 100))
                : typeof this.setup.percent === 'number'
                  ? this.setup.percent
                  : 0;
            const status = typeof json.status === 'string' ? json.status : '';
            const sizeHint =
              total > 0 ? ` ${formatBytes(completed)} / ${formatBytes(total)}` : '';
            this.setup = {
              phase: 'pulling',
              model,
              percent,
              totalBytes: total || this.setup.totalBytes,
              completedBytes: completed || this.setup.completedBytes,
              message: `Downloading Ollama model ${model}… ${percent}%${sizeHint}${
                status ? ` · ${status}` : ''
              }`,
            };
          } catch {
            // ignore partial json
          }
        }
      });
      body.on('end', () => resolve());
      body.on('error', (err: Error) => {
        if (aborted || this.pullIntent !== 'run') {
          reject(new Error('aborted'));
          return;
        }
        reject(err);
      });
    });

    if (aborted || this.pullIntent !== 'run') {
      throw new Error('aborted');
    }

    this.setup = {
      phase: 'ready',
      model,
      percent: 100,
      message: `${model} downloaded — ready to use locally.`,
    };
    this.pullAbort = null;
  }

  async listModels() {
    return AI_MODELS.map((m) => ({
      id: m.id,
      provider: m.provider,
      model: m.model,
      label: m.label,
      displayName: m.displayName,
      badge: m.badge,
      approxSizeGb: m.approxSizeGb,
    }));
  }

  async getLocalModelStatus(modelId?: string) {
    const option = findModel(modelId || DEFAULT_MODEL_ID);
    if (option.provider !== 'ollama') {
      return {
        modelId: option.id,
        provider: option.provider,
        model: option.model,
        engineRunning: true,
        installed: true,
        approxSizeGb: option.approxSizeGb,
      };
    }

    let engineRunning = await this.isOllamaReachable();
    if (!engineRunning) {
      // Quietly try to wake the bundled/system engine so we can read /api/tags.
      await this.startOllamaServe();
      engineRunning = await this.isOllamaReachable();
    }

    let installed = false;
    if (engineRunning) {
      const list = await this.listInstalledModels();
      installed = this.modelInstalled(list, option.model);
    }

    return {
      modelId: option.id,
      provider: option.provider,
      model: option.model,
      engineRunning,
      installed,
      approxSizeGb: option.approxSizeGb,
    };
  }

  async hasApiKey(provider?: string): Promise<boolean> {
    if (provider === 'ollama') {
      return this.isOllamaReachable();
    }
    if (provider === 'poolside') {
      return Boolean(this.getKey('poolside'));
    }
    if (provider === 'deepseek') {
      return Boolean(this.getKey('deepseek'));
    }
    // Any usable backend
    if (await this.isOllamaReachable()) {
      return true;
    }
    return Boolean(this.getKey('deepseek') || this.getKey('poolside'));
  }

  async getModelName(modelId?: string): Promise<string> {
    return findModel(modelId || DEFAULT_MODEL_ID).model;
  }

  async getStreamState(streamId: string): Promise<ChatStreamState> {
    // Unknown id ⇒ not done yet (poll may start before the RPC body begins).
    return this.streams.get(streamId) || { text: '', done: false };
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    const option = findModel(request.modelId || DEFAULT_MODEL_ID);
    await assertOlkilWallet(option.provider);
    const apiKey = this.getKey(option.provider);

    if (option.provider === 'ollama') {
      if (!(await this.isOllamaReachable())) {
        await this.startOllamaServe();
      }
      if (!(await this.isOllamaReachable())) {
        throw new Error(
          `Ollama is not running. Click “Download Ollama model” to start the engine, or install Ollama.`,
        );
      }
      const installed = await this.listInstalledModels();
      if (!this.modelInstalled(installed, option.model)) {
        throw new Error(
          `Ollama model "${option.model}" is not downloaded yet. Click “Download Ollama model” and wait until 100%.`,
        );
      }
    } else if (!apiKey) {
      throw new Error(
        `${providerLabel(option.provider)} is not configured. Add ${
          option.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'POOLSIDE_API_KEY'
        } to ide-electron/.env and rebuild (yarn stage-olkil-env).`,
      );
    }

    const useStream = Boolean(request.stream && request.streamId);
    if (useStream && request.streamId) {
      this.streams.set(request.streamId, { text: '', done: false });
    }

    const messages = this.slimMessages(request.messages).map((m) => this.serializeMessage(m));
    const tokenBudget =
      request.maxTokens && request.maxTokens > 0
        ? Math.min(Math.floor(request.maxTokens), 8192)
        : this.maxTokens;
    const body: Record<string, unknown> = {
      model: option.model,
      messages,
      temperature: 0.2,
      max_tokens: tokenBudget,
      stream: useStream,
    };

    // Poolside Laguna can spend huge budgets on thinking; keep agent turns bounded.
    if (option.provider === 'poolside') {
      body.chat_template_kwargs = { enable_thinking: false };
      if (!request.maxTokens) {
        body.max_tokens = Math.min(tokenBudget, 8192);
      }
    }

    // DeepSeek V4 defaults to thinking mode (bills at output rate) — disable for agent speed/cost.
    if (option.provider === 'deepseek') {
      body.thinking = { type: 'disabled' };
      if (!request.maxTokens) {
        body.max_tokens = Math.min(Math.max(tokenBudget, 2048), 8192);
      } else {
        body.max_tokens = Math.min(Math.max(tokenBudget, 2048), 8192);
      }
      // Steer away from DSML text dumps when tools are present.
      if (request.tools?.length && request.toolChoice !== 'none') {
        body.tool_choice = request.toolChoice || 'auto';
      }
    }

    // Providers reject histories containing tool messages unless `tools` is also
    // sent, so keep the declarations even when forcing tool_choice: 'none'.
    const historyHasToolTraffic = request.messages.some(
      (m) => m.role === 'tool' || Boolean(m.tool_calls?.length),
    );
    if (request.tools?.length) {
      body.tools = request.tools;
      body.tool_choice = request.toolChoice || 'auto';
    } else if (historyHasToolTraffic) {
      body.tools = AGENT_TOOLS;
      body.tool_choice = request.toolChoice || 'none';
    } else if (request.toolChoice === 'none') {
      body.tool_choice = 'none';
    }

    const url = this.chatCompletionsUrl(option.provider);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (option.provider === 'ollama') {
      // OpenAI-compat shim accepts a dummy bearer; some builds omit it.
      headers.Authorization = `Bearer ${apiKey || 'ollama'}`;
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const raw = await res.text();
        const err = `${option.provider} API ${res.status}: ${raw.slice(0, 500)}`;
        // Soft-retry once at the node layer for flaky 5xx (Poolside long jobs).
        if ([500, 502, 503, 504].includes(res.status) && !(request as any).__retried) {
          await new Promise((r) => setTimeout(r, 450));
          return this.chatCompletion({ ...request, __retried: true } as any);
        }
        if (useStream && request.streamId) {
          this.streams.set(request.streamId, { text: '', done: true, error: err });
        }
        throw new Error(err);
      }

      if (useStream && request.streamId) {
        const result = await this.consumeSse(res, request.streamId);
        this.streams.set(request.streamId, {
          text: result.content,
          done: true,
        });
        setTimeout(() => this.streams.delete(request.streamId!), 60_000);
        await this.chargeUserWallet(option, request, result);
        return result;
      }

      const raw = await res.text();
      let data: any;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(`Invalid ${option.provider} response: ${raw.slice(0, 300)}`);
      }

      const parsed = this.parseCompletionChoice(data);
      await this.chargeUserWallet(option, request, parsed);
      return parsed;
    } catch (e: any) {
      if (useStream && request.streamId) {
        this.streams.set(request.streamId, {
          text: this.streams.get(request.streamId)?.text || '',
          done: true,
          error: e?.message || String(e),
        });
      }
      throw e;
    }
  }

  private parseCompletionChoice(data: any): ChatCompletionResult {
    const choice = data?.choices?.[0];
    const message = choice?.message || {};
    return {
      content: normalizeMessageContent(message.content),
      tool_calls: message.tool_calls,
      finish_reason: choice?.finish_reason,
    };
  }

  private async chargeUserWallet(
    option: { provider: AiProviderId; model: string },
    request: ChatCompletionRequest,
    result: ChatCompletionResult,
  ): Promise<void> {
    const inputTokens = countOlkilTokensFromUnknown(request.messages);
    const outputTokens = countOlkilTokensFromUnknown(result.content) + countOlkilTokensFromUnknown(result.tool_calls);
    await chargeOlkilWallet({
      provider: option.provider,
      model: option.model,
      inputTokens,
      outputTokens,
      requestId: `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    });
  }

  private async consumeSse(res: any, streamId: string): Promise<ChatCompletionResult> {
    let content = '';
    const toolCalls: ChatToolCall[] = [];
    let finishReason: string | undefined;

    // node-fetch body is a Node stream
    const body = res.body;
    if (!body || typeof body.on !== 'function') {
      const raw = await res.text();
      // some providers ignore stream and return JSON
      try {
        return this.parseCompletionChoice(JSON.parse(raw));
      } catch {
        content = raw;
        this.streams.set(streamId, { text: content, done: false });
        return { content, finish_reason: 'stop' };
      }
    }

    let buffer = '';
    await new Promise<void>((resolve, reject) => {
      body.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const parts = buffer.split('\n');
        buffer = parts.pop() || '';
        for (const line of parts) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) {
            continue;
          }
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') {
            continue;
          }
          try {
            const json = JSON.parse(payload);
            const choice = json?.choices?.[0];
            const delta = choice?.delta || {};
            if (choice?.finish_reason) {
              finishReason = choice.finish_reason;
            }
            const piece = normalizeMessageContent(delta.content);
            if (piece) {
              content += piece;
              this.streams.set(streamId, {
                text: content,
                done: false,
                toolNames: toolCalls.filter(Boolean).map((t) => t.function.name).filter(Boolean),
              });
            }
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = typeof tc.index === 'number' ? tc.index : toolCalls.length;
                if (!toolCalls[idx]) {
                  toolCalls[idx] = {
                    id: tc.id || `call_${idx}`,
                    type: 'function',
                    function: { name: '', arguments: '' },
                  };
                }
                if (tc.id) {
                  toolCalls[idx].id = tc.id;
                }
                if (tc.function?.name) {
                  // Poolside/Laguna often re-sends the FULL tool name every SSE
                  // chunk. Naïve `+=` turns read_file → read_fileread_file and
                  // breaks dispatch ("Unknown tool"). Merge safely instead.
                  toolCalls[idx].function.name = mergeStreamedToolName(
                    toolCalls[idx].function.name,
                    tc.function.name,
                  );
                }
                if (tc.function?.arguments) {
                  toolCalls[idx].function.arguments = mergeStreamedToolArguments(
                    toolCalls[idx].function.arguments,
                    tc.function.arguments,
                  );
                }
              }
              this.streams.set(streamId, {
                text: content,
                done: false,
                toolNames: toolCalls
                  .filter(Boolean)
                  .map((t) => sanitizeToolName(t.function.name))
                  .filter(Boolean),
              });
            }
          } catch {
            // ignore partial JSON
          }
        }
      });
      body.on('end', () => resolve());
      body.on('error', (err: Error) => reject(err));
    });

    return {
      content,
      tool_calls: toolCalls.length
        ? toolCalls.filter(Boolean).map((tc) => ({
            ...tc,
            function: {
              ...tc.function,
              name: sanitizeToolName(tc.function.name),
            },
          }))
        : undefined,
      finish_reason: finishReason,
    };
  }

  private serializeMessage(m: ChatMessage) {
    const msg: Record<string, unknown> = {
      role: m.role,
      content: m.content ?? '',
    };
    if (m.name) {
      msg.name = m.name;
    }
    if (m.tool_call_id) {
      msg.tool_call_id = m.tool_call_id;
    }
    if (m.tool_calls?.length) {
      msg.tool_calls = m.tool_calls;
      if (!m.content) {
        msg.content = null;
      }
    }
    return msg;
  }
}
