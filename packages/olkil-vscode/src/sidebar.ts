import * as crypto from 'crypto';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  clearSession,
  completeLogin,
  ensureSession,
  type OlkilSession,
} from './auth';
import { OlkilEngine } from './engine';
import {
  fetchQuota,
  canUseVscodeAgent,
  chargeUsage,
  parseUsageBlob,
  addUsage,
  maxUsage,
  collectGenerationIds,
  usageFromEngineMessage,
  fetchOpenRouterGenerationUsage,
  PAID_PLANS,
  type OlkilQuota,
} from './quota';
import { CUSTOM_MODEL_ID, DEFAULT_MODEL_ID, customEndpointReady, customIdFromModelId, customPickerId, fetchOpenRouterCatalog, isAddCustomModel, isCustomModel, newCustomId, pickerModels, resolveCloudSlug, type CustomEndpoint } from './models';
import { buildDiffPreview, computeEditorDiffMarkers, countLineStats, type DiffLine } from './diff';
import { ChatHistoryStore, titleFromMessages, type PersistedChatMessage } from './chat-history';
import { VirtualOfficePanel, VO_ASSIGNEES, VO_WORKERS, isSimpleChatPrompt, type VoAssigneeId } from './virtual-office';
import { PocketBridge } from './pocket';
import { ExtensionScreen } from './screen-share';
import { KeepAwake } from './keep-awake';
import {
  exactTrialTokens,
  freeTrialCreds,
  openFreeTrial,
  recordFreeTrialUse,
  type FreeTrialState,
} from './free-trial';

function workspaceFolder(): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) {
    throw new Error('Open a project folder in VS Code first. OLKIL edits the workspace you have open.');
  }
  return folder;
}

function unwrapEvent(raw: Record<string, unknown>): Record<string, unknown> {
  const payload = raw.payload;
  if (payload && typeof payload === 'object' && (payload as any).type) {
    return payload as Record<string, unknown>;
  }
  return raw;
}

function isReasoningPart(part: any): boolean {
  const t = String(part?.type || '').toLowerCase();
  return (
    t === 'reasoning' ||
    t === 'thinking' ||
    t === 'redacted_reasoning' ||
    t === 'reasoning_delta' ||
    Boolean(part?.thought)
  );
}

function eventText(event: Record<string, unknown>): string {
  const props = (event.properties || event) as Record<string, any>;
  const part = props.part || props;
  if (isReasoningPart(part)) return '';
  if (part && part.type === 'text' && typeof part.text === 'string' && !part.synthetic) return part.text;
  if (part && part.state && typeof part.state.text === 'string' && !isReasoningPart(part.state)) return part.state.text;
  if (typeof props.delta === 'string' && String(props.part?.type || props.type || '') === 'text') return props.delta;
  if (typeof props.text === 'string' && props.type === 'text') return props.text;
  return '';
}

function cleanAssistantText(text: string): string {
  let t = String(text || '').replace(/\r\n/g, '\n');
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '');
  t = t.replace(/user is (?:saying|asking)[\s\S]*?(?=\n(?:Hi!|I run|I am OLKIL)|$)/gi, '');
  t = t.replace(/According to my AGENTS\.md[\s\S]*?(?=\nI run|\nI am|$)/gi, '');
  t = t.replace(/Never (?:print a provider|write hidden reasoning|mention OpenCode)[\s\S]*?coding partner\.?/gi, '');
  t = t.replace(/You are OLKIL, the OLKIL coding agent\.[\s\S]*?coding partner\.?/gi, '');
  t = t.replace(/If the user asks (?:who you are|which model you use)[\s\S]*?(?:coding agent\.|coding model\.)/gi, '');
  t = t.replace(/# OLKIL\s*/g, '');
  t = t.replace(/I should respond[\s\S]*?(?=\nHi!|\nI run|$)/gi, '');
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const blocks = t.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const uniq: string[] = [];
  for (const b of blocks) {
    if (uniq[uniq.length - 1] === b) continue;
    uniq.push(b);
  }
  t = uniq.join('\n\n');
  t = t.replace(/(.{12,}?)\s+\1/g, '$1');
  t = t.replace(/(Hi! I'm OLKIL, the coding agent\. How can I help you with your code today\??\s*)\1+/gi, '$1');
  t = t.replace(/(I run on OLKIL's coding model\.?\s*)\1+/gi, '$1');
  t = t.replace(/(I am OLKIL, the coding agent\.?\s*)\1+/gi, '$1');
  return t.trim();
}

function isUserEcho(text: string): boolean {
  const t = String(text || '');
  return (
    /Stay inside this folder/i.test(t) ||
    /You are OLKIL, the OLKIL coding agent/i.test(t) ||
    /You are OLKIL's coding agent/i.test(t) ||
    /Agent mode: (edit or write|complete the full request)/i.test(t) ||
    /^Workspace:\s/i.test(t.trim())
  );
}

function friendlyEngineError(raw: string): string {
  const t = String(raw || '');
  if (/insufficient balance/i.test(t)) {
    return 'The cloud model wallet needs a top-up on our side. Your Lite plan is active — try again in a minute.';
  }
  return t.replace(/\bOpenCode\b/gi, 'OLKIL').replace(/\bDeepSeek\b/gi, 'OLKIL');
}

function fileExistsOnDisk(filePath: string): boolean {
  try {
    const p = String(filePath || '').trim();
    if (!p) return false;
    const abs = pathLooksAbsolute(p)
      ? path.normalize(p)
      : path.normalize(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', p));
    return Boolean(abs && fs.existsSync(abs) && fs.statSync(abs).isFile());
  } catch {
    return false;
  }
}

function extractWriteContent(part: any): string | null {
  const input = part.state?.input || part.input || {};
  const keys = ['content', 'contents', 'file_text', 'fileText', 'new_string', 'newString', 'new_text', 'newText'];
  for (const k of keys) {
    if (typeof input[k] === 'string') return input[k] as string;
  }
  return null;
}

function sanitizeToolPath(p: string): string {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^action\//i, '')
    .replace(/^tool\//i, '')
    .replace(/^files?\//i, '')
    .trim();
}

function toolMeta(part: any): {
  label: string;
  detail: string;
  filePath: string;
  kind: string;
  line: string;
  command: string;
  title: string;
  badge: string;
  action: 'create' | 'edit' | 'read' | 'search' | 'bash' | 'web' | 'tool';
} {
  const name = String(part.tool || part.name || 'tool').toLowerCase();
  const input = part.state?.input || part.input || {};
  const filePath = sanitizeToolPath(
    String(input.path || input.file_path || input.filePath || input.target_file || input.filename || input.file || ''),
  );
  const file = filePath.replace(/\\/g, '/');
  const base = file.split('/').pop() || '';
  const cmd = String(input.command || '').trim();
  const pattern = String(input.pattern || input.query || input.glob_pattern || input.glob || '').trim();
  const isWrite = /^(write|create_file|write_to_file|write_file)$/.test(name) || name === 'write';
  const isPatch = /edit|apply_patch|str_replace|search_replace|patch/.test(name);
  if (isWrite || isPatch) {
    const existed = filePath ? fileExistsOnDisk(filePath) : false;
    const creating = !existed;
    const verb = creating ? 'Creating' : isWrite ? 'Writing' : 'Editing';
    const doneVerb = creating ? 'Created' : isWrite ? 'Wrote' : 'Edited';
    return {
      kind: creating ? 'create' : 'edit',
      action: creating ? 'create' : 'edit',
      label: base ? verb + ' ' + base : verb + ' file',
      detail: file || base,
      filePath,
      line: base ? doneVerb + ' ' + base : doneVerb + ' file',
      command: '',
      title: base || 'file',
      badge: creating || isWrite ? 'Writer' : 'Editor',
    };
  }
  if (/read/.test(name)) {
    return {
      kind: 'read',
      action: 'read',
      label: base ? 'Reading ' + base : 'Reading file',
      detail: file || base,
      filePath,
      line: base ? 'Read ' + base : 'Read file',
      command: '',
      title: base || 'file',
      badge: 'Explorer',
    };
  }
  if (/grep|search|glob/.test(name)) {
    const q = (pattern || base || 'workspace').slice(0, 100);
    return {
      kind: 'search',
      action: 'search',
      label: 'Searching · ' + q,
      detail: file || q,
      filePath,
      line: 'Searched files ' + q,
      command: '',
      title: q,
      badge: 'Explorer',
    };
  }
  if (/bash|shell|cmd/.test(name)) {
    const short = cmd.replace(/\s+/g, ' ').slice(0, 160);
    return {
      kind: 'bash',
      action: 'bash',
      label: 'Running command',
      detail: short,
      filePath: '',
      line: short,
      command: short,
      title: commandTitle(short),
      badge: 'Shell',
    };
  }
  if (/webfetch|web_search/.test(name)) {
    const url = String(input.url || input.query || '').slice(0, 100);
    return {
      kind: 'web',
      action: 'web',
      label: 'Looking something up',
      detail: url,
      filePath: '',
      line: url ? 'Fetched ' + url : 'Web lookup',
      command: '',
      title: 'web',
      badge: 'Explorer',
    };
  }
  return {
    kind: 'tool',
    action: 'tool',
    label: String(part.state?.title || 'Using tools'),
    detail: base || cmd.slice(0, 80),
    filePath,
    line: String(part.state?.title || base || 'Tool'),
    command: '',
    title: base || 'task',
    badge: 'Agent',
  };
}

function commandTitle(cmd: string): string {
  const t = String(cmd || '').trim();
  if (!t) return 'command';
  const first = t.split(/[|\n;]/)[0].trim();
  const tokens = first.split(/\s+/).slice(0, 4);
  return tokens.join(' ').slice(0, 48) || 'command';
}

/** Stable activity id so repeated edits/reads of the same file collapse to one row. */
function activityStableId(
  meta: { kind: string; command?: string; label?: string },
  callId: unknown,
  filePath: string,
): string {
  const kind = String(meta.kind || '');
  const file = String(filePath || '')
    .replace(/\\/g, '/')
    .toLowerCase();
  if (file && /^(create|edit)$/.test(kind)) return 'file:' + file;
  if (file && kind === 'read') return 'read:' + file;
  if (kind === 'search') {
    const q = String(meta.label || '')
      .replace(/^Searching · /i, '')
      .slice(0, 100)
      .toLowerCase();
    return 'search:' + (q || file || String(callId || 'q'));
  }
  if (kind === 'bash') {
    return 'bash:' + String(meta.command || callId || 'cmd').slice(0, 100);
  }
  return String(callId || meta.label || kind || 'tool');
}

function extractFilePath(part: any): string {
  const input = part.state?.input || part.input || {};
  const meta = part.state?.metadata || {};
  const output = part.state?.output || part.output || {};
  return sanitizeToolPath(
    String(
      input.path ||
        input.file_path ||
        input.filePath ||
        input.target_file ||
        input.filename ||
        input.file ||
        meta.filepath ||
        meta.path ||
        meta.file ||
        output.path ||
        output.file_path ||
        output.filePath ||
        '',
    ),
  );
}

function countLines(text: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.startsWith('+') && !line.startsWith('+++')) add += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) del += 1;
  }
  return { add, del };
}

function permissionId(event: Record<string, unknown>): string {
  const props = (
    event.properties && typeof event.properties === 'object' ? event.properties : event
  ) as Record<string, any>;
  return String(props.id || props.permissionID || props.permissionId || props.requestID || '');
}

function pathLooksAbsolute(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\');
}

function clipSnapshot(text: string | null | undefined, max = 2_000_000): string | null {
  if (text == null) return null;
  const s = String(text);
  return s.length > max ? s.slice(0, max) : s;
}

function looksIncompleteReply(
  text: string,
  hadTools: boolean,
  pendingTodos: boolean,
  fileChanges = 0,
): boolean {
  if (pendingTodos) return true;
  const t = String(text || '').trim();
  if (!hadTools) return false;
  // Tools already wrote files and model went quiet — finish now (avoid a long "Planning" continue round-trip)
  if (!t) return fileChanges < 1;
  const soundsDone =
    /\b(done|finished|complete[ds]?|updated|fixed|changed|added|removed|created|implemented|refactored)\b/i.test(t) &&
    !/\b(next|still need|remaining|todo|will now|i('| a)?ll |coming up)\b/i.test(t);
  if (soundsDone) return false;
  // Real file edits + a short note → prefer finishing over another continue loop
  if (fileChanges > 0 && t.length < 400 && !/\b(next|still need|remaining|todo|will now|i('| a)?ll )\b/i.test(t)) {
    return false;
  }
  if (t.length < 280) {
    if (/^(i('| a)?ll|let me|next|starting|now i|i am going|i'm going|working on|first,|step \d)/i.test(t)) {
      return true;
    }
    if (/\b(next|todo|remaining|still need|will (now )?|continue|partial)\b/i.test(t)) return true;
  }
  if (/\b(i('| a)?ll (now )?(continue|edit|update|fix|implement)|coming up next|to be continued)\b/i.test(t)) {
    return true;
  }
  return false;
}

function resolveAbs(filePath: string): string {
  const p = String(filePath || '').trim();
  if (!p) return '';
  if (pathLooksAbsolute(p)) return path.normalize(p);
  return path.normalize(path.join(workspaceFolder(), p));
}

function readFileSafe(abs: string): string | null {
  try {
    if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    if (fs.statSync(abs).size > 2_000_000) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

type FileChangeRow = {
  path: string;
  abs: string;
  additions: number;
  deletions: number;
  status: 'pending' | 'accepted' | 'reverted';
  before: string | null;
  after: string | null;
  preview: DiffLine[];
  live: boolean;
  action: 'create' | 'edit' | 'delete';
};

const MAX_AUTO_CONTINUES = 8;
const CONTINUE_PROMPT =
  'Finish any remaining work now with tools. No narration. When done, give a short accurate summary.';

function formatHistoryAge(updatedAt: number): string {
  const ms = Math.max(0, Date.now() - updatedAt);
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

export class OlkilSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'olkil.sidebar';
  private view?: vscode.WebviewView;
  private session: OlkilSession | null = null;
  private quota: OlkilQuota | null = null;
  private engine = new OlkilEngine();
  private liveText = '';
  private voLiveText = new Map<string, string>();
  private voEventWorkerId: string | null = null;
  private engineReady = false;
  private userMessageIds = new Set<string>();
  private turnUsage: ReturnType<typeof parseUsageBlob> = null;
  private turnGenIds = new Set<string>();
  private turnCharged = false;
  private charging = false;
  private modelId = DEFAULT_MODEL_ID;
  private turnFiles = new Map<string, FileChangeRow>();
  private fileBefore = new Map<string, string | null>();
  private customs: CustomEndpoint[] = [];
  private turnHadTools = false;
  private pendingTodos = false;
  private autoContinues = 0;
  private userAborted = false;
  private finishingIdle = false;
  /** True while a main-chat agent turn is in flight. Pocket waits so it never cuts a local send. */
  agentBusy = false;
  private pocket: PocketBridge | null = null;
  private screen: ExtensionScreen;
  private keepAwake = new KeepAwake();
  private quotaLoaded = false;
  private freeTrial: FreeTrialState = { kind: 'none' };
  private freeTrialWarned = false;
  /** This turn failed before the model returned usage. Do not deduct free tokens. */
  private turnFailed = false;
  /** Per-VO-worker turn flags so parallel teammates do not share incomplete/continue state. */
  private voTurns = new Map<
    string,
    { hadTools: boolean; pendingTodos: boolean; autoContinues: number; finishing: boolean; aborted: boolean }
  >();
  /** Last engine event time per VO worker — hang watchdog. */
  private voLastEventAt = new Map<string, number>();
  private voWatchTimer: ReturnType<typeof setInterval> | null = null;
  /** Tool call ids that already completed — ignore late pending pings that reopen loaders. */
  private completedToolCalls = new Set<string>();
  private addDeco: vscode.TextEditorDecorationType;
  private delDeco: vscode.TextEditorDecorationType;
  private liveDecoAbs = '';
  private inkTimers = new Set<ReturnType<typeof setTimeout>>();
  private virtualOffice: VirtualOfficePanel;
  private chatHistory: ChatHistoryStore;
  private currentChatId = '';
  private currentChatCreatedAt = 0;
  private chatMessages: PersistedChatMessage[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly context?: vscode.ExtensionContext,
  ) {
    this.engine.onEvent((event) => this.onEngineEvent(event));
    this.chatHistory = new ChatHistoryStore(() => this.session);
    this.modelId = String(this.context?.globalState.get('olkil.modelId') || DEFAULT_MODEL_ID);
    this.addDeco = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(61, 214, 140, 0.16)',
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: '#3dd68c',
    });
    this.delDeco = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(255, 123, 114, 0.14)',
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: '#ff7b72',
      after: {
        color: '#ff7b72',
        margin: '0 0 0 12px',
      },
    });
    this.virtualOffice = new VirtualOfficePanel(
      extensionUri,
      () => this.session,
      () => this.modelId,
      () => this.engine,
      () => this.ensureEngine(),
    );
    this.virtualOffice.onDidChange(() => this.pushVoStatus());
    this.screen = new ExtensionScreen(
      extensionUri.fsPath,
      (msg) => {
        void this.view?.webview.postMessage(msg);
      },
      () => this.pocket?.link() || '',
    );
    this.pocket = new PocketBridge({
      session: this.session,
      agentBusy: () => this.agentBusy,
      ask: (text, opts) => this.ask(text, opts),
      abort: () => this.abort(),
      acceptAll: () => this.acceptAllFiles(),
      revertAll: () => this.revertAllFiles(),
      saveCustom: (model, baseUrl, apiKey) => this.saveCustomEndpoint(model, baseUrl, apiKey),
      setModel: (modelId) => {
        this.modelId = modelId || DEFAULT_MODEL_ID;
      },
      getModel: () => this.modelId,
      listModels: () =>
        pickerModels(this.readyCustoms())
          .filter((m) => !isAddCustomModel(m.id))
          .map((m) => ({ id: m.id, label: m.label })),
    }, () => this.pushPocket());
    this.virtualOffice.onCabinClick((workerId) => this.showVoWorkerChat(workerId));
    this.virtualOffice.onError((workerId, text) => {
      this.post({ type: 'error', voWorkerId: workerId, text });
      this.pushVoStatus();
    });
    void this.loadCustoms();
  }

  private async loadCustoms() {
    const ctx = this.context;
    if (!ctx) return;
    const stored = ctx.globalState.get<Array<{ id?: string; model?: string; baseUrl?: string }>>('olkil.custom.endpoints');
    if (Array.isArray(stored) && stored.length) {
      const next: CustomEndpoint[] = [];
      for (const row of stored) {
        const id = String(row.id || '').trim();
        if (!id) continue;
        const apiKey = String((await ctx.secrets.get('olkil.custom.apiKey.' + id)) || '');
        next.push({
          id,
          model: String(row.model || '').trim(),
          baseUrl: String(row.baseUrl || '').trim(),
          apiKey,
        });
      }
      this.customs = next;
    } else {
      const old = ctx.globalState.get<{ model?: string; baseUrl?: string }>('olkil.custom.endpoint');
      const oldKey = String((await ctx.secrets.get('olkil.custom.apiKey')) || '');
      if (old?.model && old.baseUrl && oldKey) {
        this.customs = [
          {
            id: 'legacy',
            model: String(old.model).trim(),
            baseUrl: String(old.baseUrl).trim(),
            apiKey: oldKey,
          },
        ];
        await this.persistCustoms();
      }
    }
    if (this.modelId === CUSTOM_MODEL_ID && this.customs[0]) {
      this.modelId = customPickerId(this.customs[0].id);
      void ctx.globalState.update('olkil.modelId', this.modelId);
    }
    this.pushAuth();
  }

  private async saveCustomEndpoint(modelRaw: string, baseUrlRaw: string, apiKeyRaw: string, preferredId = ''): Promise<boolean> {
    const model = String(modelRaw || '').trim();
    const baseUrl = String(baseUrlRaw || '').trim();
    const incomingKey = String(apiKeyRaw || '').trim();
    let id = String(preferredId || '').trim();
    const existing = id ? this.customs.find((c) => c.id === id) : undefined;
    if (!existing) id = newCustomId();
    const apiKey = incomingKey || existing?.apiKey || '';
    const row: CustomEndpoint = { id, model, baseUrl, apiKey };
    if (!customEndpointReady(row)) {
      this.post({ type: 'error', text: 'Add model id, base URL, and API key, then save.' });
      return false;
    }
    this.customs = existing ? this.customs.map((c) => (c.id === id ? row : c)) : this.customs.concat(row);
    await this.persistCustoms();
    this.modelId = customPickerId(id);
    void this.context?.globalState.update('olkil.modelId', this.modelId);
    this.pushAuth();
    return true;
  }

  private async persistCustoms() {
    const ctx = this.context;
    if (!ctx) return;
    await ctx.globalState.update(
      'olkil.custom.endpoints',
      this.customs.map((c) => ({ id: c.id, model: c.model, baseUrl: c.baseUrl })),
    );
    for (const c of this.customs) {
      if (c.apiKey) await ctx.secrets.store('olkil.custom.apiKey.' + c.id, c.apiKey);
    }
  }

  private activeCustom(): CustomEndpoint | null {
    const id = customIdFromModelId(this.modelId);
    if (!id) return null;
    return this.customs.find((c) => c.id === id) || null;
  }

  private readyCustoms() {
    return this.customs.filter((c) => customEndpointReady(c));
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'webview'), vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webviewView.webview.html = this.html(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg) => void this.onMessage(msg));
    void this.boot();
  }

  private post(msg: Record<string, unknown>) {
    if (this.voEventWorkerId && msg.voWorkerId == null) {
      msg = { ...msg, voWorkerId: this.voEventWorkerId };
    }
    void this.view?.webview.postMessage(msg);
    if (!msg.voWorkerId && this.pocket?.activeTaskId) this.pocket.onChatEvent(msg);
    if (String(msg.type || '') === 'idle' && !msg.voWorkerId) this.agentBusy = false;
    const wid = String(msg.voWorkerId || this.virtualOffice.inspectedWorkerId || '');
    if (this.virtualOffice.active && wid) {
      const t = String(msg.type || '');
      if (t === 'activity' || t === 'assistant' || t === 'phase' || t === 'fileDiff' || t === 'error' || t === 'user') {
        this.virtualOffice.appendLog(wid, msg);
      }
    }
  }

  async boot() {
    if (this.context?.globalState.get('olkil.remoteAccess')) {
      const stale = this.context.globalState.get<number>('olkil.remoteAccessPid');
      const ok = await this.keepAwake.start(stale);
      if (ok && this.keepAwake.pid()) await this.context.globalState.update('olkil.remoteAccessPid', this.keepAwake.pid());
      if (!ok) {
        await this.context.globalState.update('olkil.remoteAccess', false);
        await this.context.globalState.update('olkil.remoteAccessPid', 0);
      }
    }
    this.session = await ensureSession();
    this.quotaLoaded = false;
    if (this.session) {
      try {
        this.quota = await fetchQuota(this.session);
        this.quotaLoaded = true;
      } catch {
        this.quota = null;
      }
    }
    this.refreshFreeTrial();
    this.pushAuth();
    void this.loadModelCatalog();
    if (this.session) void this.chatHistory.bootstrap();
    if (this.session && this.canRunAgent()) {
      void this.ensureEngine().catch((err) => {
        this.post({ type: 'error', text: err instanceof Error ? err.message : String(err) });
      });
    }
    if (this.session) {
      void this.armPocket().then(() => {
        if (this.keepAwake.isOn()) void this.screen.start();
      });
    }
  }

  private async ensureRemoteSecret(): Promise<string> {
    const uid = this.session?.user?.uid || '';
    if (!uid || !this.context) return '';
    const map = { ...(this.context.globalState.get<Record<string, string>>('olkil.remoteSecrets') || {}) };
    const existing = String(map[uid] || '');
    if (/^[a-f0-9]{64}$/.test(existing)) return existing;
    const secret = crypto.randomBytes(32).toString('hex');
    map[uid] = secret;
    await this.context.globalState.update('olkil.remoteSecrets', map);
    return secret;
  }

  private async armPocket(): Promise<string> {
    const secret = await this.ensureRemoteSecret();
    if (!secret || !this.pocket) return '';
    this.pocket.setSecret(secret);
    if (!this.pocket.isOn()) await this.pocket.start();
    return secret;
  }

  private async showRemoteQr() {
    try {
      if (!this.session) {
        await this.signIn();
        if (!this.session) return;
      }
      const secret = await this.armPocket();
      if (!secret) {
        void vscode.window.showWarningMessage('Sign in to OLKIL to connect your phone.');
        return;
      }
      this.post({ type: 'remoteQr', open: true, url: 'https://olkil.com/pocket/#k=' + secret });
    } catch (err) {
      void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
    }
  }

  private canRunCustom() {
    return Boolean(this.activeCustom() && customEndpointReady(this.activeCustom()));
  }

  private canRunCloud() {
    return canUseVscodeAgent(this.quota);
  }

  private canRunAgent() {
    return this.canRunCustom() || this.canRunCloud() || this.freeTrial.kind === 'active';
  }

  private shouldUseFreeTrial(): boolean {
    if (this.canRunCloud()) return false;
    if (isCustomModel(this.modelId) && this.canRunCustom()) return false;
    return this.freeTrial.kind === 'active';
  }

  private refreshFreeTrial() {
    const uid = this.session?.user?.uid || '';
    if (!uid || this.canRunCloud()) {
      this.freeTrial = { kind: 'none' };
      return;
    }
    this.freeTrial = openFreeTrial(vscode.env.machineId, uid, this.quotaLoaded);
    if (this.freeTrial.kind === 'blocked') this.warnBlockedTrial();
  }

  private warnBlockedTrial() {
    if (this.freeTrialWarned) return;
    this.freeTrialWarned = true;
    void vscode.window.showWarningMessage(
      'This computer already used the free trial on another OLKIL account. Upgrade to Lite or Pro to continue.',
    );
  }

  private upgradeReason(): string {
    if (this.freeTrial.kind === 'blocked') return 'trial-blocked';
    if (this.freeTrial.kind === 'exhausted') return 'trial-ended';
    return '';
  }

  private quotaForUi(): OlkilQuota | null {
    if (!this.quota || this.canRunCloud() || this.freeTrial.kind !== 'active') return this.quota;
    const left = this.freeTrial.left.toLocaleString('en-US');
    return { ...this.quota, planName: this.quota.planName || 'Free', leftLabel: left + ' tokens left' };
  }

  private pushAuth() {
    void vscode.commands.executeCommand('setContext', 'olkil.signedIn', Boolean(this.session));
    this.post({
      type: 'auth',
      signedIn: Boolean(this.session),
      user: this.session?.user || null,
      quota: this.quotaForUi(),
      engineReady: this.engineReady,
      paid: this.canRunCloud(),
      chatOpen: Boolean(this.session),
      plans: PAID_PLANS,
      models: pickerModels(this.customs),
      modelId: this.modelId,
      virtualOffice: this.virtualOffice.active,
      voAssignee: this.virtualOffice.assigneeId,
      voAssignees: VO_ASSIGNEES,
      voInspected: this.virtualOffice.inspectedWorkerId,
      voRunning: this.virtualOffice.listRuns().map((r) => ({
        workerId: r.workerId,
        workerName: r.workerName,
        title: r.title,
        status: r.status,
      })),
      customs: this.customs.map((c) => ({
        id: c.id,
        model: c.model,
        baseUrl: c.baseUrl,
        hasKey: Boolean(c.apiKey),
      })),
      pocketOn: !!this.pocket?.isOn(),
      pocketCode: this.pocket?.code() || '',
      pocketError: this.pocket?.lastError || '',
      remoteAccess: this.keepAwake.isOn(),
    });
  }

  private pushPocket() {
    this.post({
      type: 'pocket',
      pocketOn: !!this.pocket?.isOn(),
      pocketCode: this.pocket?.code() || '',
      pocketError: this.pocket?.lastError || '',
    });
  }

  /** Lightweight VO status — avoids full auth remount that blinked "Assigned to …". */
  private pushVoStatus() {
    this.post({
      type: 'voStatus',
      virtualOffice: this.virtualOffice.active,
      voAssignee: this.virtualOffice.assigneeId,
      voInspected: this.virtualOffice.inspectedWorkerId,
      voRunning: this.virtualOffice.listRuns().map((r) => ({
        workerId: r.workerId,
        workerName: r.workerName,
        title: r.title,
        status: r.status,
      })),
    });
  }

  private async loadModelCatalog() {
    try {
      await fetchOpenRouterCatalog();
      this.pushAuth();
      if (this.engineReady && this.session && this.canRunAgent()) {
        await this.ensureEngine();
      }
    } catch {
      /* keep featured list */
    }
  }

  async signIn() {
    this.session = await completeLogin();
    this.quotaLoaded = false;
    try {
      this.quota = await fetchQuota(this.session);
      this.quotaLoaded = true;
    } catch {
      this.quota = {
        plan: '',
        planName: 'Signed in',
        leftLabel: '',
        spendable: 0,
        percentUsed: 0,
        percentLeft: 100,
        isPaid: false,
        allowed: false,
        upgradeUrl: 'https://olkil.com/pricing/',
      };
    }
    this.refreshFreeTrial();
    this.pushAuth();
    void this.loadModelCatalog();
    void this.chatHistory.bootstrap();
    if (this.canRunAgent()) {
      await this.ensureEngine();
    }
    void this.armPocket();
  }

  signOut() {
    clearSession();
    this.session = null;
    this.quota = null;
    this.quotaLoaded = false;
    this.freeTrial = { kind: 'none' };
    this.freeTrialWarned = false;
    this.chatHistory.resetLocal();
    this.currentChatId = '';
    this.currentChatCreatedAt = 0;
    this.chatMessages = [];
    this.engine.dispose();
    this.engine = new OlkilEngine();
    this.engine.onEvent((event) => this.onEngineEvent(event));
    this.engineReady = false;
    this.screen.stop();
    this.pocket?.stop();
    this.pushAuth();
  }

  async newChat() {
    if (!this.session) return;
    this.persistCurrentChat();
    this.currentChatId = '';
    this.currentChatCreatedAt = 0;
    this.chatMessages = [];
    if (this.canRunAgent()) {
      await this.ensureEngine();
      await this.engine.newSession();
    }
    this.resetTurnState();
    this.post({ type: 'reset' });
  }

  /** Title-bar History — last 3 chats (same Firestore doc as desktop IDE). */
  async showHistory() {
    if (!this.session) {
      await this.signIn();
      if (!this.session) return;
    }
    await this.chatHistory.bootstrap();
    const items = this.chatHistory.listSummaries();
    if (!items.length) {
      void vscode.window.showInformationMessage('No recent chats yet — only the latest 3 are kept (48h).');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      items.map((h) => ({
        label: h.title,
        description: `${formatHistoryAge(h.updatedAt)} · ${h.messageCount} msgs`,
        id: h.id,
      })),
      { title: 'Recent chats · max 3 · 48h', placeHolder: 'Open a previous chat' },
    );
    if (!picked) return;
    await this.loadChatHistory(picked.id);
  }

  private async loadChatHistory(id: string) {
    this.persistCurrentChat();
    let session = this.chatHistory.getSessionById(id);
    if (!session) {
      await this.chatHistory.bootstrap();
      session = this.chatHistory.getSessionById(id);
    }
    if (!session) {
      void vscode.window.showWarningMessage('That chat expired or is no longer available.');
      return;
    }
    this.currentChatId = session.id;
    this.currentChatCreatedAt = session.createdAt;
    this.chatMessages = session.messages.map((m) => ({ ...m }));
    this.resetTurnState();
    if (this.canRunAgent()) {
      try {
        await this.ensureEngine();
        await this.engine.newSession();
      } catch {
        /* still show messages */
      }
    }
    this.post({ type: 'loadHistory', messages: session.messages });
  }

  private persistCurrentChat() {
    if (this.virtualOffice.active) return;
    if (!this.currentChatId || !this.chatMessages.some((m) => m.role === 'user')) return;
    const now = Date.now();
    this.chatHistory.scheduleUpsert({
      id: this.currentChatId,
      title: titleFromMessages(this.chatMessages),
      createdAt: this.currentChatCreatedAt || now,
      updatedAt: now,
      expiresAt: now + 48 * 60 * 60 * 1000,
      messages: this.chatMessages,
    });
  }

  private trackChatUser(text: string) {
    if (this.virtualOffice.active) return;
    if (!this.currentChatId) {
      this.currentChatId = 'chat-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      this.currentChatCreatedAt = Date.now();
    }
    this.chatMessages.push({
      id: 'u-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      role: 'user',
      content: text,
    });
  }

  private trackChatAssistant(text: string) {
    if (this.virtualOffice.active) return;
    const t = text.trim();
    if (!t || !this.currentChatId) return;
    this.chatMessages.push({
      id: 'a-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      role: 'assistant',
      content: t,
    });
    this.persistCurrentChat();
  }

  private resetTurnState() {
    this.liveText = '';
    this.userMessageIds.clear();
    this.turnUsage = null;
    this.turnGenIds.clear();
    this.turnCharged = false;
    this.charging = false;
    this.turnFailed = false;
    this.turnFiles.clear();
    this.fileBefore.clear();
    this.turnHadTools = false;
    this.pendingTodos = false;
    this.autoContinues = 0;
    this.userAborted = false;
    this.finishingIdle = false;
    this.completedToolCalls.clear();
    for (const t of this.inkTimers) clearTimeout(t);
    this.inkTimers.clear();
    this.clearLiveDecorations();
  }

  private voTurn(workerId: string) {
    let t = this.voTurns.get(workerId);
    if (!t) {
      t = { hadTools: false, pendingTodos: false, autoContinues: 0, finishing: false, aborted: false };
      this.voTurns.set(workerId, t);
    }
    return t;
  }

  private resetVoTurn(workerId: string) {
    this.voTurns.set(workerId, {
      hadTools: false,
      pendingTodos: false,
      autoContinues: 0,
      finishing: false,
      aborted: false,
    });
    this.voLiveText.set(workerId, '');
    this.voLastEventAt.set(workerId, Date.now());
    // Keep completedToolCalls — parallel workers share engine events; per-call ids stay unique
    this.ensureVoWatchdog();
  }

  private ensureVoWatchdog() {
    if (this.voWatchTimer) return;
    this.voWatchTimer = setInterval(() => {
      void this.tickVoWatchdog();
    }, 12_000);
  }

  /** Unstick VO teammates that hang on Reading/Editing with no engine progress. */
  private async tickVoWatchdog() {
    if (!this.virtualOffice.active) return;
    const now = Date.now();
    for (const run of this.virtualOffice.listRuns()) {
      if (run.status !== 'running') continue;
      const last = this.voLastEventAt.get(run.workerId) || run.startedAt || now;
      const silentMs = now - last;
      const text = cleanAssistantText(this.voLiveText.get(run.workerId) || '');
      const turn = this.voTurn(run.workerId);
      // ~60s quiet + reply looks finished → complete (stops office/chat desync)
      if (silentMs >= 60_000 && text && !looksIncompleteReply(text, turn.hadTools, turn.pendingTodos, this.turnFiles.size)) {
        await this.forceVoWorkerComplete(run.workerId, 'quiet-done');
        continue;
      }
      // ~90s with zero events → force finish so workers never stick forever on Reading/Editing
      if (silentMs >= 90_000) {
        await this.forceVoWorkerComplete(run.workerId, 'watchdog');
      }
    }
  }

  private async forceVoWorkerComplete(workerId: string, reason: string) {
    const run = this.virtualOffice.getRun(workerId);
    if (!run || run.status !== 'running') return;
    const turn = this.voTurn(workerId);
    if (turn.finishing || turn.aborted) return;
    turn.finishing = true;
    this.virtualOffice.completeIfSession(run.sessionId);
    const cleaned = cleanAssistantText(this.voLiveText.get(workerId) || '');
    if (cleaned && !isUserEcho(cleaned)) {
      this.post({ type: 'assistant', text: cleaned, live: false, voWorkerId: workerId });
    }
    this.post({
      type: 'activity',
      voWorkerId: workerId,
      id: 'vo-done-' + workerId + '-' + Date.now(),
      label: `${run.workerName} finished`,
      detail: reason === 'watchdog' ? 'Timed out idle work' : run.title,
      done: true,
    });
    this.post({ type: 'phase', voWorkerId: workerId, label: '' });
    this.post({
      type: 'voWorkerDone',
      workerId,
      voRunning: this.virtualOffice.listRuns().map((r) => ({
        workerId: r.workerId,
        workerName: r.workerName,
        title: r.title,
        status: r.status,
      })),
    });
    this.post({ type: 'idle', voWorkerId: workerId });
    this.pushVoStatus();
    const still = this.virtualOffice.runningCount();
    this.post({
      type: 'voParallel',
      label:
        still > 0
          ? `${still} teammate${still === 1 ? '' : 's'} still working — send another task anytime`
          : 'All free — send the next task',
    });
    try {
      await this.engine.abortSession(run.sessionId);
    } catch {
      /* best-effort */
    }
    turn.finishing = false;
  }

  async ask(text: string, opts?: { mode?: string; skipUserEcho?: boolean; hasImages?: boolean; pocket?: boolean }) {
    const trimmed = String(text || '').trim();
    const mode = String(opts?.mode || 'agent');
    if (!trimmed && !opts?.hasImages) return;
    if (!this.session) {
      await this.signIn();
      if (!this.session) return;
    }
    if (isAddCustomModel(this.modelId) || (isCustomModel(this.modelId) && !this.canRunCustom())) {
      if (!opts?.skipUserEcho) this.post({ type: 'user', text: trimmed || 'Image' });
      this.post({
        type: 'error',
        text: 'Add model id, base URL, and API key in Custom at the top, then send again.',
      });
      return;
    }

    if (!this.virtualOffice.active || opts?.pocket) {
      this.agentBusy = true;
      if (!opts?.skipUserEcho) {
        this.post({ type: 'user', text: trimmed });
      }
      if (trimmed) this.trackChatUser(trimmed);
      this.resetTurnState();
    }
    if (!this.virtualOffice.active || opts?.pocket) {
      this.post({ type: 'phase', label: 'Planning next moves' });
    }

    const quotaPromise = fetchQuota(this.session)
      .then((q) => {
        this.quota = q;
        this.quotaLoaded = true;
        return q;
      })
      .catch(() => this.quota);

    if (!this.canRunAgent()) {
      await quotaPromise;
      this.refreshFreeTrial();
      if (!this.canRunAgent()) {
        this.pushAuth();
        this.post({ type: 'upgrade', reason: this.upgradeReason() });
        this.post({ type: 'idle' });
        return;
      }
    } else {
      void quotaPromise.then(() => this.pushAuth());
    }

    // Engine prompt may include silent Ask instructions — never shown in the chat bubble
    let enginePrompt =
      trimmed ||
      (opts?.hasImages ? 'Please look at the attached image(s) and help me with them.' : '');
    if (mode === 'ask') {
      enginePrompt +=
        '\n\n[OLKIL Ask mode: answer in chat only — do not edit files, create files, or run tools.]';
    }

    if (this.virtualOffice.active && !opts?.pocket) {
      try {
        const voPrompt = isSimpleChatPrompt(trimmed) ? trimmed : this.withEditorContext(trimmed);
        const run = await this.virtualOffice.startTask(voPrompt);
        this.resetVoTurn(run.workerId);
        this.post({
          type: 'voOpenChat',
          workerId: run.workerId,
          workerName: run.workerName,
          fresh: true,
          prompt: trimmed,
        });
        this.post({
          type: 'activity',
          voWorkerId: run.workerId,
          id: 'vo-assign-' + run.workerId + '-' + run.startedAt,
          label: `Assigned to ${run.workerName}`,
          detail: run.title,
          done: true,
        });
        this.post({
          type: 'phase',
          voWorkerId: run.workerId,
          label: `${run.workerName} working`,
        });
        this.pushVoStatus();
        this.post({
          type: 'voParallel',
          label: `${run.workerName} on it — send another task anytime`,
        });
      } catch (err) {
        this.post({ type: 'error', text: err instanceof Error ? err.message : String(err) });
        this.post({ type: 'idle' });
      }
      return;
    }

    try {
      await this.ensureEngine();
      await this.engine.sendPrompt(
        mode === 'ask' ? enginePrompt : this.withEditorContext(enginePrompt),
        this.modelId,
      );
    } catch (err) {
      this.post({ type: 'error', text: err instanceof Error ? err.message : String(err) });
      this.post({ type: 'idle' });
    }
  }

  private showVoWorkerChat(workerId: string) {
    const run = this.virtualOffice.getRun(workerId);
    const name = run?.workerName || VO_WORKERS.find((w) => w.id === workerId)?.name || workerId;
    this.post({
      type: 'voOpenChat',
      workerId,
      workerName: name,
      fresh: false,
      messages: run?.log || [],
      phase:
        run?.status === 'running'
          ? `${name} working`
          : run
            ? `${name} · ${run.status}`
            : `${name} · idle`,
    });
    this.pushVoStatus();
  }

  async abort() {
    this.userAborted = true;
    await this.engine.abort();
    this.post({ type: 'liveStatus', label: '', detail: '', file: '', clear: true });
    this.post({ type: 'idle' });
  }

  /** Stop one Virtual Office teammate without killing other parallel agents. */
  async abortVoWorker(workerId: string) {
    const turn = this.voTurn(workerId);
    turn.aborted = true;
    turn.finishing = false;
    const run = await this.virtualOffice.stopWorker(workerId);
    if (!run) return;
    this.post({
      type: 'activity',
      voWorkerId: workerId,
      id: 'vo-stop-' + workerId + '-' + Date.now(),
      label: `${run.workerName} stopped`,
      detail: run.title,
      done: true,
    });
    this.post({ type: 'phase', voWorkerId: workerId, label: '' });
    this.post({
      type: 'voWorkerDone',
      workerId,
      voRunning: this.virtualOffice.listRuns().map((r) => ({
        workerId: r.workerId,
        workerName: r.workerName,
        title: r.title,
        status: r.status,
      })),
    });
    this.post({ type: 'idle', voWorkerId: workerId });
    this.pushVoStatus();
    const still = this.virtualOffice.runningCount();
    this.post({
      type: 'voParallel',
      label:
        still > 0
          ? `${still} teammate${still === 1 ? '' : 's'} still working — send another task anytime`
          : 'All free — send the next task',
    });
  }

  private withEditorContext(text: string): string {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return text;
    const file = vscode.workspace.asRelativePath(editor.document.uri);
    const selected = editor.selection.isEmpty ? '' : editor.document.getText(editor.selection);
    const bits = [text, 'Active file: ' + file];
    if (selected.trim()) {
      bits.push('Selected code from ' + file + ':\n```\n' + selected.slice(0, 6000) + '\n```');
    }
    return bits.join('\n\n');
  }

  private listContextFiles(): { path: string; name: string; kind: string }[] {
    const seen = new Set<string>();
    const out: { path: string; name: string; kind: string }[] = [];
    const push = (uri: vscode.Uri, kind: string) => {
      const abs = uri.fsPath;
      if (!abs || seen.has(abs)) return;
      seen.add(abs);
      const rel = vscode.workspace.asRelativePath(uri);
      out.push({
        path: rel || abs,
        name: path.basename(abs),
        kind,
      });
    };
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.uri.scheme === 'file') push(ed.document.uri, 'open');
    }
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === 'file' && !doc.isUntitled) push(doc.uri, 'recent');
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
      try {
        const entries = fs.readdirSync(folder.uri.fsPath, { withFileTypes: true }).slice(0, 40);
        for (const ent of entries) {
          if (ent.name.startsWith('.')) continue;
          const abs = path.join(folder.uri.fsPath, ent.name);
          if (ent.isDirectory()) {
            out.push({ path: ent.name + '/', name: ent.name, kind: 'folder' });
          } else if (ent.isFile()) {
            push(vscode.Uri.file(abs), 'workspace');
          }
        }
      } catch {
        /* ignore */
      }
    }
    return out.slice(0, 80);
  }

  private async ensureEngine() {
    if (!this.session) throw new Error('Sign in first.');
    const trial = this.shouldUseFreeTrial() ? freeTrialCreds() : null;
    await this.engine.ensureStarted(
      this.session,
      workspaceFolder(),
      this.readyCustoms(),
      this.canRunCloud() || Boolean(trial),
      trial,
    );
    this.engineReady = true;
    this.pushAuth();
  }

  private onEngineEvent(raw: Record<string, unknown>) {
    const event = unwrapEvent(raw);
    const type = String(event.type || '');
    const props = (event.properties || {}) as Record<string, any>;
    const eventSession = String(props.sessionID || props.sessionId || props.info?.id || props.info?.sessionID || '');
    const voRun = eventSession ? this.virtualOffice.sessionToWorker(eventSession) : undefined;
    // Allow main chat session OR any Virtual Office worker session through.
    if (eventSession && this.engine.sessionId && eventSession !== this.engine.sessionId && !voRun) {
      return;
    }
    // After Stop: ignore late tool/text/file events so the teammate looks truly stopped.
    if (eventSession && this.virtualOffice.isSessionStopped(eventSession)) {
      if (type === 'permission.asked' || type === 'permission.updated') {
        const id = permissionId(event);
        if (id) void this.engine.replyPermissionFor(eventSession, id, 'reject');
      }
      return;
    }
    this.voEventWorkerId = voRun?.workerId || null;
    if (voRun) {
      this.voLastEventAt.set(voRun.workerId, Date.now());
      this.ensureVoWatchdog();
    }
    try {
      this.onEngineEventBody(event, type, props, voRun);
    } finally {
      this.voEventWorkerId = null;
    }
  }

  private getLiveText(): string {
    if (this.voEventWorkerId) return this.voLiveText.get(this.voEventWorkerId) || '';
    return this.liveText;
  }

  private setLiveText(text: string) {
    if (this.voEventWorkerId) this.voLiveText.set(this.voEventWorkerId, text);
    else this.liveText = text;
  }

  private onEngineEventBody(
    event: Record<string, unknown>,
    type: string,
    props: Record<string, any>,
    voRun: { workerId: string; workerName: string } | undefined,
  ) {
    if (type === 'permission.asked' || type === 'permission.updated') {
      const id = permissionId(event);
      if (id) {
        if (voRun) {
          const sid = String(props.sessionID || props.sessionId || '');
          if (sid) void this.engine.replyPermissionFor(sid, id, 'always');
        } else {
          void this.engine.replyPermission(id, 'always');
        }
      }
      return;
    }
    if (type === 'question.asked') {
      return;
    }
    if (type === 'session.status') {
      // Keep status internal — do not spam the chat UI.
      return;
    }
    if (type === 'todo.updated') {
      const todos = props.todos || [];
      const pending = todos.some((t: any) => t.status === 'in_progress' || t.status === 'pending');
      if (voRun) this.voTurn(voRun.workerId).pendingTodos = pending;
      else this.pendingTodos = pending;
      // Do not surface raw todo counts ("3 todos") in the activity feed.
      return;
    }
    if (type === 'file.edited') {
      const filePath = sanitizeToolPath(String(props.file || ''));
      if (filePath) {
        this.commitFileChange(filePath);
        const row = this.turnFiles.get(resolveAbs(filePath));
        const base = filePath.split(/[\\/]/).pop() || filePath;
        const creating = row?.action === 'create' || (row?.before == null && row?.after != null);
        this.post({
          type: 'activity',
          id: 'file:' + filePath.replace(/\\/g, '/').toLowerCase(),
          label: (creating ? 'Created ' : 'Edited ') + base,
          detail: filePath,
          done: true,
          kind: creating ? 'create' : 'edit',
          action: creating ? 'create' : 'edit',
          file: filePath,
          title: base,
          badge: creating ? 'Writer' : 'Editor',
          line: (creating ? 'Created ' : 'Edited ') + base,
        });
        if (!voRun) this.post({ type: 'phase', label: 'Planning next moves' });
        else this.post({ type: 'phase', voWorkerId: voRun.workerId, label: `${voRun.workerName} working` });
        void this.revealAndDecorate(filePath, false);
        void this.syncDiffs();
      }
      return;
    }
    if (type === 'session.diff') {
      this.applyDiffs(props.diff || props.diffs || props);
      return;
    }
    if (type === 'message.updated') {
      const info = props.info || props;
      if (info && info.role === 'user' && info.id) this.userMessageIds.add(String(info.id));
      if (info && info.role === 'assistant') {
        collectGenerationIds(info, this.turnGenIds);
        this.mergeTurnUsage(info, false);
      }
      return;
    }
    if (type === 'message.part.updated' || type === 'message.part.delta') {
      const part = props.part || {};
      collectGenerationIds(part, this.turnGenIds);
      if (this.userMessageIds.has(String(part.messageID || part.messageId || ''))) return;
      if (part.role === 'user' || props.info?.role === 'user') return;
      if (part.type === 'step-finish' || part.type === 'step_finish') {
        collectGenerationIds(part, this.turnGenIds);
        this.mergeTurnUsage(part, true);
        return;
      }
      if (isReasoningPart(part) || part.type === 'reasoning') {
        // Keep thinking internal — UI stays on Planning next moves (no alternate cue words)
        if (!voRun) this.post({ type: 'phase', label: 'Planning next moves' });
        else this.post({ type: 'phase', voWorkerId: voRun.workerId, label: `${voRun.workerName} working` });
        return;
      }
      if (part.type === 'tool') {
        // Teammate already finished in the office — ignore late tool pings
        if (voRun) {
          const liveRun = this.virtualOffice.getRun(voRun.workerId);
          if (!liveRun || liveRun.status !== 'running') return;
        }
        if (voRun) this.voTurn(voRun.workerId).hadTools = true;
        else this.turnHadTools = true;
        const meta = toolMeta(part);
        const done = part.state?.status === 'completed' || part.state?.status === 'error';
        const filePath = extractFilePath(part);
        const hollowCreate =
          (meta.kind === 'create' || meta.kind === 'edit') &&
          !filePath &&
          (!meta.title || meta.title === 'file');
        // Don't flash a stuck "Creating file" live card with no path — wait for a real target
        if (hollowCreate && !done) {
          if (!voRun) this.post({ type: 'phase', label: 'Planning next moves' });
          else this.post({ type: 'phase', voWorkerId: voRun.workerId, label: `${voRun.workerName} working` });
          return;
        }
        const callKey = String(part.callID || part.id || '');
        if (done && callKey) this.completedToolCalls.add(callKey);
        // Late "pending/running" ping after this call already completed → would reopen loader
        if (!done && callKey && this.completedToolCalls.has(callKey)) return;
        const stableId = activityStableId(meta, part.callID || part.id, filePath);
        const cleanFile = sanitizeToolPath(meta.filePath || filePath);
        this.post({
          type: 'activity',
          id: stableId,
          label: done ? meta.line || meta.label : meta.label,
          detail: sanitizeToolPath(meta.detail) || cleanFile,
          done: done || hollowCreate,
          kind: meta.kind,
          action: meta.action,
          file: cleanFile,
          line: meta.line,
          command: meta.command,
          title: meta.title && meta.title !== 'file' ? meta.title : cleanFile.split('/').pop() || meta.title,
          badge: meta.badge,
        });
        if (done) {
          if (!voRun) this.post({ type: 'phase', label: 'Planning next moves' });
          else this.post({ type: 'phase', voWorkerId: voRun.workerId, label: `${voRun.workerName} working` });
        }
        if (filePath && /edit|write|patch|apply|create/i.test(String(part.tool || ''))) {
          const st = String(part.state?.status || '');
          if (st === 'pending' || st === 'running' || !done) {
            this.snapshotBefore(filePath);
          }
          if (done) {
            const fromTool = extractWriteContent(part);
            this.commitFileChange(filePath, fromTool);
            // Skip line-by-line ink animation — keeps the agent loop snappy
            void this.revealAndDecorate(filePath, false);
            void this.syncDiffs();
          }
        }
        return;
      }
      if (part.type === 'patch' && Array.isArray(part.files)) {
        for (const file of part.files) {
          this.snapshotBefore(String(file));
          this.commitFileChange(String(file));
        }
        void this.syncDiffs();
        return;
      }
      const text = eventText(event);
      if (!text || isUserEcho(text)) return;
      if (/insufficient balance/i.test(text)) {
        this.post({ type: 'error', text: friendlyEngineError(text) });
        return;
      }
      this.post({ type: 'activity', id: 'thinking', label: 'Thought', done: true, kind: 'status' });
      const isDelta =
        type === 'message.part.delta' || (typeof props.delta === 'string' && !part.text);
      this.setLiveText(isDelta ? this.getLiveText() + text : text);
      const cleaned = cleanAssistantText(this.getLiveText());
      if (!cleaned) return;
      this.setLiveText(cleaned);
      this.post({ type: 'assistant', text: this.getLiveText(), live: true });
      // Keep Dev Studio feed alive between thoughts/tools (Stop is on, no silent gaps)
      if (!voRun) this.post({ type: 'phase', label: 'Planning next moves' });
      else if (voRun) this.post({ type: 'phase', voWorkerId: voRun.workerId, label: `${voRun.workerName} working` });
      return;
    }
    if (type === 'session.error') {
      const err = props.error;
      const msg =
        (err && (err.data?.message || err.message || err.name)) ||
        (typeof err === 'string' ? err : 'The coding engine hit an error.');
      if (voRun) {
        const sid = String(props.sessionID || props.sessionId || '');
        if (sid) this.virtualOffice.failIfSession(sid);
        this.pushVoStatus();
      }
      if (/abort/i.test(String(msg))) {
        this.post({ type: 'liveStatus', label: '', detail: '', file: '', clear: true });
        this.post({ type: 'idle', voWorkerId: voRun?.workerId });
        return;
      }
      this.turnFailed = true;
      this.post({ type: 'error', text: friendlyEngineError(String(msg)), voWorkerId: voRun?.workerId });
      this.post({ type: 'liveStatus', label: '', detail: '', file: '', clear: true });
      this.post({ type: 'idle', voWorkerId: voRun?.workerId });
      return;
    }
    if (type === 'session.idle') {
      void this.handleSessionIdle(this.voEventWorkerId);
    }
  }

  private postLive(label: string, detail: string, file: string) {
    this.post({ type: 'liveStatus', label, detail, file: file || '' });
  }

  private async handleSessionIdle(voWorkerId?: string | null) {
    const readLive = () => (voWorkerId ? this.voLiveText.get(voWorkerId) || '' : this.liveText);
    const writeLive = (t: string) => {
      if (voWorkerId) this.voLiveText.set(voWorkerId, t);
      else this.liveText = t;
    };
    const voBag = voWorkerId ? this.voTurn(voWorkerId) : null;
    const hadTools = voBag ? voBag.hadTools : this.turnHadTools;
    const pendingTodos = voBag ? voBag.pendingTodos : this.pendingTodos;
    const autoContinues = voBag ? voBag.autoContinues : this.autoContinues;
    const finishing = voBag ? voBag.finishing : this.finishingIdle;
    const aborted = voBag ? voBag.aborted : this.userAborted;

    if (finishing || aborted) {
      this.post({ type: 'liveStatus', label: '', detail: '', file: '', clear: true });
      this.post({ type: 'idle', voWorkerId: voWorkerId || undefined });
      return;
    }
    // Stopped VO teammate — don't flush more assistant text / diffs / continues
    if (this.virtualOffice.active && voWorkerId) {
      const stopped = this.virtualOffice.getRun(voWorkerId);
      if (!stopped || stopped.status !== 'running') {
        this.post({ type: 'idle', voWorkerId });
        return;
      }
    }

    const cleaned = cleanAssistantText(readLive());
    await this.syncDiffs();

    const fileChanges = this.turnFiles.size;
    const incomplete = looksIncompleteReply(cleaned, hadTools, pendingTodos, fileChanges);
    if (incomplete && autoContinues < MAX_AUTO_CONTINUES && !aborted) {
      if (voBag) {
        voBag.autoContinues += 1;
        voBag.hadTools = false;
      } else {
        this.autoContinues += 1;
        this.turnHadTools = false;
      }
      // Keep streaming bubble live while we continue — do not finalize summary yet
      if (cleaned && !isUserEcho(cleaned) && !/insufficient balance/i.test(cleaned)) {
        writeLive(cleaned);
        this.post({ type: 'assistant', text: cleaned, live: true, voWorkerId: voWorkerId || undefined });
      }
      const contN = voBag ? voBag.autoContinues : this.autoContinues;
      if (!voWorkerId) this.post({ type: 'phase', label: 'Planning next moves' });
      else this.post({ type: 'phase', voWorkerId, label: 'Planning next moves' });
      this.post({
        type: 'activity',
        voWorkerId: voWorkerId || undefined,
        id: 'continue-' + (voWorkerId || 'main') + '-' + contN,
        label: 'Continuing…',
        detail: 'Finishing remaining work (' + contN + '/' + MAX_AUTO_CONTINUES + ')',
        done: false,
        kind: 'status',
      });
      try {
        if (this.virtualOffice.active && voWorkerId) {
          const run = this.virtualOffice.getRun(voWorkerId);
          if (run && run.status === 'running') {
            await this.virtualOffice.continueRun(voWorkerId, CONTINUE_PROMPT);
            return;
          }
        }
        await this.engine.sendPrompt(CONTINUE_PROMPT, this.modelId);
        return;
      } catch (err) {
        this.post({
          type: 'error',
          text: err instanceof Error ? err.message : String(err),
          voWorkerId: voWorkerId || undefined,
        });
      }
    }

    // Truly finished — file card first, then final summary (summary must be last in UI)
    for (const row of this.turnFiles.values()) row.live = false;
    this.pushFiles();

    let summary = cleaned;
    if ((!summary || isUserEcho(summary)) && !/insufficient balance/i.test(String(summary || ''))) {
      const n = this.turnFiles.size;
      summary =
        n > 0
          ? `Done. Updated ${n} file${n === 1 ? '' : 's'} for this task.`
          : 'Done. Finished the assigned task.';
    }
    if (summary && !isUserEcho(summary) && !/insufficient balance/i.test(summary)) {
      writeLive(summary);
      this.post({ type: 'assistant', text: summary, live: false, voWorkerId: voWorkerId || undefined });
      if (!voWorkerId) this.trackChatAssistant(summary);
    }

    if (this.virtualOffice.active && voWorkerId) {
      const voRun = this.virtualOffice.getRun(voWorkerId);
      // Already Stopped / finished — swallow late idle (no "finished" / continue)
      if (!voRun || voRun.status !== 'running') {
        this.post({ type: 'idle', voWorkerId });
        return;
      }
      this.virtualOffice.completeIfSession(voRun.sessionId);
      if (voBag) voBag.finishing = true;
      this.post({
        type: 'activity',
        voWorkerId,
        id: 'vo-done-' + voRun.workerId + '-' + Date.now(),
        label: `${voRun.workerName} finished`,
        detail: voRun.title,
        done: true,
      });
      this.post({ type: 'phase', voWorkerId, label: '' });
      this.post({
        type: 'voWorkerDone',
        workerId: voWorkerId,
        voRunning: this.virtualOffice.listRuns().map((r) => ({
          workerId: r.workerId,
          workerName: r.workerName,
          title: r.title,
          status: r.status,
        })),
      });
      this.post({ type: 'idle', voWorkerId });
      this.pushVoStatus();
      const still = this.virtualOffice.runningCount();
      this.post({
        type: 'voParallel',
        label:
          still > 0
            ? `${still} teammate${still === 1 ? '' : 's'} still working — send another task anytime`
            : 'All free — send the next task',
      });
      this.post({ type: 'liveStatus', label: '', detail: '', file: '', clear: true });
      void this.finishTurn().finally(() => {
        if (voBag) voBag.finishing = false;
      });
      return;
    }

    this.finishingIdle = true;
    this.post({ type: 'liveStatus', label: '', detail: '', file: '', clear: true });
    this.post({ type: 'idle' });
    void this.finishTurn().finally(() => {
      this.finishingIdle = false;
    });
  }

  private snapshotBefore(filePath: string) {
    const abs = resolveAbs(filePath);
    if (!abs || this.fileBefore.has(abs)) return;
    const before = readFileSafe(abs);
    // null = file did not exist (create). Never read AFTER the write.
    this.fileBefore.set(abs, before);
  }

  /** Commit a real before→after change and push exact +/- counts + ink stream. */
  private commitFileChange(filePath: string, afterOverride?: string | null) {
    const abs = resolveAbs(filePath);
    if (!abs) return;
    const rel = String(filePath || '').trim() || abs;

    if (!this.fileBefore.has(abs)) {
      // Missed the pending snapshot. If tool gave us content and disk matches,
      // treat as create only when file was empty/missing before this call's override.
      const onDisk = readFileSafe(abs);
      if (afterOverride != null && (onDisk == null || onDisk === afterOverride)) {
        this.fileBefore.set(abs, null);
      } else if (onDisk != null && afterOverride != null && onDisk !== afterOverride) {
        // Disk already updated; we lost before — still count using override as after
        // and empty before only if file is brand new content (heuristic: no prev row)
        this.fileBefore.set(abs, this.turnFiles.get(abs)?.before ?? null);
      } else {
        this.fileBefore.set(abs, onDisk);
      }
    }

    const before = this.fileBefore.get(abs) ?? null;
    const after =
      afterOverride !== undefined && afterOverride !== null
        ? afterOverride
        : readFileSafe(abs) ?? this.turnFiles.get(abs)?.after ?? null;

    if (before == null && after == null) return;

    const stats = countLineStats(before, after);
    const prev = this.turnFiles.get(abs);
    const action: 'create' | 'edit' | 'delete' =
      before == null && after != null ? 'create' : after == null && before != null ? 'delete' : 'edit';

    // Prefer fresh computed stats; only keep previous if new compute is empty but old had values
    // (e.g. transient read before flush)
    let additions = stats.additions;
    let deletions = stats.deletions;
    if (additions === 0 && deletions === 0 && after != null && before !== after) {
      // Fallback: non-empty change that LCS missed (rare) — count by length delta heuristic
      const bLines = before == null ? 0 : String(before).split(/\r?\n/).length;
      const aLines = String(after).split(/\r?\n/).length;
      if (before == null) {
        additions = aLines;
      } else if (aLines !== bLines) {
        additions = Math.max(0, aLines - bLines);
        deletions = Math.max(0, bLines - aLines);
      }
    }
    if (additions === 0 && deletions === 0 && prev && (prev.additions || prev.deletions)) {
      additions = prev.additions;
      deletions = prev.deletions;
    }

    const preview = buildDiffPreview(before, after, 24);
    this.turnFiles.set(abs, {
      path: prev?.path || rel,
      abs,
      additions,
      deletions,
      status: prev?.status === 'accepted' || prev?.status === 'reverted' ? prev.status : 'pending',
      before,
      after,
      preview,
      live: true,
      action,
    });
    this.pushFiles();
    this.postInk(abs, action, additions, deletions, preview);
  }

  private postInk(
    _abs: string,
    _action: 'create' | 'edit' | 'delete',
    _additions: number,
    _deletions: number,
    _preview: DiffLine[],
  ) {
    // Ink stage removed from chat UI — live reveal stays in file cards + editor.
  }

  private applyDiffs(raw: unknown) {
    const list = Array.isArray(raw) ? raw : (raw as any)?.diff;
    if (!Array.isArray(list)) return;
    for (const d of list) {
      const filePath = String(d.file || d.path || d.filename || '');
      if (!filePath) continue;
      const abs = resolveAbs(filePath);
      const prev = this.turnFiles.get(abs);
      const before =
        d.before !== undefined
          ? clipSnapshot(d.before)
          : this.fileBefore.has(abs)
            ? this.fileBefore.get(abs) ?? null
            : prev?.before ?? null;
      const after =
        d.after !== undefined ? clipSnapshot(d.after) : readFileSafe(abs) ?? prev?.after ?? null;

      if (d.before !== undefined && !this.fileBefore.has(abs)) {
        this.fileBefore.set(abs, clipSnapshot(d.before));
      }

      let add = Number(d.additions ?? d.added);
      let del = Number(d.deletions ?? d.removed);
      const hasApiCounts = Number.isFinite(add) && Number.isFinite(del) && (add > 0 || del > 0);
      if (!hasApiCounts && (d.patch || d.diff)) {
        const c = countLines(String(d.patch || d.diff));
        add = c.add;
        del = c.del;
      }
      if ((!Number.isFinite(add) || !Number.isFinite(del) || (add === 0 && del === 0)) && (before != null || after != null)) {
        const c = countLineStats(before, after);
        add = c.additions;
        del = c.deletions;
      }
      if (!Number.isFinite(add)) add = 0;
      if (!Number.isFinite(del)) del = 0;
      if (before == null && after == null && add === 0 && del === 0) continue;

      // Use API/computed counts as source of truth when non-zero
      if (add > 0 || del > 0 || before !== after) {
        this.fileBefore.set(abs, before ?? this.fileBefore.get(abs) ?? null);
        const action: 'create' | 'edit' | 'delete' =
          before == null && after != null ? 'create' : after == null && before != null ? 'delete' : 'edit';
        const preview = buildDiffPreview(before, after, 24);
        this.turnFiles.set(abs, {
          path: filePath,
          abs,
          additions: add,
          deletions: del,
          status: prev?.status === 'accepted' || prev?.status === 'reverted' ? prev.status : 'pending',
          before: before ?? prev?.before ?? null,
          after: after ?? prev?.after ?? null,
          preview,
          live: true,
          action,
        });
        this.postInk(abs, action, add, del, preview);
      }
    }
    this.pushFiles();
  }

  private pushFiles() {
    const files = [...this.turnFiles.values()]
      .filter((f) => f.after != null || f.before != null || f.additions > 0 || f.deletions > 0)
      .map((f) => ({
        path: f.abs || f.path,
        name: (f.abs || f.path).replace(/\\/g, '/').split('/').pop() || f.path,
        additions: f.additions,
        deletions: f.deletions,
        status: f.status,
        live: f.live,
        action: f.action,
        preview: (f.preview || []).slice(0, 14).map((line) => ({
          type: line.type,
          text: String((line as any).text || '').slice(0, 200),
        })),
      }));
    if (files.length) this.post({ type: 'files', files });
  }

  private clearLiveDecorations() {
    for (const ed of vscode.window.visibleTextEditors) {
      ed.setDecorations(this.addDeco, []);
      ed.setDecorations(this.delDeco, []);
    }
    this.liveDecoAbs = '';
  }

  private async revealAndDecorate(filePath: string, animate = false) {
    const abs = resolveAbs(filePath);
    if (!abs || !fs.existsSync(abs)) return;
    try {
      const uri = vscode.Uri.file(abs);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, {
        preview: true,
        preserveFocus: true,
        viewColumn: vscode.ViewColumn.Active,
      });
      const row = this.turnFiles.get(abs);
      const before = row?.before ?? this.fileBefore.get(abs) ?? null;
      const after = row?.after ?? readFileSafe(abs);
      if (before == null && after == null) return;
      const markers = computeEditorDiffMarkers(before, after);
      const addRanges = markers.addedLines
        .map((n) => {
          const line = Math.max(0, n - 1);
          if (line >= doc.lineCount) return null;
          return doc.lineAt(line).range;
        })
        .filter(Boolean) as vscode.Range[];
      const delRanges: vscode.DecorationOptions[] = markers.deletedHunks.map((h) => {
        const line = Math.max(0, Math.min(doc.lineCount - 1, h.afterLineNumber));
        const range = doc.lineAt(line).range;
        const preview = h.lines
          .slice(0, 3)
          .map((l) => l.slice(0, 80))
          .join(' · ');
        return {
          range,
          renderOptions: {
            after: {
              contentText: preview ? '  − ' + preview : '  − deleted lines',
              color: '#ff7b72',
            },
          },
        };
      });
      if (this.liveDecoAbs && this.liveDecoAbs !== abs) this.clearLiveDecorations();
      this.liveDecoAbs = abs;
      editor.setDecorations(this.delDeco, delRanges);

      if (animate && addRanges.length > 1) {
        editor.setDecorations(this.addDeco, []);
        const step = Math.max(1, Math.ceil(addRanges.length / 48));
        for (let i = 0; i < addRanges.length; i += step) {
          const slice = addRanges.slice(0, Math.min(addRanges.length, i + step));
          editor.setDecorations(this.addDeco, slice);
          editor.revealRange(slice[slice.length - 1], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
          await new Promise((r) => {
            const t = setTimeout(r, 22);
            this.inkTimers.add(t);
          });
        }
        editor.setDecorations(this.addDeco, addRanges);
      } else {
        editor.setDecorations(this.addDeco, addRanges);
        if (addRanges.length) {
          editor.revealRange(addRanges[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }
      }
    } catch {
      /* ignore */
    }
  }

  private async acceptFile(filePath: string) {
    const row = this.findFile(filePath);
    if (!row) return;
    row.status = 'accepted';
    this.pushFiles();
  }

  private async revertFile(filePath: string) {
    const row = this.findFile(filePath);
    if (!row) return;
    try {
      const uri = vscode.Uri.file(row.abs);
      const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === row.abs);
      if (row.before == null) {
        if (open) await vscode.window.showTextDocument(open, { preview: false, preserveFocus: true });
        const del = new vscode.WorkspaceEdit();
        del.deleteFile(uri, { ignoreIfNotExists: true });
        await vscode.workspace.applyEdit(del);
        if (fs.existsSync(row.abs)) fs.unlinkSync(row.abs);
      } else if (open) {
        const end = open.lineAt(open.lineCount - 1).range.end;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), end), row.before);
        await vscode.workspace.applyEdit(edit);
        await open.save();
      } else {
        fs.mkdirSync(path.dirname(row.abs), { recursive: true });
        fs.writeFileSync(row.abs, row.before, 'utf8');
      }
      row.status = 'reverted';
      this.pushFiles();
    } catch (err) {
      this.post({ type: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  }

  private async acceptAllFiles() {
    for (const row of this.turnFiles.values()) {
      if (row.status === 'pending') row.status = 'accepted';
    }
    this.pushFiles();
  }

  private async revertAllFiles() {
    for (const row of [...this.turnFiles.values()]) {
      if (row.status === 'pending') await this.revertFile(row.abs);
    }
  }

  private findFile(filePath: string): FileChangeRow | undefined {
    const abs = resolveAbs(filePath);
    return this.turnFiles.get(abs) || this.turnFiles.get(filePath) || [...this.turnFiles.values()].find((f) => f.path === filePath || f.abs === abs);
  }

  private mergeTurnUsage(raw: unknown, additive: boolean) {
    collectGenerationIds(raw, this.turnGenIds);
    const next = usageFromEngineMessage(raw) || parseUsageBlob(raw);
    if (!next) return;
    if (!this.turnUsage) {
      this.turnUsage = next;
      return;
    }
    if (additive) {
      this.turnUsage = addUsage(this.turnUsage, next);
      return;
    }
    this.turnUsage = maxUsage(this.turnUsage, next);
  }

  private async finishTurn() {
    await this.syncDiffs();
    for (const row of this.turnFiles.values()) row.live = false;
    this.pushFiles();
    await this.chargeTurn();
    await this.refreshQuotaAfterTurn();
    if (!this.canRunAgent()) {
      this.pushAuth();
      this.post({ type: 'upgrade', reason: this.upgradeReason() });
    }
  }

  private async syncDiffs() {
    if (!this.engine.sessionId) return;
    try {
      const diffs = await this.engine.request<any>('GET', '/session/' + this.engine.sessionId + '/diff');
      this.applyDiffs(diffs);
    } catch {
      /* ignore */
    }
    for (const row of this.turnFiles.values()) {
      if (row.status !== 'pending') continue;
      const after = readFileSafe(row.abs);
      const before = row.before ?? this.fileBefore.get(row.abs) ?? null;
      if (before == null && after == null) continue;
      const c = countLineStats(before, after);
      row.after = after;
      row.before = before;
      row.action = before == null && after != null ? 'create' : after == null ? 'delete' : 'edit';
      if (c.additions > 0 || c.deletions > 0 || (after != null && before !== after)) {
        row.additions = c.additions;
        row.deletions = c.deletions;
        row.preview = buildDiffPreview(before, after, 24);
      }
      if (before != null && !this.fileBefore.has(row.abs)) this.fileBefore.set(row.abs, before);
    }
    this.pushFiles();
  }

  private async chargeTurn() {
    if (this.turnCharged || this.charging || !this.session) return;
    if (isCustomModel(this.modelId) || (this.canRunCustom() && !this.canRunCloud() && !this.shouldUseFreeTrial())) {
      this.turnCharged = true;
      return;
    }
    if (this.engine.currentCreds()?.provider === 'trial') {
      this.charging = true;
      try {
        const uid = this.session.user?.uid || '';
        let tokens = 0;
        if (!this.turnFailed && uid) {
          let usage = this.turnUsage;
          if (!usage || exactTrialTokens(usage) < 1) usage = maxUsage(usage, await this.pullSessionUsage());
          tokens = exactTrialTokens(usage);
        }
        if (tokens > 0 && uid) this.freeTrial = recordFreeTrialUse(vscode.env.machineId, uid, tokens);
        this.turnCharged = true;
        this.pushAuth();
      } finally {
        this.charging = false;
      }
      return;
    }
    this.charging = true;
    try {
      const creds = this.engine.currentCreds();
      let usage = this.turnUsage;
      for (let i = 0; i < 5; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 500 * i));
        usage = maxUsage(usage, await this.pullSessionUsage());
        usage = maxUsage(usage, await fetchOpenRouterGenerationUsage(creds, this.turnGenIds));
        if (usage && (usage.costUsd > 0 || usage.total > 0)) break;
      }
      if (!usage || (usage.total < 1 && !(usage.costUsd > 0))) {
        this.turnCharged = true;
        return;
      }
      await fetchOpenRouterCatalog();
      const model = creds?.model && creds.provider !== 'openrouter' ? creds.model : resolveCloudSlug(this.modelId);
      const billedOut = usage.completion > 0 ? usage.completion : usage.reasoning;
      for (let attempt = 0; attempt < 3; attempt++) {
        const charged = await chargeUsage(this.session, {
          prompt: usage.prompt,
          completion: billedOut,
          total: usage.total || usage.prompt + billedOut,
          costUsd: usage.costUsd,
          cacheHit: usage.cacheHit,
          cacheMiss: usage.cacheMiss,
          cacheWrite: usage.cacheWrite,
          reasoning: usage.reasoning,
          model,
          provider: creds?.provider || 'openrouter',
          requestId: 'vscode-' + (this.engine.sessionId || Date.now()) + '-' + Date.now(),
        });
        if (charged) {
          this.quota = charged;
          this.turnCharged = true;
          this.pushAuth();
          return;
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      this.turnCharged = true;
    } finally {
      this.charging = false;
    }
  }

  private async pullSessionUsage(): Promise<ReturnType<typeof parseUsageBlob>> {
    const sid = this.engine.sessionId;
    if (!sid) return null;
    let found: ReturnType<typeof parseUsageBlob> = null;
    const foldTurn = (list: any[]) => {
      let lastUser = -1;
      for (let i = 0; i < list.length; i++) {
        const info = list[i]?.info || list[i];
        if (info && info.role === 'user') lastUser = i;
      }
      const start = lastUser >= 0 ? lastUser + 1 : 0;
      for (let i = start; i < list.length; i++) {
        collectGenerationIds(list[i], this.turnGenIds);
        found = addUsage(found, usageFromEngineMessage(list[i]));
      }
    };
    try {
      const messages = await this.engine.request<any>('GET', '/session/' + sid + '/message');
      const list = Array.isArray(messages) ? messages : messages?.messages || messages?.data || [];
      foldTurn(list);
      if (found) return found;
    } catch {
      /* try session */
    }
    try {
      const info = await this.engine.request<any>('GET', '/session/' + sid);
      collectGenerationIds(info, this.turnGenIds);
      const messages = info?.messages || info?.data?.messages || [];
      foldTurn(messages);
    } catch {
      /* ignore */
    }
    return found;
  }

  private async pullSessionText() {
    try {
      const info = await this.engine.request<any>('GET', '/session/' + this.engine.sessionId);
      const messages = info?.messages || info?.data?.messages || [];
      let text = '';
      for (const msg of messages) {
        if (msg.role === 'assistant' || msg.info?.role === 'assistant') {
          const parts = msg.parts || msg.info?.parts || [];
          for (const part of parts) {
            if (part.type === 'text' && part.text) text = cleanAssistantText(part.text);
          }
        }
      }
      if (text) this.post({ type: 'assistant', text, live: false });
    } catch {
      /* ignore */
    }
  }

  private async refreshQuotaAfterTurn() {
    if (!this.session) return;
    try {
      this.quota = await fetchQuota(this.session);
      this.quotaLoaded = true;
      this.refreshFreeTrial();
      this.pushAuth();
    } catch {
      /* ignore */
    }
  }

  private async onMessage(msg: {
    type?: string;
    text?: string;
    plan?: string;
    modelId?: string;
    path?: string;
    model?: string;
    baseUrl?: string;
    apiKey?: string;
    id?: string;
    workerId?: string;
    mode?: string;
    skipUserEcho?: boolean;
    hasImages?: boolean;
    raw?: string;
    session?: string;
    offer?: string;
    ice?: string;
  }) {
    switch (msg.type) {
      case 'ready':
        this.pushAuth();
        break;
      case 'signIn':
        try {
          await this.signIn();
        } catch (err) {
          this.post({ type: 'error', text: err instanceof Error ? err.message : String(err) });
        }
        break;
      case 'signOut':
        this.signOut();
        break;
      case 'send':
        await this.ask(String(msg.text || ''), {
          mode: String(msg.mode || 'agent'),
          skipUserEcho: !!msg.skipUserEcho,
          hasImages: !!msg.hasImages,
        });
        break;
      case 'listContextFiles':
        this.post({ type: 'contextFiles', files: this.listContextFiles() });
        break;
      case 'abort':
        await this.abort();
        break;
      case 'abortVo':
        await this.abortVoWorker(String(msg.workerId || ''));
        break;
      case 'newChat':
        await this.newChat();
        break;
      case 'setModel':
        this.modelId = String(msg.modelId || DEFAULT_MODEL_ID);
        void this.context?.globalState.update('olkil.modelId', this.modelId);
        this.pushAuth();
        break;
      case 'saveCustom':
        await this.saveCustomEndpoint(
          String(msg.model || ''),
          String(msg.baseUrl || ''),
          typeof msg.apiKey === 'string' ? msg.apiKey : '',
          String(msg.id || customIdFromModelId(this.modelId) || ''),
        );
        break;
      case 'deleteCustom': {
        const id = String(msg.id || customIdFromModelId(this.modelId) || '').trim();
        this.customs = this.customs.filter((c) => c.id !== id);
        void this.context?.secrets.delete('olkil.custom.apiKey.' + id);
        await this.persistCustoms();
        if (customIdFromModelId(this.modelId) === id || isAddCustomModel(this.modelId)) {
          this.modelId = this.customs[0] ? customPickerId(this.customs[0].id) : DEFAULT_MODEL_ID;
          void this.context?.globalState.update('olkil.modelId', this.modelId);
        }
        this.pushAuth();
        break;
      }
      case 'openFile': {
        const raw = String(msg.path || msg.text || '');
        if (!raw) break;
        const uri = pathLooksAbsolute(raw)
          ? vscode.Uri.file(raw)
          : vscode.Uri.joinPath(vscode.Uri.file(workspaceFolder()), raw);
        void vscode.window.showTextDocument(uri, { preview: true });
        break;
      }
      case 'acceptFile':
        await this.acceptFile(String(msg.path || ''));
        break;
      case 'revertFile':
        await this.revertFile(String(msg.path || ''));
        break;
      case 'acceptAll':
        await this.acceptAllFiles();
        break;
      case 'revertAll':
        await this.revertAllFiles();
        break;
      case 'openPlan':
        void vscode.env.openExternal(
          vscode.Uri.parse('https://olkil.com/checkout/?plan=' + encodeURIComponent(String(msg.plan || 'pro'))),
        );
        break;
      case 'toggleVirtualOffice':
        await this.virtualOffice.toggle();
        break;
      case 'togglePocket':
        await this.togglePocket();
        break;
      case 'toggleRemoteAccess':
        await this.toggleRemoteAccess();
        break;
      case 'showRemoteQr':
        await this.showRemoteQr();
        break;
      case 'screenOffer':
        this.screen.onOffer(msg);
        break;
      case 'screenInput':
        this.screen.onInput(String(msg.raw || ''));
        break;
      case 'setVoAssignee': {
        const id = String(msg.id || 'manager') as VoAssigneeId;
        const allowed = VO_ASSIGNEES.some((a) => a.id === id);
        this.virtualOffice.setAssignee(allowed ? id : 'manager');
        break;
      }
      default:
        break;
    }
  }

  async toggleVirtualOffice() {
    await this.virtualOffice.toggle();
  }

  private html(webview: vscode.Webview): string {
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'webview', 'sidebar.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'webview', 'sidebar.js'));
    const qr = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'webview', 'qrcode.js'));
    const screen = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'webview', 'screen-peer.js'));
    const icon = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png'));
    const nonce = String(Date.now());
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; connect-src https: wss: stun: turn:; media-src blob: mediastream:; worker-src blob:;" />
  <link rel="stylesheet" href="${css}" />
</head>
<body>
  <div id="app" data-icon="${icon}"></div>
  <script nonce="${nonce}" src="${qr}"></script>
  <script nonce="${nonce}" src="${js}"></script>
  <script nonce="${nonce}" src="${screen}"></script>
</body>
</html>`;
  }

  async toggleRemoteAccess() {
    if (this.keepAwake.isOn()) {
      this.screen.stop();
      this.keepAwake.stop();
      await this.context?.globalState.update('olkil.remoteAccess', false);
      await this.context?.globalState.update('olkil.remoteAccessPid', 0);
      this.post({ type: 'remoteQr', open: false });
      this.pushAuth();
      return;
    }
    const ok = await this.keepAwake.start();
    if (!ok) {
      void vscode.window.showWarningMessage('Remote Access could not keep this screen on.');
      await this.context?.globalState.update('olkil.remoteAccess', false);
    } else {
      await this.context?.globalState.update('olkil.remoteAccess', true);
      if (this.keepAwake.pid()) await this.context?.globalState.update('olkil.remoteAccessPid', this.keepAwake.pid());
      await this.showRemoteQr();
      await this.screen.start();
    }
    this.pushAuth();
  }

  async togglePocket() {
    if (!this.pocket) return;
    if (this.pocket.isOn()) {
      this.pocket.stop();
      await this.context?.globalState.update('olkil.pocketOn', false);
      void vscode.window.showInformationMessage('OLKIL Pocket is off.');
      return;
    }
    if (!this.session) {
      await this.signIn();
      if (!this.session) return;
    }
    await this.armPocket();
    if (this.pocket.isOn()) await this.context?.globalState.update('olkil.pocketOn', true);
  }

  dispose() {
    this.screen.stop();
    this.keepAwake.stop();
    this.pocket?.dispose();
    this.clearLiveDecorations();
    this.addDeco.dispose();
    this.delDeco.dispose();
    this.virtualOffice.dispose();
    this.engine.dispose();
  }
}
