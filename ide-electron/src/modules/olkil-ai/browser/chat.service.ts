import { Autowired, Injectable } from '@opensumi/di';
import { Emitter, Event, URI, Disposable } from '@opensumi/ide-core-common';
import { AppConfig } from '@opensumi/ide-core-browser';
import { WorkbenchEditorService } from '@opensumi/ide-editor';
import { IEditorDocumentModelService } from '@opensumi/ide-editor/lib/browser';
import { IFileServiceClient } from '@opensumi/ide-file-service/lib/common';
import { IWorkspaceService } from '@opensumi/ide-workspace/lib/common';
import { IFileTreeService } from '@opensumi/ide-file-tree-next/lib/common';
import * as path from 'path';
import {
  ActivityInfo,
  ActivityKind,
  AgentTodoItem,
  ChatAttachment,
  ChatMessage,
  ChatToolCall,
  FileChangeInfo,
  FileChangeKind,
  IOlkilAiNodeService,
  IOlkilChatService,
  LiveTestResult,
  OlkilAiNodeServicePath,
  OllamaDownloadUiState,
  QueuedChatMessage,
  UiChatMessage,
} from '../common';
import { AI_MODELS, DEFAULT_MODEL_ID, findModel, publicModelName } from '../common/models';
import {
  buildSystemPrompt,
  AGENT_TOOLS,
  DEFAULT_CHAT_MODE,
  ChatMode,
  selectAgentTools,
  READONLY_TOOL_NAMES,
  MUTATING_TOOL_NAMES,
  routingMaxTokens,
} from '../common/tools';
import {
  chatModeToUserMode,
  createModeSwitchNoticeTracker,
  formatModeSwitchNotice,
  formatUserInputBlock,
} from '../common/cline-prompt';
import { loadProjectRules } from '../common/rules';
import { buildDiffHunks, applyAcceptedHunks } from '../common/hunks';
import { buildChangeSummary, buildDiffPreview, countLineStats } from '../common/diff';
import { IOlkilVirtualOfficeService } from '../common/virtual-office';
import { OlkilDiffDecorationManager } from './diff-decorations';
import {
  findContentArtifact,
  fuzzyLocate,
  newlyIntroducedIssues,
  reindentReplacement,
  stripLineNumberArtifacts,
  stripMarkdownFence,
  syntaxIssues,
  destructiveEditIssue,
} from './edit-guard';
import * as fs from 'fs';
import { MarkerSeverity } from '@opensumi/ide-core-common';
import { IMarkerService } from '@opensumi/ide-markers';
import { SCMService } from '@opensumi/ide-scm';
import { IOlkilAuthService } from '../../olkil-auth/common';
import { OlkilChatHistoryService } from './chat-history.service';
import {
  CHAT_HISTORY_TTL_MS,
  sessionHasUserContent,
  slimMessages,
  titleFromMessages,
} from '../common/chat-history';
import type { ChatHistorySummary } from '../common/chat-history';

let msgSeq = 0;
const nextId = () => `m_${Date.now()}_${++msgSeq}`;
const nextChangeId = () => `c_${Date.now()}_${++msgSeq}`;
const nextSessionId = () => `chat_${Date.now()}_${++msgSeq}`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function olkilStatusLabel(raw: string): string {
  return (raw || '')
    .replace(/\bCline\b/gi, 'OLKIL')
    .replace(/\bcline\b/g, 'OLKIL')
    .replace(/\bOLKIL agent starting…?/gi, 'Thinking')
    .replace(/\bAgent thinking…?/gi, 'Thinking')
    .replace(/\bWorking…?/gi, 'Thinking')
    .replace(/…+$/g, '')
    .trim();
}

interface ChangeSnapshot {
  changeId: string;
  kind: FileChangeKind;
  path: string;
  newPath?: string;
  /** Original content before ANY edits in this card (for full revert) */
  beforeContent: string | null;
  afterContent: string | null;
}

function normPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

const MAX_READ_CHARS = 24000;
const MAX_PREVIEW_LINES = 200;
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'app',
  '.next',
  'coverage',
  '.cache',
  'build',
  '.olkil',
  '.sumi',
  '.sumi-oss',
]);

@Injectable()
export class OlkilChatService extends Disposable implements IOlkilChatService {
  @Autowired(OlkilAiNodeServicePath)
  private aiNode!: IOlkilAiNodeService;

  @Autowired(AppConfig)
  private appConfig!: AppConfig;

  @Autowired(WorkbenchEditorService)
  private editorService!: WorkbenchEditorService;

  @Autowired(IEditorDocumentModelService)
  private docService!: IEditorDocumentModelService;

  @Autowired(IFileServiceClient)
  private fileService!: IFileServiceClient;

  @Autowired(IWorkspaceService)
  private workspaceService!: IWorkspaceService;

  @Autowired(IFileTreeService)
  private fileTreeService!: IFileTreeService;

  @Autowired(IMarkerService)
  private markerService!: IMarkerService;

  @Autowired(SCMService)
  private scmService!: SCMService;

  @Autowired(IOlkilAuthService)
  private auth!: IOlkilAuthService;

  @Autowired(OlkilChatHistoryService)
  private chatHistoryStore!: OlkilChatHistoryService;

  @Autowired(IOlkilVirtualOfficeService)
  private virtualOffice!: IOlkilVirtualOfficeService;

  private readonly _onDidChange = new Emitter<void>();
  readonly onDidChange: Event<void> = this._onDidChange.event;

  messages: UiChatMessage[] = [
    {
      id: nextId(),
      role: 'system',
      content: 'OLKIL Agent ready — autonomous edits by default. Switch to Plan for discuss-first.',
    },
  ];

  status = '';
  busy = false;
  modelId = DEFAULT_MODEL_ID;
  modelName = findModel(DEFAULT_MODEL_ID).model;
  chatMode: ChatMode = DEFAULT_CHAT_MODE;
  /** Active Live Test session — UI shows pink Testing badge; browser boot runs immediately. */
  liveTesting = false;
  private liveTestBootPromise: Promise<LiveTestResult | null> | null = null;
  private liveTestBootResult: LiveTestResult | null = null;
  /** Virtual Office Jasmine desk task while Live Test uses the Dev Studio browser loop. */
  private voLiveQaTaskId: string | null = null;
  chatHistory: ChatHistorySummary[] = [];
  private sessionId = nextSessionId();
  private sessionCreatedAt = Date.now();
  private modeSwitchTracker = createModeSwitchNoticeTracker();
  private historyUnsub?: { dispose: () => void };
  private authUnsub?: { dispose: () => void };
  models: Array<{
    id: string;
    provider: string;
    model: string;
    label: string;
    displayName?: string;
    badge?: string;
    approxSizeGb?: number;
  }> = AI_MODELS.map((m) => ({
    id: m.id,
    provider: m.provider,
    model: m.model,
    label: m.label,
    displayName: m.displayName,
    badge: m.badge,
    approxSizeGb: m.approxSizeGb,
  }));
  ollamaDownload: OllamaDownloadUiState = {
    phase: 'idle',
    percent: 0,
    message: '',
  };
  private ollamaPollRunning = false;

  queuedMessages: QueuedChatMessage[] = [];
  agentTodos: AgentTodoItem[] = [];
  checkpoints: Array<{ id: string; label: string; createdAt: number }> = [];
  private checkpointSnapshots = new Map<
    string,
    { messages: UiChatMessage[]; history: ChatMessage[]; files: Map<string, string | null> }
  >();

  private history: ChatMessage[] = [];
  private cancelRequested = false;
  /** Active Cline engine run id (for Stop). */
  private activeClineRunId: string | null = null;
  /** Silent auto-resume after provider stall (max 1 per user turn). */
  private stallAutoRetries = 0;
  /** Files the agent has actually read — edits to unread files are blocked. */
  private filesReadThisSession = new Set<string>();
  /** Snapshots needed to revert agent edits */
  private snapshots = new Map<string, ChangeSnapshot>();
  private diffDecorations?: OlkilDiffDecorationManager;
  private flushQueueScheduled = false;
  private rulesCache: { root: string; text: string; at: number } | null = null;

  private get decorations(): OlkilDiffDecorationManager {
    if (!this.diffDecorations) {
      this.diffDecorations = new OlkilDiffDecorationManager(this.editorService, this.docService);
    }
    return this.diffDecorations;
  }

  get pendingChanges(): FileChangeInfo[] {
    return this.messages
      .filter((m) => m.role === 'file_change' && m.fileChange?.status === 'pending')
      .map((m) => m.fileChange!);
  }

  async init() {
    try {
      // Warm the persisted repository map in the node process while the user
      // reads the welcome screen. The first real request can then retrieve
      // context immediately even for a large workspace.
      void this.aiNode.ensureRepositoryIndex(this.workspaceRoot()).catch(() => undefined);
      this.models = await this.aiNode.listModels();
      this.modelName = await this.aiNode.getModelName(this.modelId);
      const option = findModel(this.modelId);
      if (option.provider === 'ollama') {
        await this.refreshOllamaStatus();
      } else {
        this.ollamaDownload = { phase: 'idle', percent: 0, message: '' };
        const ok = await this.aiNode.hasApiKey(option.provider);
        if (!ok) {
          this.pushUi(
            'status',
            `Missing API key for ${option.provider}. Add it to .env`,
          );
        }
      }
      this.fire();
      this.wireChatHistory();
    } catch (e: any) {
      this.pushUi('status', `AI backend init error: ${e?.message || e}`);
    }
  }

  private wireChatHistory() {
    if (!this.historyUnsub) {
      this.historyUnsub = this.chatHistoryStore.onDidChange(() => {
        this.chatHistory = this.chatHistoryStore.listSummaries();
        this.fire();
      });
      this.addDispose({ dispose: () => this.historyUnsub?.dispose() });
    }
    if (!this.authUnsub) {
      this.authUnsub = this.auth.onDidChangeSession(() => {
        void this.refreshChatHistory();
      });
      this.addDispose({ dispose: () => this.authUnsub?.dispose() });
    }
    void this.refreshChatHistory();
  }

  private async refreshChatHistory() {
    if (!this.auth.isSignedIn()) {
      this.chatHistoryStore.resetLocal();
      this.chatHistory = [];
      this.fire();
      return;
    }
    try {
      this.chatHistory = await this.chatHistoryStore.bootstrap();
      this.fire();
    } catch {
      // optional feature
    }
  }

  private persistCurrentSession() {
    if (!this.auth.isSignedIn() || !sessionHasUserContent(this.messages)) {
      return;
    }
    const now = Date.now();
    this.chatHistoryStore.scheduleUpsert({
      id: this.sessionId,
      title: titleFromMessages(this.messages),
      createdAt: this.sessionCreatedAt,
      updatedAt: now,
      expiresAt: now + CHAT_HISTORY_TTL_MS,
      messages: slimMessages(this.messages),
    });
    this.chatHistory = this.chatHistoryStore.listSummaries();
  }

  private resetLocalSession(welcome = 'Chat cleared. OLKIL ready.') {
    void this.decorations.clearAll();
    this.history = [];
    this.snapshots.clear();
    this.queuedMessages = [];
    this.agentTodos = [];
    this.checkpoints = [];
    this.checkpointSnapshots.clear();
    this.filesReadThisSession.clear();
    this.sessionId = nextSessionId();
    this.sessionCreatedAt = Date.now();
    this.messages = [
      {
        id: nextId(),
        role: 'system',
        content: welcome,
      },
    ];
    this.status = '';
  }

  clear() {
    this.newChat();
  }

  newChat() {
    this.persistCurrentSession();
    this.resetLocalSession('New chat. OLKIL ready.');
    this.fire();
  }

  async loadChatHistory(id: string) {
    if (this.busy) {
      return;
    }
    this.persistCurrentSession();
    let session = this.chatHistoryStore.getSession(id);
    if (!session) {
      await this.refreshChatHistory();
      session = this.chatHistoryStore.getSession(id);
    }
    if (!session) {
      this.pushUi('status', 'That chat expired or was removed (max 3 chats, 48h).');
      return;
    }
    this.resetLocalSession('Restored chat from history.');
    this.sessionId = session.id;
    this.sessionCreatedAt = session.createdAt;
    this.messages = [
      {
        id: nextId(),
        role: 'system',
        content: 'Restored chat from your OLKIL history (expires 48h / max 3).',
      },
      ...session.messages.map((m) => ({
        id: m.id || nextId(),
        role: m.role,
        content: m.content,
      })),
    ];
    // Rebuild a minimal LLM history so follow-ups have context
    this.history = session.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    this.fire();
  }

  /**
   * Check whether the selected Ollama model is already on disk.
   * Does NOT start a download — user must click Download.
   */
  private async refreshOllamaStatus() {
    const option = findModel(this.modelId);
    if (option.provider !== 'ollama') {
      this.ollamaDownload = { phase: 'idle', percent: 0, message: '' };
      this.fire();
      return;
    }

    // Keep live progress if a download for this model is already running.
    if (
      this.ollamaPollRunning &&
      this.ollamaDownload.modelId === option.id &&
      (this.ollamaDownload.phase === 'downloading' || this.ollamaDownload.phase === 'starting')
    ) {
      return;
    }

    try {
      const st = await this.aiNode.getLocalModelStatus(option.id);
      if (st.installed) {
        this.ollamaDownload = {
          phase: 'ready',
          modelId: option.id,
          model: option.model,
          label: option.label,
          percent: 100,
          approxSizeGb: option.approxSizeGb,
          message: `${option.model} is ready on your machine.`,
        };
      } else {
        const size =
          typeof option.approxSizeGb === 'number' ? ` (~${option.approxSizeGb} GB)` : '';
        this.ollamaDownload = {
          phase: 'needs_download',
          modelId: option.id,
          model: option.model,
          label: option.label,
          percent: 0,
          approxSizeGb: option.approxSizeGb,
          message: `Download Ollama model "${option.model}"${size} to use it locally.`,
        };
      }
    } catch (e: any) {
      this.ollamaDownload = {
        phase: 'needs_download',
        modelId: option.id,
        model: option.model,
        label: option.label,
        percent: 0,
        approxSizeGb: option.approxSizeGb,
        message: `Download Ollama model "${option.model}" to use it locally.`,
        error: e?.message || String(e),
      };
    }
    this.fire();
  }

  /** User-triggered: start Ollama + pull selected model with live % / GB progress. */
  async startOllamaDownload() {
    const option = findModel(this.modelId);
    if (option.provider !== 'ollama') {
      return;
    }
    if (this.ollamaPollRunning) {
      return;
    }
    if (this.busy) {
      return;
    }

    const resumePercent =
      this.ollamaDownload.phase === 'paused' ? this.ollamaDownload.percent : 0;

    this.ollamaPollRunning = true;
    this.ollamaDownload = {
      phase: resumePercent > 0 ? 'downloading' : 'starting',
      modelId: option.id,
      model: option.model,
      label: option.label,
      percent: resumePercent,
      totalBytes: this.ollamaDownload.totalBytes,
      completedBytes: this.ollamaDownload.completedBytes,
      approxSizeGb: option.approxSizeGb,
      message: resumePercent > 0 ? `Resuming download… ${resumePercent}%` : 'Starting Ollama…',
    };
    this.fire();

    try {
      await this.aiNode.ensureLocalModel(option.id);
    } catch {
      // Polling surfaces errors from getSetupState().
    }

    for (;;) {
      let s;
      try {
        s = await this.aiNode.getSetupState();
      } catch {
        s = { phase: 'error' as const, error: 'setup unavailable' };
      }

      if (s.phase === 'starting' || s.phase === 'checking' || s.phase === 'locating') {
        this.ollamaDownload = {
          ...this.ollamaDownload,
          phase: 'starting',
          percent: this.ollamaDownload.percent || 0,
          message: s.message || 'Starting Ollama…',
        };
      } else if (s.phase === 'pulling') {
        const percent = typeof s.percent === 'number' ? s.percent : this.ollamaDownload.percent;
        this.ollamaDownload = {
          phase: 'downloading',
          modelId: option.id,
          model: option.model,
          label: option.label,
          percent,
          totalBytes: s.totalBytes,
          completedBytes: s.completedBytes,
          approxSizeGb: option.approxSizeGb,
          message: s.message || `Downloading Ollama model ${option.model}… ${percent}%`,
        };
      } else if (s.phase === 'paused') {
        this.ollamaDownload = {
          phase: 'paused',
          modelId: option.id,
          model: option.model,
          label: option.label,
          percent: typeof s.percent === 'number' ? s.percent : this.ollamaDownload.percent,
          totalBytes: s.totalBytes ?? this.ollamaDownload.totalBytes,
          completedBytes: s.completedBytes ?? this.ollamaDownload.completedBytes,
          approxSizeGb: option.approxSizeGb,
          message: s.message || 'Download paused.',
        };
        this.fire();
        break;
      } else if (s.phase === 'cancelled' || s.phase === 'idle') {
        this.ollamaDownload = {
          phase: 'needs_download',
          modelId: option.id,
          model: option.model,
          label: option.label,
          percent: 0,
          approxSizeGb: option.approxSizeGb,
          message: s.message || `Download Ollama model "${option.model}" to use it locally.`,
        };
        this.fire();
        break;
      } else if (s.phase === 'ready') {
        this.ollamaDownload = {
          phase: 'ready',
          modelId: option.id,
          model: option.model,
          label: option.label,
          percent: 100,
          approxSizeGb: option.approxSizeGb,
          message: s.message || `${option.model} ready — you can chat locally now.`,
        };
        this.pushUi('status', `Ollama model ready: ${option.model}`);
        this.fire();
        break;
      } else if (s.phase === 'error') {
        this.ollamaDownload = {
          phase: 'error',
          modelId: option.id,
          model: option.model,
          label: option.label,
          percent: this.ollamaDownload.percent,
          approxSizeGb: option.approxSizeGb,
          message: s.error || 'Download failed',
          error: s.error || 'Download failed',
        };
        this.fire();
        break;
      }
      this.fire();
      await sleep(500);
    }

    this.ollamaPollRunning = false;
    this.fire();
  }

  async pauseOllamaDownload() {
    try {
      await this.aiNode.pauseLocalModelDownload();
    } catch {
      // ignore
    }
  }

  async cancelOllamaDownload() {
    try {
      await this.aiNode.cancelLocalModelDownload();
    } catch {
      // ignore
    }
    const option = findModel(this.modelId);
    this.ollamaDownload = {
      phase: 'needs_download',
      modelId: option.id,
      model: option.model,
      label: option.label,
      percent: 0,
      approxSizeGb: option.approxSizeGb,
      message: `Download cancelled. Click Download to start again.`,
    };
    this.ollamaPollRunning = false;
    this.fire();
  }

  setModel(modelId: string) {
    if (this.busy) {
      return;
    }
    if (
      this.ollamaPollRunning &&
      (this.ollamaDownload.phase === 'downloading' || this.ollamaDownload.phase === 'starting')
    ) {
      this.pushUi('status', 'Wait for the current Ollama download to finish before switching models.');
      return;
    }
    this.modelId = modelId;
    const option = findModel(modelId);
    this.modelName = option.model;
    this.pushUi('status', `Model switched to ${option.label}`);
    this.fire();
    if (option.provider === 'ollama') {
      void this.refreshOllamaStatus();
    } else {
      this.ollamaDownload = { phase: 'idle', percent: 0, message: '' };
      this.fire();
    }
  }

  setChatMode(mode: ChatMode) {
    if (this.busy) {
      return;
    }
    if (mode !== 'agent' && mode !== 'plan' && mode !== 'ask') {
      return;
    }
    const from = chatModeToUserMode(this.chatMode);
    const to = chatModeToUserMode(mode);
    if (from !== to) {
      this.modeSwitchTracker.record(from, to);
    }
    this.chatMode = mode;
    this.pushUi(
      'status',
      mode === 'agent'
        ? 'Agent mode — explore & implement on its own.'
        : mode === 'ask'
          ? 'Ask mode — read-only answers (no file edits).'
          : 'Plan mode — explore & plan only; switch to Agent to implement.',
    );
    this.fire();
  }

  /** Live browser verify — UI shows the user's goal; agent gets the full test loop. */
  async startLiveTest(goal?: string) {
    if (this.busy) {
      return;
    }
    this.chatMode = 'agent';
    this.liveTesting = true;
    this.liveTestBootResult = null;
    const focus = (goal || '').trim() || 'Test the application';

    if (this.virtualOffice?.active) {
      try {
        this.voLiveQaTaskId = this.virtualOffice.beginLiveQa(focus);
      } catch {
        this.voLiveQaTaskId = null;
      }
    }

    // Open Test Browser immediately — do not wait for the LLM.
    this.liveTestBootPromise = this.bootstrapLiveBrowser(focus);
    this.fire();

    const agentPrompt = `LIVE TEST MODE — Verify this project in a real browser (headed Chromium on my screen).

User test goal:
${focus}

IMPORTANT: Chromium is already launching on the user's screen right now. Do NOT stall on planning.

Required loop:
1. If bootstrap notes say the browser is ready, call browser_snapshot immediately. Otherwise call live_test (start_app true, headed true) once with goal set to the user test goal above.
2. Exercise the goal via browser_click / browser_fill using role+name. Move fast — prefer actions over long explanations.
3. File uploads: click Upload OR call browser_upload — OS dialogs are auto-handled (latest matching file from Downloads/Desktop: image→newest image, pdf→newest pdf). Never wait on a file picker.
4. Call browser_console + browser_network. Use browser_screenshot only when needed (not every click). Treat pageerror / 4xx–5xx as bugs.
5. Only if you need the visible inspector: browser_devtools panel=console|network (right dock). Close it when done.
6. If broken: investigate_codepath / read_file → search_replace fix → browser_reload → retest the SAME goal.
7. Max 5 fix rounds. End with PASS/FAIL, evidence (console/network), and files changed.
8. Do not claim success without a successful retest in this turn. Start now.`;
    await this.send(focus, [], { historyText: agentPrompt, liveTest: true });
    if (this.voLiveQaTaskId && !this.busy) {
      this.finishVoLiveQa(this.cancelRequested ? 'cancelled' : 'completed');
    }
  }

  /** Start / reuse the live app and open headed Chromium as fast as possible. */
  private async bootstrapLiveBrowser(goal: string): Promise<LiveTestResult | null> {
    try {
      this.setStatus('Opening Test Browser…');
      const result = await this.aiNode.liveTest({
        workspaceRoot: this.workspaceRoot(),
        goal,
        startApp: true,
        headed: true,
      });
      this.liveTestBootResult = result;
      if (result.ok) {
        this.setStatus(this.liveTesting ? 'Testing' : '');
      } else {
        this.setStatus(result.error || 'Browser launch issue');
      }
      return result;
    } catch (e: any) {
      const err = e?.message || String(e);
      this.liveTestBootResult = null;
      this.setStatus(`Browser failed: ${err}`);
      return null;
    }
  }

  private finishVoLiveQa(status: 'completed' | 'failed' | 'cancelled', summary?: string) {
    const id = this.voLiveQaTaskId;
    if (!id || !this.virtualOffice) {
      this.voLiveQaTaskId = null;
      return;
    }
    this.voLiveQaTaskId = null;
    try {
      this.virtualOffice.endLiveQa(id, { status, summary });
    } catch {
      // ignore
    }
  }

  stop() {
    this.cancelRequested = true;
    const runId = this.activeClineRunId;
    if (runId) {
      void this.aiNode.clineCancel(runId).catch(() => undefined);
    }
    this.liveTesting = false;
    this.liveTestBootPromise = null;
    this.liveTestBootResult = null;
    this.finishVoLiveQa('cancelled');
    this.status = 'Stopped';
    this.busy = false;
    this.fire();
    void this.aiNode.browserClose().catch(() => undefined);
    this.scheduleFlushQueue();
  }

  cancelQueued(id: string) {
    this.queuedMessages = this.queuedMessages.filter((q) => q.id !== id);
    this.fire();
  }

  async regenerate() {
    if (this.busy) {
      return;
    }
    let lastUserIdx = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) {
      return;
    }
    const userMsg = this.messages[lastUserIdx];
    const text = (userMsg.content || '').replace(/(?:\n|^)@[^\s]+/g, '').trim() || userMsg.content;
    const atts = userMsg.attachments || [];
    // Drop the user bubble + everything after; send() will re-add the user turn
    this.messages = this.messages.slice(0, lastUserIdx);
    const histUserIdx = [...this.history]
      .map((m, i) => ({ m, i }))
      .reverse()
      .find((x) => x.m.role === 'user')?.i;
    if (histUserIdx != null) {
      this.history = this.history.slice(0, histUserIdx);
    } else {
      this.history = [];
    }
    this.fire();
    await this.send(text.trim() || '(retry)', atts);
  }

  async openPath(filePath: string, line?: number) {
    try {
      const abs = this.resolvePath(filePath);
      if (!fs.existsSync(abs)) {
        return;
      }
      const uri = URI.file(abs);
      await this.editorService.open(uri, {
        preview: false,
        ...(line && line > 0
          ? { range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 } }
          : {}),
      } as any);
    } catch {
      // ignore
    }
  }

  async editAndResend(messageId: string, text: string) {
    if (this.busy) {
      return;
    }
    const idx = this.messages.findIndex((m) => m.id === messageId && m.role === 'user');
    if (idx < 0) {
      return;
    }
    const atts = this.messages[idx].attachments || [];
    this.messages = this.messages.slice(0, idx);
    // Trim history to before that user turn (best-effort by count of user msgs)
    let userCount = 0;
    for (let i = 0; i < idx; i++) {
      if (this.messages[i]?.role === 'user') {
        userCount++;
      }
    }
    // recount from original was wrong — recount from remaining
    userCount = this.messages.filter((m) => m.role === 'user').length;
    let seen = 0;
    let histCut = 0;
    for (let i = 0; i < this.history.length; i++) {
      if (this.history[i].role === 'user') {
        seen++;
        if (seen > userCount) {
          histCut = i;
          break;
        }
      }
      histCut = i + 1;
    }
    this.history = this.history.slice(0, histCut);
    this.fire();
    await this.send(text.trim(), atts);
  }

  createCheckpoint(label?: string): string {
    const id = nextId();
    const files = new Map<string, string | null>();
    for (const [, snap] of this.snapshots) {
      files.set(snap.path, snap.afterContent);
      if (snap.newPath) {
        files.set(snap.newPath, snap.afterContent);
      }
    }
    this.checkpointSnapshots.set(id, {
      messages: this.messages.map((m) => ({ ...m, fileChange: m.fileChange ? { ...m.fileChange } : undefined })),
      history: this.history.map((h) => ({ ...h })),
      files,
    });
    this.checkpoints = [
      ...this.checkpoints,
      { id, label: label || `Checkpoint ${this.checkpoints.length + 1}`, createdAt: Date.now() },
    ].slice(-12);
    this.fire();
    return id;
  }

  async restoreCheckpoint(checkpointId: string) {
    if (this.busy) {
      return;
    }
    const pack = this.checkpointSnapshots.get(checkpointId);
    if (!pack) {
      return;
    }
    // Restore file contents from checkpoint "after" state... actually rewind TO checkpoint means
    // restore messages/history; for files we restore afterContent that was current then.
    for (const [p, content] of pack.files) {
      try {
        if (content == null) {
          continue;
        }
        await this.writeFullContent(p, content);
      } catch {
        // ignore
      }
    }
    this.messages = pack.messages.map((m) => ({ ...m }));
    this.history = pack.history.map((h) => ({ ...h }));
    this.pushUi('status', 'Restored checkpoint.');
    this.fire();
  }

  async inlineEdit(instruction: string) {
    const sel = this.toolGetSelection();
    if (!sel || sel.startsWith('{') && sel.includes('"ok": false')) {
      this.pushUi('status', 'Select code in the editor, then press Ctrl+K.');
      return;
    }
    let parsed: any;
    try {
      parsed = JSON.parse(sel);
    } catch {
      this.pushUi('status', 'Could not read selection.');
      return;
    }
    if (!parsed?.ok) {
      this.pushUi('status', parsed?.message || 'No selection.');
      return;
    }
    const prompt =
      `INLINE EDIT (Cmd+K)\n` +
      `File: ${parsed.path}\nLines ${parsed.startLine}-${parsed.endLine}\n` +
      `Instruction: ${instruction.trim()}\n\n` +
      `Selected code:\n\`\`\`\n${parsed.text}\n\`\`\`\n\n` +
      `Use search_replace to apply the instruction to ONLY this selection. Keep surrounding code intact.`;
    this.chatMode = 'agent';
    await this.send(prompt);
  }

  async acceptHunk(changeId: string, hunkId: string) {
    await this.setHunkStatus(changeId, hunkId, 'accepted');
  }

  async rejectHunk(changeId: string, hunkId: string) {
    await this.setHunkStatus(changeId, hunkId, 'rejected');
  }

  private async setHunkStatus(
    changeId: string,
    hunkId: string,
    status: 'accepted' | 'rejected',
  ) {
    const msg = this.messages.find((m) => m.fileChange?.id === changeId);
    const change = msg?.fileChange;
    const snap = this.snapshots.get(changeId);
    if (!change?.hunks || !snap || change.status !== 'pending') {
      return;
    }
    const hunks = change.hunks.map((h) => (h.id === hunkId ? { ...h, status } : h));
    const pendingLeft = hunks.some((h) => h.status === 'pending');
    const allRejected = hunks.every((h) => h.status === 'rejected');
    const allAccepted = hunks.every((h) => h.status === 'accepted');

    if (allRejected) {
      await this.revertChange(changeId);
      return;
    }

    const before = snap.beforeContent ?? '';
    const after = snap.afterContent ?? '';
    const built = buildDiffHunks(before, after).map((h, i) => ({
      ...h,
      status: hunks[i]?.status || 'pending',
    }));
    const merged = applyAcceptedHunks(
      before,
      after,
      built.map((h) => ({
        ...h,
        status: h.status === 'accepted' ? 'accepted' : 'rejected',
      })),
    );

    // If still pending hunks, write merged of accepted-only + before for rest
    if (pendingLeft && !allAccepted) {
      const partial = applyAcceptedHunks(
        before,
        after,
        built.map((h) => ({
          ...h,
          status: h.status === 'accepted' ? 'accepted' : 'rejected',
        })),
      );
      await this.writeFullContent(snap.path, partial);
      msg!.fileChange = {
        ...change,
        hunks,
      };
      // keep pending
      this.snapshots.set(changeId, { ...snap, afterContent: partial });
      await this.decorations.apply(changeId, snap.path, before, partial);
      this.fire();
      return;
    }

    await this.writeFullContent(snap.path, allAccepted ? after : merged);
    msg!.fileChange = { ...change, hunks, status: 'accepted' };
    this.snapshots.delete(changeId);
    await this.decorations.clear(changeId);
    this.fire();
  }

  async acceptChange(changeId: string) {
    const msg = this.messages.find((m) => m.fileChange?.id === changeId);
    if (!msg?.fileChange || msg.fileChange.status !== 'pending') {
      return;
    }
    await this.decorations.clear(changeId);
    msg.fileChange = { ...msg.fileChange, status: 'accepted' };
    this.snapshots.delete(changeId);
    this.fire();
  }

  async revertChange(changeId: string) {
    const msg = this.messages.find((m) => m.fileChange?.id === changeId);
    const snap = this.snapshots.get(changeId);
    if (!msg?.fileChange || msg.fileChange.status !== 'pending' || !snap) {
      return;
    }

    try {
      await this.decorations.clear(changeId);
      if (snap.kind === 'create') {
        const uri = URI.file(snap.path);
        if (await this.fileService.access(uri.toString())) {
          await this.fileService.delete(uri.toString());
        }
      } else if (snap.kind === 'delete') {
        // Restore deleted file from snapshot content
        if (snap.beforeContent != null) {
          const uri = URI.file(snap.path);
          await this.fileService.createFile(uri.toString(), { content: snap.beforeContent });
          await this.editorService.open(uri);
        }
      } else if (snap.kind === 'rename' && snap.newPath) {
        const fromUri = URI.file(snap.newPath);
        const toUri = URI.file(snap.path);
        if (await this.fileService.access(fromUri.toString())) {
          await this.fileService.move(fromUri.toString(), toUri.toString(), { overwrite: true });
          await this.editorService.open(toUri);
        }
      } else if (snap.beforeContent != null) {
        await this.writeFullContent(snap.path, snap.beforeContent);
        await this.editorService.open(URI.file(snap.path));
      }
      msg.fileChange = { ...msg.fileChange, status: 'reverted' };
      await this.refreshRepositoryIndex([snap.path, ...(snap.newPath ? [snap.newPath] : [])]);
      this.snapshots.delete(changeId);
      this.fire();
    } catch (e: any) {
      this.pushUi('status', `Revert failed: ${e?.message || e}`);
    }
  }

  async acceptAllPending() {
    const ids = this.pendingChanges.map((c) => c.id);
    for (const id of ids) {
      await this.acceptChange(id);
    }
  }

  async revertAllPending() {
    const ids = this.pendingChanges.map((c) => c.id);
    for (const id of ids) {
      await this.revertChange(id);
    }
  }

  async openChangeFile(changeId: string) {
    const msg = this.messages.find((m) => m.fileChange?.id === changeId);
    const change = msg?.fileChange;
    if (!change) {
      return;
    }
    const target = change.kind === 'rename' && change.newPath ? change.newPath : change.path;
    if (change.kind === 'delete') {
      // File may be gone — open parent folder isn't available; just skip open
      this.pushUi('status', `Deleted (pending): ${change.displayName}`);
      return;
    }
    await this.editorService.open(URI.file(target));
    if (change.status === 'pending') {
      // Re-paint red deleted zones after navigation
      this.decorations.refreshForOpenFile();
      this.decorations.applyViewZones(changeId);
    }
  }

  async send(
    userText: string,
    attachments: ChatAttachment[] = [],
    opts?: { historyText?: string; liveTest?: boolean },
  ) {
    const text = userText.trim();
    if (!text && !attachments.length) {
      return;
    }

    const isLiveTestRun =
      Boolean(opts?.liveTest) ||
      this.liveTesting ||
      /LIVE TEST MODE/i.test(opts?.historyText || '');

    // Virtual Office mode: parallel assign — does not touch single-agent busy flag.
    // Live Test is the exception: Jasmine (QA) animates on the floor, but the
    // actual run uses the same Dev Studio browser loop (not Cline).
    if (this.virtualOffice?.active && !isLiveTestRun) {
      await this.sendVirtualOfficeAssignment(text, attachments, opts);
      return;
    }

    // Cursor-style: queue follow-ups while the agent is busy
    if (this.busy) {
      this.queuedMessages.push({
        id: nextId(),
        text: text || '(attachments)',
        attachments: [...attachments],
      });
      this.fire();
      return;
    }

    const option = findModel(this.modelId);
    if (option.provider === 'ollama') {
      const phase = this.ollamaDownload.phase;
      if (phase === 'needs_download' || phase === 'error') {
        this.pushUi(
          'status',
          `Download the Ollama model first — click “Download Ollama model” above.`,
        );
        return;
      }
      if (phase === 'downloading' || phase === 'starting') {
        this.pushUi('status', `Ollama model is still downloading (${this.ollamaDownload.percent}%). Wait until 100%.`);
        return;
      }
      if (phase !== 'ready') {
        await this.refreshOllamaStatus();
        if (this.ollamaDownload.phase !== 'ready') {
          this.pushUi(
            'status',
            `Download the Ollama model first — click “Download Ollama model” above.`,
          );
          return;
        }
      }
    }

    this.cancelRequested = false;
    this.stallAutoRetries = 0;
    this.busy = true;
    if (isLiveTestRun) {
      this.liveTesting = true;
      this.chatMode = 'agent';
    }

    const display =
      attachments.length > 0
        ? `${text}${text ? '\n' : ''}${attachments.map((a) => `@${a.name}`).join(' ')}`
        : text;
    this.messages.push({
      id: nextId(),
      role: 'user',
      content: display || '(attachments)',
      attachments: attachments.length ? [...attachments] : undefined,
      liveTest: isLiveTestRun || undefined,
    });
    if (this.messages.length > 160) {
      this.messages = this.messages.slice(-160);
    }
    this.fire();

    const forAgent = (opts?.historyText || text).trim() || text;
    const enriched = await this.buildUserContentWithAttachments(forAgent, attachments);
    const userMode = chatModeToUserMode(this.chatMode);
    const modeNotice = this.modeSwitchTracker.consume();
    const wrapped =
      (modeNotice
        ? `${formatModeSwitchNotice(modeNotice.from, modeNotice.to)}\n`
        : '') + formatUserInputBlock(enriched, userMode);
    this.history.push({ role: 'user', content: wrapped });

    const pendingId = nextId();
    this.messages.push({ id: pendingId, role: 'assistant', content: '', pending: true });
    this.setStatus(isLiveTestRun ? 'Testing' : this.chatMode === 'agent' ? 'Thinking' : 'Planning');

    // Live Test: Chromium must open on send — never wait for Cline (no browser tools there).
    if (isLiveTestRun && !this.liveTestBootPromise) {
      this.liveTestBootPromise = this.bootstrapLiveBrowser(text || 'Test the application');
    }
    if (isLiveTestRun) {
      this.pushActivity(pendingId, 'browsing', 'Opening Test Browser…');
      void this.liveTestBootPromise?.then((boot) => {
        if (this.cancelRequested) {
          return;
        }
        const label = boot?.ok
          ? boot.url
            ? `Test Browser open · ${boot.url}`
            : 'Test Browser open'
          : boot?.error || 'Test Browser launch failed';
        for (let i = this.messages.length - 1; i >= 0; i--) {
          const m = this.messages[i];
          if (
            m.role === 'activity' &&
            m.activity &&
            !m.activity.done &&
            /Opening (Test Browser|Chromium)/i.test(m.activity.label || m.content || '')
          ) {
            m.activity = { ...m.activity, done: true, label };
            m.content = label;
            break;
          }
        }
        if (this.liveTesting) {
          this.setStatus('Testing');
        }
        this.fire();
      });
    }

    try {
      let reply = '';
      if (isLiveTestRun) {
        // Built-in loop owns live_test / browser_* tools. Cline does not.
        reply = await this.runAgentLoop(pendingId);
      } else {
        // Full Cline engine (@cline/sdk Agent + default tools). Falls back to legacy loop only if SDK fails to load.
        try {
          reply = await this.runClineEngine(pendingId, enriched);
        } catch (clineErr: any) {
          const msg = clineErr?.message || String(clineErr);
          if (/Cannot find module|Failed to fetch dynamically|ERR_MODULE_NOT_FOUND|@cline\//i.test(msg)) {
            this.pushUi('status', 'Agent engine unavailable — using built-in loop.');
            reply = await this.runAgentLoop(pendingId);
          } else {
            throw clineErr;
          }
        }
      }
      let finalText = this.sanitizeUserFacingReply((reply || '').trim());
      // Empty / stall dump → silent auto-resume once (Cursor never asks "resend").
      // Skip if the run already did real work (tools / edits) — re-running wastes time.
      const hadProgress =
        this.pendingChanges.length > 0 ||
        this.messages.some(
          (m) =>
            m.id === pendingId
              ? false
              : m.role === 'activity' &&
                m.activity &&
                m.activity.kind !== 'thinking' &&
                Boolean(m.activity.done),
        );
      if (
        (!finalText || this.looksLikeStallFallback(finalText)) &&
        this.stallAutoRetries < 1 &&
        !this.cancelRequested &&
        !hadProgress
      ) {
        this.stallAutoRetries += 1;
        this.setStatus('Provider stall — auto-resuming…');
        this.setStatus('Auto-resuming…');
        await sleep(450);
        try {
          const resumed = isLiveTestRun
            ? await this.runAgentLoop(pendingId)
            : await this.runClineEngine(pendingId, enriched);
          finalText = this.sanitizeUserFacingReply((resumed || '').trim());
        } catch {
          const resumed = await this.runAgentLoop(pendingId);
          finalText = this.sanitizeUserFacingReply((resumed || '').trim());
        }
      }
      if (!finalText || this.looksLikeStallFallback(finalText)) {
        finalText = this.friendlyCompletionMessage();
      } else {
        this.stallAutoRetries = 0;
      }
      const suggestions = this.extractSuggestions(finalText);
      await this.typeOut(pendingId, finalText);
      this.patchUi(pendingId, { suggestions: suggestions.length ? suggestions : undefined });
      this.history.push({ role: 'assistant', content: finalText });
      this.setStatus('');
    } catch (e: any) {
      // Transient provider errors: auto-resume once instead of dumping file lists.
      if (
        this.isTransientLlmError(e) &&
        this.stallAutoRetries < 1 &&
        !this.cancelRequested
      ) {
        this.stallAutoRetries += 1;
        this.setStatus('Provider error — auto-resuming…');
        this.setStatus('Auto-resuming…');
        try {
          await sleep(600);
          const resumed = await this.runAgentLoop(pendingId);
          let finalText = this.sanitizeUserFacingReply((resumed || '').trim());
          if (!finalText || this.looksLikeStallFallback(finalText)) {
            finalText = this.pendingChanges.length
              ? this.fallbackSummary()
              : this.friendlyCompletionMessage();
          } else {
            this.stallAutoRetries = 0;
          }
          await this.typeOut(pendingId, finalText);
          this.history.push({ role: 'assistant', content: finalText });
          this.setStatus('');
          return;
        } catch {
          // fall through
        }
      }
      if (this.isTransientLlmError(e) && this.pendingChanges.length) {
        const summary = this.fallbackSummary();
        await this.typeOut(pendingId, summary);
        this.history.push({ role: 'assistant', content: summary });
        this.setStatus('');
      } else if (this.isTransientLlmError(e)) {
        const msg = this.friendlyCompletionMessage();
        await this.typeOut(pendingId, msg);
        this.history.push({ role: 'assistant', content: msg });
        this.setStatus('');
      } else if (/exceeded maxIterations/i.test(e?.message || String(e))) {
        const msg =
          'I hit the per-run step limit on this large task. Reply **continue** and I’ll keep going from where I left off.';
        await this.typeOut(pendingId, msg);
        this.history.push({ role: 'assistant', content: msg });
        this.setStatus('');
      } else {
        this.patchUi(pendingId, {
          content: `Error: ${e?.message || String(e)}`,
          pending: false,
        });
        this.setStatus('');
      }
    } finally {
      this.busy = false;
      if (this.liveTesting) {
        this.liveTesting = false;
        this.liveTestBootPromise = null;
        this.liveTestBootResult = null;
      }
      this.finishVoLiveQa(this.cancelRequested ? 'cancelled' : 'completed');
      this.persistCurrentSession();
      this.fire();
      this.scheduleFlushQueue();
    }
  }

  private scheduleFlushQueue() {
    if (this.flushQueueScheduled) {
      return;
    }
    this.flushQueueScheduled = true;
    setTimeout(() => {
      this.flushQueueScheduled = false;
      void this.flushNextQueued();
    }, 80);
  }

  private async flushNextQueued() {
    if (this.busy || !this.queuedMessages.length) {
      return;
    }
    const next = this.queuedMessages.shift()!;
    this.fire();
    await this.send(next.text, next.attachments);
  }

  private extractSuggestions(text: string): string[] {
    const out: string[] = [];
    const section = /(?:\*\*)?Suggested checks(?:\*\*)?\s*\n([\s\S]*?)(?:\n\n|\n(?=[A-Z])|$)/i.exec(
      text || '',
    );
    const block = section?.[1] || text || '';
    for (const line of block.split('\n')) {
      const m = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line);
      if (m?.[1]) {
        const s = m[1].replace(/\*\*/g, '').trim();
        if (s.length > 4 && s.length < 160) {
          out.push(s);
        }
      }
      if (out.length >= 4) {
        break;
      }
    }
    return out;
  }

  /** Resolve @mentions / drag-drop into clipped file context for the model. */
  private async buildUserContentWithAttachments(
    text: string,
    attachments: ChatAttachment[],
  ): Promise<string> {
    const parts: string[] = [text || '(see attached context)'];
    if (!attachments.length) {
      // Also expand bare @path tokens typed in the message
      const mentioned = this.extractAtPaths(text);
      for (const rel of mentioned.slice(0, 8)) {
        const block = await this.readAttachmentBlock(rel);
        if (block) {
          parts.push(block);
        }
      }
      return parts.join('\n\n');
    }

    parts.push('ATTACHED CONTEXT (use these as primary references):');
    for (const att of attachments.slice(0, 12)) {
      if (att.kind === 'folder') {
        const listing = await this.toolListDir(att.path);
        parts.push(`### Folder @${att.name}\n\`\`\`\n${listing.slice(0, 4000)}\n\`\`\``);
      } else if (att.kind === 'codebase') {
        parts.push(`### @codebase\n${await this.toolCodebaseContext(att.name || text)}`);
      } else if (att.kind === 'problems') {
        parts.push(`### @Problems\n${this.toolGetDiagnostics(undefined, 'all', 40)}`);
      } else if (att.kind === 'git') {
        parts.push(`### @Git\n${this.toolGetGitStatus(40)}`);
      } else if (att.kind === 'selection') {
        parts.push(`### @Selection\n${this.toolGetSelection()}`);
      } else if (att.kind === 'image' && att.dataUrl) {
        parts.push(
          `### Image @${att.name}\n(Image attached: ${att.mimeType || 'image'}; describe/use as visual reference.)\nDATA_URL_PREFIX: ${att.dataUrl.slice(0, 64)}…`,
        );
      } else if (att.kind === 'web' || att.kind === 'docs') {
        parts.push(
          `### @${att.kind}\nUser requested ${att.kind} context for: ${att.name || text}. Use repository tools; external web fetch is not enabled in this build — answer from the workspace.`,
        );
      } else {
        const block = await this.readAttachmentBlock(att.path);
        if (block) {
          parts.push(block);
        }
      }
    }
    return parts.join('\n\n');
  }

  private extractAtPaths(text: string): string[] {
    const out: string[] = [];
    const re = /@([A-Za-z0-9_./\\-]+(?:\.[A-Za-z0-9]+)?)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text || ''))) {
      out.push(m[1].replace(/\\/g, '/'));
    }
    return [...new Set(out)];
  }

  private async readAttachmentBlock(inputPath: string): Promise<string | undefined> {
    try {
      const filePath = this.resolvePath(inputPath);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return undefined;
      }
      const raw = await this.readText(filePath);
      // Full attachment content counts as "read" for the edit guard.
      if (raw.length <= 8000) {
        this.filesReadThisSession.add(normPath(filePath));
      }
      const clipped = raw.length > 8000 ? `${raw.slice(0, 8000)}\n/* truncated */` : raw;
      const name = this.displayPath(filePath);
      return `### File @${name}\n\`\`\`\n${clipped}\n\`\`\``;
    } catch {
      return undefined;
    }
  }

  async listMentionCandidates(query: string, limit = 40): Promise<ChatAttachment[]> {
    const root = this.workspaceRoot();
    const q = (query || '').trim().toLowerCase().replace(/^@/, '');
    const specials = (
      [
        { path: '@codebase', name: 'codebase', kind: 'codebase' },
        { path: '@problems', name: 'Problems', kind: 'problems' },
        { path: '@git', name: 'Git', kind: 'git' },
        { path: '@selection', name: 'Selection', kind: 'selection' },
        { path: '@docs', name: 'Docs', kind: 'docs' },
        { path: '@web', name: 'Web', kind: 'web' },
      ] as ChatAttachment[]
    ).filter((s) => !q || s.name.toLowerCase().includes(q) || s.kind.includes(q));

    if (!root || !fs.existsSync(root)) {
      return specials.slice(0, limit);
    }
    const results: ChatAttachment[] = [...specials];
    this.walkFiles(root, (abs) => {
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      const base = path.basename(abs).toLowerCase();
      if (!q || base.includes(q) || rel.toLowerCase().includes(q)) {
        results.push({ path: abs, name: rel, kind: 'file' });
      }
      return results.length < limit ? undefined : false;
    });
    try {
      for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
        if (!ent.isDirectory() || SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) {
          continue;
        }
        if (!q || ent.name.toLowerCase().includes(q)) {
          results.splice(specials.length, 0, {
            path: path.join(root, ent.name),
            name: ent.name,
            kind: 'folder',
          });
        }
      }
    } catch {
      // ignore
    }
    return results.slice(0, limit);
  }

  /** Instant finalize — fake typing only slows perceived speed vs Cursor. */
  private async typeOut(pendingId: string, full: string) {
    const text = this.sanitizeUserFacingReply(full || '');
    if (!text) {
      this.patchUi(pendingId, { content: this.friendlyCompletionMessage(), pending: false });
      return;
    }
    this.patchUi(pendingId, { content: text, pending: false });
  }

  /** Old stall dumps Cursor never shows — strip / replace. */
  private looksLikeStallFallback(text: string): boolean {
    const t = text || '';
    return (
      /Top match ready:/i.test(t) ||
      /Resend the same request/i.test(t) ||
      /Resend the same message/i.test(t) ||
      /I’ll auto-resume/i.test(t) ||
      /I hit a transient API stall/i.test(t) ||
      /Most relevant files for your question:/i.test(t) ||
      /provider dropped mid-turn/i.test(t) ||
      /provider dropped before the full answer/i.test(t) ||
      /provider connection dropped/i.test(t)
    );
  }

  private sanitizeUserFacingReply(text: string): string {
    const t = (text || '').trim();
    if (!t) return '';
    if (this.looksLikeStallFallback(t)) return '';
    if (this.looksLikeGarbageToolDump(t)) {
      const cleaned = this.bubbleSafeContent(t);
      return cleaned || '';
    }
    // Truncated path dumps (sometimes leaked mid-stream)
    if (/^[a-z0-9_./\\-]+\.(ts|tsx|js|html|scss)\s*$/i.test(t) && t.length < 200) {
      return '';
    }
    return this.formatAnswerForUi(t);
  }

  /**
   * Cursor-clean final polish: user sees ONLY the answer — never tool monologue.
   */
  private formatAnswerForUi(text: string): string {
    let t = (text || '').replace(/\r\n/g, '\n').trim();
    if (!t) return t;

    t = this.stripAgentMonologue(t);

    // Model sometimes writes "JS\nCopy\n" instead of a real fence
    t = t.replace(/(^|\n)(?:JS|JavaScript|TypeScript|TS|tsx?)\nCopy\n/gi, '$1```js\n');
    if ((t.match(/```/g) || []).length % 2 === 1) {
      t = `${t}\n\`\`\``;
    }

    // Emoji section headers → markdown headings
    t = t.replace(/^[❌✅⚠️]\s*/gm, '## ');
    t = t.replace(/^#{1,3}\s*[❌✅⚠️]\s*/gm, (m) => m.replace(/[❌✅⚠️]\s*/, ''));

    t = t.replace(/\n{3,}/g, '\n\n');

    // Drop duplicated trailing blocks
    const paras = t.split(/\n{2,}/);
    if (paras.length >= 4) {
      const last = paras[paras.length - 1].trim();
      const prev = paras[paras.length - 2].trim();
      if (
        last.length > 40 &&
        (prev.includes(last.slice(0, 60)) || last.includes(prev.slice(0, 60)))
      ) {
        paras.pop();
        t = paras.join('\n\n');
      }
    }

    const lines = t.split('\n');
    if (lines.length > 8) {
      const tail = lines.slice(-5).join('\n').trim();
      const head = lines.slice(0, -5).join('\n');
      if (tail.length > 50 && head.includes(tail.slice(0, Math.min(90, tail.length)))) {
        t = head.trim();
      }
    }

    return t.trim();
  }

  /** Drop "let me try tools / string= broken / tooling caveat" chatter — Cursor never shows this. */
  private looksLikeAgentMonologue(para: string): boolean {
    const p = (para || '').trim();
    if (!p) return true;
    // Real answer content — never treat as monologue
    if (
      /^#{1,3}\s+/.test(p) ||
      /^\|/.test(p) ||
      /^[-*•]\s+/.test(p) ||
      /^```/.test(p) ||
      /^(What |Based |When |Action\b|Note\b|Inactive|CLOSED|Entity status)/i.test(p)
    ) {
      return false;
    }
    if (
      /^(actually[,.]?\s|let me\b|the tool\b|i have the\b|i already\b|tooling caveat\b|wait[,.]|ok[,.] I|alright[,.])/i.test(
        p,
      )
    ) {
      return true;
    }
    return /\b(tool is consistently broken|appends string=|injected string=|read_file kept failing|let me try list_dir|let me try |could not open the (two )?call-site|Recovered \d+ tool|Injected enforcement|then answer based on that code)\b/i.test(
      p,
    );
  }

  private stripAgentMonologue(text: string): string {
    let t = (text || '').replace(/\r\n/g, '\n').trim();
    if (!t) return t;

    // Cut leading monologue paragraphs until real answer starts
    const parts = t.split(/\n{2,}/);
    let start = 0;
    while (start < parts.length && this.looksLikeAgentMonologue(parts[start])) {
      start++;
    }
    // Also skip a following "Actually..." bridge para
    while (start < parts.length && this.looksLikeAgentMonologue(parts[start])) {
      start++;
    }
    if (start > 0 && start < parts.length) {
      t = parts.slice(start).join('\n\n');
    } else if (start >= parts.length) {
      // Entire message was monologue — try to salvage from first ## / What / Based on
      const m = text.match(
        /\n(?=#{1,3}\s+|What (a |an |the )?[A-Za-z]|Based (solely )?on |When (a |an |the )[A-Za-z])/i,
      );
      if (m && m.index != null) {
        t = text.slice(m.index).trim();
      }
    }

    // Drop trailing tooling caveat sections
    t = t.replace(
      /\n+(?:\*\*)?(?:Tooling caveat|Note on tooling|I could not open|The tool is consistently)[\s\S]*$/i,
      '',
    );

    // Drop mid-body monologue lines
    t = t
      .split('\n')
      .filter((line) => !this.looksLikeAgentMonologue(line) || /^#{1,3}\s+/.test(line) || /^\|/.test(line) || /^[-*•]/.test(line.trim()) || /^```/.test(line))
      .join('\n');

    // If still starts with process talk on first line, cut to first heading
    if (/^(the tool|let me|actually|i have|i already)/i.test(t)) {
      const idx = t.search(/\n(?=#{1,3}\s+|What |Based |When )/i);
      if (idx > 0) t = t.slice(idx).trim();
    }

    return t.replace(/\n{3,}/g, '\n\n').trim();
  }

  private friendlyCompletionMessage(exploredPaths: string[] = [], userText = ''): string {
    if (this.pendingChanges.length) {
      return this.fallbackSummary(exploredPaths, userText);
    }
    const ranked = this.rankCandidatePaths(exploredPaths, userText);
    if (ranked.length) {
      return (
        `I was working on \`${ranked[0]}\` when the provider connection dropped. ` +
        `Please send the same message again — I’ll continue from that file automatically.`
      );
    }
    return (
      `The provider connection dropped mid-turn. ` +
      `Please send the same message again and I’ll continue automatically.`
    );
  }

  private fallbackSummary(exploredPaths: string[] = [], userText = ''): string {
    const pending = this.pendingChanges;
    if (pending.length) {
      const lines = pending.map(
        (c) =>
          `• ${c.displayName}` +
          (c.additions || c.deletions ? ` (+${c.additions}/−${c.deletions})` : '') +
          (c.summary ? ` — ${c.summary}` : ''),
      );
      return (
        `Done — here's what changed:\n${lines.join('\n')}\n\n` +
        `**Suggested checks**\n` +
        `• Review the diff cards above (Accept / Revert)\n` +
        `• Open the edited files and sanity-check the surrounding code\n` +
        `• Run your usual build/test if this touched runtime behavior`
      );
    }
    if (this.chatMode !== 'agent' && this.chatMode !== 'ask') {
      return 'I do not have more to add yet — switch to Agent if you want me to apply the plan.';
    }
    // Never dump "Top match ready / Resend…" — that was the bug the user hit.
    return this.friendlyCompletionMessage(exploredPaths, userText);
  }

  /** Last-chance finish: never dump "Send continue" or file-picker dumps. */
  private async forceFinishWithoutAsking(
    pendingId: string,
    messages: ChatMessage[],
    exploredPaths: Set<string>,
    latestUser: string,
    questionIntent: boolean,
    opts?: { needsImplementation?: boolean },
  ): Promise<string> {
    const top = this.rankCandidatePaths(exploredPaths, latestUser).slice(0, 6);
    if (this.pendingChanges.length) {
      return this.fallbackSummary(top, latestUser);
    }

    // Cursor: last-chance TOOL round for coding tasks — don't just narrate
    if (opts?.needsImplementation && !questionIntent) {
      this.setStatus('Last attempt — editing…');
      this.pushActivity(pendingId, 'thinking', 'Last attempt — applying edit…');
      const pick = top[0] || 'best matching file';
      messages.push({
        role: 'user',
        content:
          `LAST CHANCE — you MUST call tools now. Do NOT narrate. Do NOT ask which file.\n` +
          `1) read_file \`${pick}\` (if not already read)\n` +
          `2) search_replace with exact snippet from that file\n` +
          `Targets:\n${top.map((p) => `- ${p}`).join('\n') || `- ${pick}`}\n` +
          `Request: "${latestUser.slice(0, 400)}"`,
      });
      try {
        const tools = selectAgentTools({
          mode: 'agent',
          madeEdits: false,
          searchCount: 1,
          readCount: 1,
          hasSeedTargets: true,
        });
        const result = await this.invokeCompletionResilient(pendingId, {
          messages,
          tools,
          toolChoice: 'auto',
          modelId: this.modelId,
          stream: true,
          maxTokens: 2800,
        });
        let toolCalls = result.tool_calls;
        let content = (result.content || '').trim();
        if ((!toolCalls || !toolCalls.length) && this.looksLikeGarbageToolDump(content)) {
          toolCalls = this.parseEmbeddedToolCalls(content);
          content = this.stripGarbageToolDump(content);
        }
        if (toolCalls?.length) {
          messages.push({
            role: 'assistant',
            content: content || null,
            tool_calls: toolCalls,
          });
          const toolResults = await this.executeToolCallsParallel(pendingId, toolCalls);
          let landed = false;
          for (let i = 0; i < toolCalls.length; i++) {
            const name = toolCalls[i].function?.name || '';
            const toolResult = toolResults[i] || '';
            messages.push({
              role: 'tool',
              tool_call_id: toolCalls[i].id,
              content: toolResult.length > 4000 ? `${toolResult.slice(0, 4000)}\n/* truncated */` : toolResult,
            });
            if (MUTATING_TOOL_NAMES.has(name) && this.isSuccessfulMutation(toolResult)) {
              landed = true;
            }
          }
          if (landed || this.pendingChanges.length) {
            return this.fallbackSummary(top, latestUser);
          }
        }
      } catch {
        // fall through to prose finish
      }
    }

    this.setStatus(questionIntent ? 'Answering…' : 'Finishing…');
    this.patchUi(pendingId, { content: '', pending: true });
    this.pushActivity(
      pendingId,
      'thinking',
      questionIntent ? 'Writing answer…' : 'Finishing…',
    );

    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.cancelRequested) {
        return 'Stopped by user.';
      }
      if (attempt > 0) {
        messages.push({
          role: 'user',
          content:
            `Previous finish attempt failed or was empty. Try again. ` +
            `Plain markdown only. No tools. No "resend" / file-picker talk.`,
        });
        await sleep(350);
      } else {
        const flowAsk = questionIntent && this.isFlowQuestionIntent(latestUser);
        messages.push({
          role: 'user',
          content: questionIntent
            ? flowAsk
              ? `Finish NOW with a GROUNDED project flow.\n` +
                `Numbered steps (Entry → UI → Service → API → Backend). Cite a real path per step.\n` +
                `Evidence files:\n${top.map((p) => `- ${p}`).join('\n') || '- (use dossier above)'}\n` +
                `Never invent. Mark missing layers as not found in evidence. No tools. Plain markdown.`
              : `Finish NOW with a clear user-facing answer.\n` +
                `Evidence files:\n${top.map((p) => `- ${p}`).join('\n') || '- (use evidence pack above)'}\n` +
                `Cite paths. Plain markdown only. No tools. Never ask continue, resend, or pick a file.`
            : `Finish NOW. Auto-pick \`${top[0] || 'best frontend file'}\`. ` +
              `If edits already happened, summarize briefly. If not, say what you were about to change on that file. ` +
              `Never say "resend", "Top match ready", or ask which file. Paths:\n${top.map((p) => `- ${p}`).join('\n')}`,
        });
      }
      try {
        const result = await this.invokeCompletionResilient(pendingId, {
          messages,
          toolChoice: 'none',
          modelId: this.modelId,
          stream: true,
          maxTokens: questionIntent ? 900 : 700,
        });
        const text = this.sanitizeUserFacingReply(
          this.stripGarbageToolDump((result.content || '').trim()),
        );
        if (
          text &&
          this.isValidFinalAnswer(text, questionIntent) &&
          !this.looksLikeStallFallback(text)
        ) {
          return text;
        }
        if (text && text.length >= 40 && !this.looksLikeStallFallback(text)) {
          return text;
        }
      } catch {
        // retry once
      }
    }
    return this.friendlyCompletionMessage(top, latestUser);
  }

  /** Prefer frontend UI sources when the user asked for frontend-only work. */
  private isFrontendOnlyIntent(text: string): boolean {
    return /\b(only\s+frontend|frontend\s+only|ui\s+only|only\s+ui|sirf\s+frontend|frontend\s+par)\b/i.test(
      text || '',
    );
  }

  private rankCandidatePaths(paths: Iterable<string>, userText = ''): string[] {
    const frontendOnly = this.isFrontendOnlyIntent(userText);
    const tokens = (userText.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) || []).map((t) =>
      t.toLowerCase(),
    );
    const scored = [...new Set([...paths].map((p) => p.replace(/\\/g, '/')))].map((p) => {
      const lower = p.toLowerCase();
      let score = 0;
      if (/\.(html|htm|tsx|jsx|vue|svelte|scss|css)$/i.test(p)) score += 40;
      if (/\.(ts|js)$/i.test(p) && !/\.(spec|test)\./i.test(p)) score += 20;
      if (/frontend|src\/app|components?\//i.test(lower)) score += 30;
      if (/bulk-upload|upload|relationship|limit|document/i.test(lower)) score += 25;
      if (/routing|module\.ts|controller|service|resolver|interceptor/i.test(lower)) score += 22;
      if (/backend|migrations?|models?\//i.test(lower)) score -= 35;
      if (/\.spec\.|\.test\./i.test(lower)) score -= 20;
      if (frontendOnly && /backend|migrations?|models?\//i.test(lower)) score -= 80;
      if (frontendOnly && /\.(html|scss|css|tsx|jsx|vue)$/i.test(p)) score += 25;
      for (const t of tokens.slice(0, 8)) {
        if (t.length >= 4 && lower.includes(t)) score += 18;
        if (t.length >= 4 && lower.includes(t.replace(/_/g, '-'))) score += 12;
      }
      return { p, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.p);
  }

  /**
   * Architecture / project-flow questions need Cursor-depth evidence:
   * investigate trails + multi-file reads — not a 2-file guess.
   */
  private isFlowQuestionIntent(text: string): boolean {
    const t = (text || '').toLowerCase();
    if (!t.trim()) return false;
    // Capability/behavior questions are handled separately (more precise).
    if (this.isCapabilityQuestionIntent(text)) return false;
    return (
      /\b(flow|architecture|pipeline|end[-\s]?to[-\s]?end|how (does|do|is)|explain|overview|walkthrough|data flow|request flow|call chain|sequence|lifecycle|samjhao|samajhao|kaise (chalta|kaam)|project (flow|structure|overview))\b/i.test(
        t,
      ) ||
      /\b(what (is|are) the (flow|steps|pipeline)|describe (the )?(flow|architecture|system))\b/i.test(t)
    );
  }

  /**
   * "What happens if X is deactivated / what can't they do?" —
   * Cursor finds the enforcement Guard/middleware first; never guess from UI lists.
   */
  private isCapabilityQuestionIntent(text: string): boolean {
    const t = (text || '').toLowerCase();
    if (!t.trim()) return false;
    return (
      /\b(deactivat|activat|inactive|active|disable|enable|block|unblock|suspend|close[sd]?|lock(ed)?|unlock)\b/i.test(
        t,
      ) ||
      /\b(can('?t|not)?|cannot|unable|allowed|forbidden|restrict|permission|access)\b/i.test(t) ||
      /\b(what (happens|will happen)|if i (deactivate|disable|close|block)|kya (nahi|ni) (kar|ho) sakta)\b/i.test(
        t,
      ) ||
      /\b(specific thing|kind of thing|operations? (blocked|allowed)|still (can|allowed)|remain(s)? (allowed|open))\b/i.test(
        t,
      )
    );
  }

  private isEnforcementPath(p: string): boolean {
    const lower = (p || '').toLowerCase();
    return /guard|middleware|validator|policy|interceptor|auth|account.?status|tx.?action|block/i.test(
      lower,
    );
  }

  private hasEnforcementEvidence(candidates: Iterable<string>, context = ''): boolean {
    const blob = `${context}\n${[...candidates].join('\n')}`.toLowerCase();
    return /guard|middleware|validator|policy|account_status|isac_status|block_messages|tx_action|allowed:\s*false|new_txn|repayment/.test(
      blob,
    );
  }

  /**
   * Capability pack: find the rule that ENFORCES behavior (Guard/middleware),
   * not the UI that toggles a status dropdown.
   */
  private async buildCapabilityQuestionContext(query: string): Promise<{
    context: string;
    candidates: string[];
    strongEvidence?: boolean;
  }> {
    const root = this.workspaceRoot();
    if (!root || !query.trim()) {
      return { context: '', candidates: [] };
    }
    try {
      const stop = new Set(
        'the and for with from this that which what where when how please about into only then than also just like will would could should after before let know kind thing specific'.split(
          ' ',
        ),
      );
      const tokens = (query.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) || [])
        .map((t) => t.trim())
        .filter((t) => t.length >= 3 && !stop.has(t.toLowerCase()));
      const entity = tokens.find((t) =>
        /dealer|anchor|buyer|seller|oem|user|vendor|customer|partner|account/i.test(t),
      );
      const entityLower = (entity || tokens[0] || '').toLowerCase();

      // Cursor-style: hunt enforcement code first
      const grepQueries = [
        entity ? `${entity}AccountStatus` : '',
        entity ? `${entity}AccountStatusGuard` : '',
        'AccountStatusGuard',
        'account_status',
        'accountStatus',
        'INACTIVE',
        'NEW_TXN',
        'BLOCK_MESSAGES',
        'Dealer account is Inactive',
        'is not Active',
        entity ? `${entity}.*INACTIVE` : '',
        'deactivat',
        ...tokens.slice(0, 4),
      ].filter(Boolean);

      const [greps, modules, findGuard, investigation] = await Promise.all([
        Promise.all(
          grepQueries.slice(0, 10).map((q) =>
            this.aiNode.grepRepository(root, q, { maxResults: 16 }).catch(() => null),
          ),
        ),
        this.aiNode.findModules(root, entity || query, 10).catch(() => null),
        this.aiNode.findFilesByName(root, 'Guard', 20).catch(() => null),
        Promise.race([
          this.aiNode.investigateRepository(root, query, 24),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_800)),
        ]),
      ]);

      const candidates: string[] = [];
      const grepLines: string[] = [];
      const push = (p?: string) => {
        if (p && !candidates.includes(p)) candidates.push(p);
      };

      for (const g of greps) {
        if (!g?.matches?.length) continue;
        for (const m of g.matches.slice(0, 10)) {
          push(m.path);
          const text = (m.text || '').trim().slice(0, 200);
          grepLines.push(`${m.path}:${m.line}: ${text}`);
        }
      }
      for (const h of modules?.hits || []) push(h.path);
      for (const f of findGuard?.files || []) push(f);
      if (investigation?.evidence) {
        for (const e of investigation.evidence) push(e.path);
      }

      // Rank: enforcement files first, UI list components last
      const ranked = [...new Set(candidates)]
        .map((p) => {
          const lower = p.toLowerCase();
          let score = 0;
          if (/guard/i.test(lower)) score += 80;
          if (/middleware|validator|policy/i.test(lower)) score += 60;
          if (/account.?status|tx.?action|block/i.test(lower)) score += 50;
          if (/service|controller|router|route/i.test(lower)) score += 35;
          if (entityLower && lower.includes(entityLower)) score += 25;
          if (/list\.component|dropdown|ui\//i.test(lower)) score -= 35;
          if (/\.spec\.|\.test\./i.test(lower)) score -= 50;
          if (/frontend/i.test(lower) && !/guard|interceptor/i.test(lower)) score -= 10;
          if (/backend|common-service|server|api\//i.test(lower)) score += 20;
          return { p, score };
        })
        .sort((a, b) => b.score - a.score)
        .map((x) => x.p)
        .slice(0, 16);

      // Prefer reading enforcement files; fall back to top ranked
      const enforceFirst = [
        ...ranked.filter((p) => this.isEnforcementPath(p)),
        ...ranked.filter((p) => !this.isEnforcementPath(p)),
      ].slice(0, 6);

      const fileSnippets: string[] = [];
      for (const p of enforceFirst) {
        try {
          const body = await this.toolReadFile(p);
          const clipped = body.length > 3200 ? `${body.slice(0, 3200)}\n/* clipped */` : body;
          fileSnippets.push(clipped);
        } catch {
          // skip
        }
      }

      const strongEvidence =
        enforceFirst.some((p) => this.isEnforcementPath(p)) && fileSnippets.length >= 1;

      const lines = [
        'CURSOR-DEPTH CAPABILITY DOSSIER (what can / cannot — NO GUESSING):',
        `Entity focus: ${entity || '(infer from query)'}`,
        '',
        '## Grep hits (enforcement-first)',
        ...(grepLines.slice(0, 30).map((l) => `- ${l}`) || ['- (none)']),
        '',
        '## Ranked files (Guard/middleware first; UI lists last)',
        ...ranked.slice(0, 12).map((p) => `- ${p}${this.isEnforcementPath(p) ? '  ← ENFORCEMENT' : ''}`),
        '',
        '## Auto-read file contents (source of truth)',
        fileSnippets.join('\n\n---\n\n') || '(none — grep Guard / account_status next)',
        '',
        'CRITICAL ACCURACY RULES (match Cursor):',
        '1. Find the Guard/middleware/validator that checks status BEFORE answering.',
        '2. UI list / deactivate button is NOT proof of what is blocked — only the enforcement code is.',
        '3. FORMAT (Cursor-clean): short intro → ## What they cannot do (bullets or a clean markdown table) → ## What they can still do → short code fence for the decisive if → ## Note.',
        '4. Prefer bullets like **Raise new invoice** — blocked by `path` when INACTIVE+NEW_TXN. Tables are OK if well-formed GFM.',
        '5. Distinguish different statuses (e.g. entity account_status vs user login status). Do NOT conflate them.',
        '6. NEVER invent status values, login blocks, or modules not present in the files above.',
        '7. If enforcement code says only NEW_TXN is blocked, do NOT claim full lockout / cannot login.',
        '8. No emoji section headers (❌ ✅ ⚠️). No duplicate trailing paragraphs. Plain markdown. No DSML/XML. No edits.',
      ];

      return {
        candidates: ranked,
        strongEvidence,
        context: lines.join('\n').slice(0, 22_000),
      };
    } catch (error: any) {
      return {
        candidates: [],
        context: `Capability investigation unavailable: ${error?.message || error}. Grep Guard/account_status then answer.`,
      };
    }
  }

  /** Deep flow pack: investigation dossier + 5–6 file reads along trails. */
  private async buildFlowQuestionContext(query: string): Promise<{
    context: string;
    candidates: string[];
    strongEvidence?: boolean;
  }> {
    const root = this.workspaceRoot();
    if (!root || !query.trim()) {
      return { context: '', candidates: [] };
    }
    try {
      const [investigation, quick] = await Promise.all([
        Promise.race([
          this.aiNode.investigateRepository(root, query, 28),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_500)),
        ]),
        this.buildQuickQuestionContext(query),
      ]);

      const candidates: string[] = [];
      const push = (p?: string) => {
        if (p && !candidates.includes(p)) candidates.push(p);
      };

      for (const p of quick.candidates || []) push(p);
      if (investigation?.evidence) {
        for (const e of investigation.evidence) push(e.path);
      }
      if (investigation?.trails) {
        for (const trail of investigation.trails.slice(0, 8)) {
          for (const p of trail) push(p);
        }
      }

      // Prefer entry/routing/service/controller for flow accuracy
      const flowRanked = [...new Set(candidates)]
        .map((p) => {
          const lower = p.toLowerCase();
          let score = 0;
          if (/app-routing|routes?\./i.test(lower)) score += 50;
          if (/routing\.module/i.test(lower)) score += 40;
          if (/\.module\.ts$/i.test(lower)) score += 25;
          if (/service|controller|resolver|facade|store|api/i.test(lower)) score += 35;
          if (/component\.(ts|tsx|html)$/i.test(lower)) score += 20;
          if (/interceptor|guard|middleware/i.test(lower)) score += 28;
          if (/\.spec\.|\.test\./i.test(lower)) score -= 40;
          for (const t of (query.match(/[A-Za-z][A-Za-z0-9_-]{3,}/g) || []).slice(0, 6)) {
            if (lower.includes(t.toLowerCase())) score += 15;
          }
          return { p, score };
        })
        .sort((a, b) => b.score - a.score)
        .map((x) => x.p);

      const ranked = this.rankCandidatePaths(
        flowRanked.length ? flowRanked : candidates,
        query,
      ).slice(0, 14);

      // Related files for top 3 seeds
      for (const seed of ranked.slice(0, 3)) {
        try {
          const rel = await this.aiNode.getRelatedFiles(root, seed, 6);
          for (const h of rel?.hits || []) push(h.path);
        } catch {
          // ignore
        }
      }
      const finalRanked = this.rankCandidatePaths([...candidates, ...ranked], query).slice(0, 14);

      const fileSnippets: string[] = [];
      const readTargets = finalRanked.slice(0, 6);
      for (const p of readTargets) {
        try {
          const body = await this.toolReadFile(p);
          const clipped = body.length > 2800 ? `${body.slice(0, 2800)}\n/* clipped */` : body;
          fileSnippets.push(clipped);
        } catch {
          // skip
        }
      }

      const trails = investigation?.trails?.length
        ? investigation.trails
            .slice(0, 8)
            .map((trail, i) => `T${i + 1}: ${trail.join(' → ')}`)
            .join('\n')
        : '(no multi-hop trail yet — use file contents below)';

      const evidenceBlock =
        investigation?.evidence
          ?.slice(0, 12)
          .map((item, index) => {
            const link = item.from ? `${item.from} --${item.via}--> ${item.path}` : `seed → ${item.path}`;
            return `### E${index + 1} ${link} [${item.score}%]
why: ${(item.reasons || []).join(' | ')}
symbols: ${(item.symbols || []).slice(0, 8).join(', ') || '(none)'}
calls: ${(item.calls || []).slice(0, 8).join(', ') || '(none)'}
API/routes: ${(item.apiEndpoints || []).join(', ') || '(none)'}
${(item.excerpt || '').slice(0, 600)}`;
          })
          .join('\n\n') || quick.context;

      const confidence = investigation?.confidence ?? 0;
      const strongEvidence =
        fileSnippets.length >= 4 ||
        confidence >= 45 ||
        (investigation?.trails?.length || 0) >= 1;

      const lines = [
        'CURSOR-DEPTH FLOW DOSSIER (ACCURACY > SPEED — ground every claim):',
        `Investigation confidence: ${confidence}/100`,
        `Concepts: ${(investigation?.intent?.expandedConcepts || []).slice(0, 12).join(', ') || '(n/a)'}`,
        '',
        '## Proven / likely trails (UI → handler → service → API)',
        trails,
        '',
        '## Evidence graph',
        evidenceBlock,
        '',
        '## Auto-read file contents (primary source of truth)',
        fileSnippets.join('\n\n---\n\n') || '(none)',
        '',
        '## Candidate paths',
        ...finalRanked.slice(0, 12).map((p) => `- ${p}`),
        '',
        'GROUNDING RULES (CRITICAL — Cursor-level accuracy):',
        '- Describe ONLY what appears in trails / evidence / file contents above.',
        '- Structure answer as numbered flow: Entry → UI/Component → Service → API/HTTP → Backend (skip missing layers; say "not found in evidence").',
        '- Every step MUST cite a real path from the dossier.',
        '- NEVER invent modules, endpoints, DB tables, or steps not in evidence.',
        '- If confidence is low or trails are thin, say what is verified vs uncertain.',
        '- Plain markdown. No DSML/XML/tool dumps. Do NOT edit files.',
      ];

      return {
        candidates: finalRanked,
        strongEvidence,
        context: lines.join('\n').slice(0, 22_000),
      };
    } catch (error: any) {
      return {
        candidates: [],
        context: `Flow investigation unavailable: ${error?.message || error}. Use investigate_codepath then answer.`,
      };
    }
  }

  /** Cursor Ask-speed: parallel greps + excerpts + auto-read top files before first LLM call. */
  private async buildQuickQuestionContext(query: string): Promise<{
    context: string;
    candidates: string[];
    strongEvidence?: boolean;
  }> {
    const root = this.workspaceRoot();
    if (!root || !query.trim()) {
      return { context: '', candidates: [] };
    }
    try {
      const stop = new Set(
        'the and for with from this that which what where when how please project open hai hota hogi etc konsa kaunsa about into onto only there their they then than also just like will would could should into under over after before'.split(
          ' ',
        ),
      );
      const tokens = (query.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) || [])
        .map((t) => t.trim())
        .filter((t) => t.length >= 3 && !stop.has(t.toLowerCase()));
      const terms = [...new Set(tokens)].slice(0, 6);
      // Multi-word phrases Cursor would search first ("relationship limit")
      const phrases: string[] = [];
      for (let i = 0; i < tokens.length - 1 && phrases.length < 3; i++) {
        phrases.push(`${tokens[i]} ${tokens[i + 1]}`);
        phrases.push(`${tokens[i]}-${tokens[i + 1]}`);
      }
      if (/document|format|upload|accept|mime/i.test(query)) {
        phrases.push('accept=');
        phrases.push('application/pdf');
      }

      const grepQueries = [
        ...phrases.slice(0, 4),
        ...terms.slice(0, 3),
        /format|document|upload/i.test(query) ? 'accept=' : '',
      ].filter(Boolean);

      const [greps, modules, ...exact] = await Promise.all([
        Promise.all(
          grepQueries.slice(0, 5).map((q) =>
            this.aiNode.grepRepository(root, q, { maxResults: 12 }).catch(() => null),
          ),
        ),
        this.aiNode.findModules(root, query, 8).catch(() => null),
        ...terms.slice(0, 3).map((t) =>
          this.aiNode.exactRepositorySearch(root, t, 6).catch(() => null),
        ),
      ]);

      const candidates: string[] = [];
      const grepLines: string[] = [];
      let strongEvidence = false;

      for (const g of greps) {
        if (!g?.matches?.length) continue;
        for (const m of g.matches.slice(0, 8)) {
          if (m.path && !candidates.includes(m.path)) candidates.push(m.path);
          const text = (m.text || '').trim().slice(0, 180);
          grepLines.push(`${m.path}:${m.line}: ${text}`);
          if (
            /\b(accept\s*=|application\/pdf|\.pdf|\.docx?|\.xlsx?|\.csv|image\/|mime|fileTypes?|allowedFormats?)\b/i.test(
              text,
            )
          ) {
            strongEvidence = true;
          }
        }
      }

      for (const result of [modules, ...exact]) {
        if (!result?.hits) continue;
        for (const hit of result.hits.slice(0, 5)) {
          const p = hit.path;
          if (p && !candidates.includes(p)) candidates.push(p);
          if (hit.excerpt && /accept=|\.pdf|document|format/i.test(hit.excerpt)) {
            strongEvidence = true;
            grepLines.push(`${p}: ${(hit.excerpt || '').trim().slice(0, 160)}`);
          }
        }
      }

      const ranked = this.rankCandidatePaths(candidates, query).slice(0, 10);

      // Auto-read top 2 files (Cursor injects snippets before answering)
      const fileSnippets: string[] = [];
      for (const p of ranked.slice(0, 2)) {
        try {
          const body = await this.toolReadFile(p);
          const clipped = body.length > 3500 ? `${body.slice(0, 3500)}\n/* clipped */` : body;
          fileSnippets.push(clipped);
          if (
            /\b(accept\s*=|application\/pdf|\.pdf|\.docx?|fileTypes?|allowedFormats?)\b/i.test(body)
          ) {
            strongEvidence = true;
          }
        } catch {
          // skip unreadable
        }
      }

      const lines: string[] = [
        'CURSOR-ASK EVIDENCE PACK (answer from this — do not invent):',
        '',
        '## Grep hits',
        ...(grepLines.slice(0, 24).map((l) => `- ${l}`) || ['- (none)']),
        '',
        '## Top files',
        ...ranked.slice(0, 8).map((p) => `- ${p}`),
        '',
        '## File contents (auto-read)',
        fileSnippets.join('\n\n---\n\n') || '(none — use grep/read_file once)',
        '',
        'ANSWER RULES:',
        '- Write a clear user-facing answer in plain markdown (bullets OK).',
        '- Cite real paths. List allowed document formats / fields if present in evidence.',
        '- If evidence already has accept=/mime/.pdf — ANSWER NOW. No more tools.',
        '- NEVER output DSML, XML, <invoke>, toolcalls text. Tools only via tool_calls API.',
        '- Do NOT edit files. Do NOT call update_todos.',
      ];

      return {
        candidates: ranked,
        strongEvidence,
        context: lines.join('\n').slice(0, 14_000),
      };
    } catch (error: any) {
      return {
        candidates: [],
        context: `Quick search unavailable: ${error?.message || error}. Use exact_code_search then answer.`,
      };
    }
  }

  private async buildRepositoryContext(query: string): Promise<{
    context: string;
    candidates: string[];
    strongEvidence?: boolean;
  }> {
    if (this.isQuestionIntent(query)) {
      if (this.isCapabilityQuestionIntent(query)) {
        return this.buildCapabilityQuestionContext(query);
      }
      if (this.isFlowQuestionIntent(query)) {
        return this.buildFlowQuestionContext(query);
      }
      return this.buildQuickQuestionContext(query);
    }
    const root = this.workspaceRoot();
    if (!root || !query.trim()) {
      return { context: '', candidates: [] };
    }
    try {
      // Soft budget — never stall the agent; tools investigate deeper if this times out.
      const investigation = await Promise.race([
        this.aiNode.investigateRepository(root, query, 24),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
      ]);
      if (!investigation) {
        return {
          candidates: [],
          context:
            'REPOSITORY INTELLIGENCE still indexing (large project). ' +
            'Use exact_code_search/grep for exact strings NOW, and call investigate_codepath yourself for flow bugs.',
        };
      }
      const candidates = investigation.evidence.map((item) => item.path);
      if (!investigation.evidence.length) {
        return {
          candidates,
          context: `EVIDENCE INVESTIGATION:
Intent: ${investigation.intent.kind}
Concepts: ${investigation.intent.expandedConcepts.join(', ')}
No seed evidence found. Call investigate_codepath/find_module with narrower module words, then grep discovered synonyms.`,
        };
      }
      const evidence = investigation.evidence.slice(0, 14).map((item, index) => {
        const link = item.from ? `${item.from} --${item.via}--> ${item.path}` : `seed → ${item.path}`;
        return `### E${index + 1} ${link} [${item.score}%]
why: ${item.reasons.join(' | ')}
symbols: ${item.symbols.slice(0, 10).join(', ') || '(none)'}
calls: ${item.calls.slice(0, 10).join(', ') || '(none)'}
API/routes: ${item.apiEndpoints.join(', ') || '(none)'}
${item.excerpt}`;
      });
      const trails = investigation.trails.length
        ? investigation.trails
            .slice(0, 6)
            .map((trail, index) => `T${index + 1}: ${trail.join(' → ')}`)
            .join('\n')
        : '(No multi-hop trail proven yet)';
      const context = `EVIDENCE-BASED INVESTIGATION DOSSIER
Intent: ${investigation.intent.kind}
Concepts: ${investigation.intent.concepts.join(', ')}
Semantic expansion: ${investigation.intent.expandedConcepts.join(', ')}
Confidence: ${investigation.confidence}/100
Graph: ${investigation.status.files} files · ${investigation.status.symbols} symbols · ${investigation.status.edges} typed edges

PROVEN / LIKELY TRAILS:
${trails}

EVIDENCE:
${evidence.join('\n\n')}

GAPS:
${investigation.gaps.map((gap) => `- ${gap}`).join('\n') || '- none'}

OPERATING RULE:
Read the highest-scoring evidence in trail order. For a bug, trace UI → handler → service → HTTP route → backend before editing. If confidence is below 80, use investigate_codepath again with a discovered symbol/route. Do not stop after one file.`;
      return {
        candidates,
        context:
          context.length > 18_000
            ? `${context.slice(0, 18_000)}\n/* investigation dossier clipped */`
            : context,
      };
    } catch (error: any) {
      return {
        candidates: [],
        context: `REPOSITORY INTELLIGENCE unavailable: ${error?.message || error}. Use find_module/repository_search/find_files/grep before concluding.`,
      };
    }
  }

  /**
   * Virtual Office: assign via chat to Manager / developer without blocking single-agent.
   */
  private async sendVirtualOfficeAssignment(
    text: string,
    attachments: ChatAttachment[],
    opts?: { historyText?: string },
  ) {
    const option = findModel(this.modelId);
    if (option.provider === 'ollama') {
      const phase = this.ollamaDownload.phase;
      if (
        phase === 'needs_download' ||
        phase === 'error' ||
        phase === 'downloading' ||
        phase === 'starting'
      ) {
        this.pushUi('status', 'Finish Ollama model setup before assigning Virtual Office work.');
        return;
      }
    }

    const display =
      attachments.length > 0
        ? `${text}${text ? '\n' : ''}${attachments.map((a) => `@${a.name}`).join(' ')}`
        : text;

    const who =
      this.virtualOffice.assigneeId === 'manager'
        ? 'Manager'
        : this.virtualOffice.assigneeId;

    this.messages.push({
      id: nextId(),
      role: 'user',
      content: `[Virtual Office → ${who}] ${display || '(attachments)'}`,
      attachments: attachments.length ? [...attachments] : undefined,
    });
    if (this.messages.length > 160) {
      this.messages = this.messages.slice(-160);
    }

    const pendingId = nextId();
    this.messages.push({
      id: pendingId,
      role: 'assistant',
      content: 'Assigning on the Virtual Office floor…',
      pending: true,
    });
    this.setStatus('Virtual Office');
    this.fire();

    try {
      const forAgent = (opts?.historyText || text).trim() || text;
      const enriched = await this.buildUserContentWithAttachments(forAgent, attachments);
      const task = await this.virtualOffice.assignFromChat(enriched, {
        modelId: this.modelId,
        mode: this.chatMode === 'ask' ? 'ask' : this.chatMode === 'plan' ? 'plan' : 'agent',
      });

      const msg = this.messages.find((m) => m.id === pendingId);
      if (msg) {
        msg.pending = false;
        msg.content = [
          `Assigned to **${task.workerName}** on the Virtual Office floor.`,
          '',
          `Task: ${task.title}`,
          '',
          who === 'Manager'
            ? 'Manager picked a free developer. You can assign another task in parallel — pick someone else (or Manager again) in the dropdown.'
            : 'They are working in parallel. Switch the dropdown to another free teammate for the next task.',
        ].join('\n');
      }
      this.setStatus('');
      this.fire();
    } catch (err: any) {
      const msg = this.messages.find((m) => m.id === pendingId);
      if (msg) {
        msg.pending = false;
        msg.content = `Virtual Office assign failed: ${err?.message || err}`;
      }
      this.setStatus('');
      this.fire();
    }
  }

  /**
   * OLKIL coding agent (Cline-engine under the hood).
   * Live tools / thinking / file-change cards surface in the Olkil chat UI.
   */
  private async runClineEngine(pendingId: string, prompt: string): Promise<string> {
    const workspaceRoot = this.workspaceRoot();
    // No folder open: never fall back to the IDE codebase. Soft ask only when
    // the user wants project edits; basic Q&A can still answer in chat.
    if (!workspaceRoot) {
      if (this.wantsProjectFolder(prompt)) {
        return 'Please open your project folder in OLKIL first (File → Open Folder), then ask me again and I’ll work only inside that folder.';
      }
    }

    const runId = `olkil_${Date.now()}_${++msgSeq}`;
    this.activeClineRunId = runId;
    const active = this.editorService.currentResource?.uri.codeUri.fsPath;
    const projectRules = workspaceRoot ? this.getProjectRules() : '';

    this.setStatus('Thinking');
    const runPromise = this.aiNode.clineRun({
      runId,
      prompt,
      workspaceRoot: workspaceRoot || '',
      activeFile: active,
      mode: this.chatMode,
      modelId: this.modelId,
      rules: projectRules,
      autoApprove: this.chatMode === 'agent',
    });

    const seenActivities = new Set<string>();
    const finishedActivities = new Set<string>();
    const fileChangeFingerprints = new Map<string, string>();
    let lastText = '';
    let lastReasoning = '';
    let thinkingStarted = false;
    let explorerRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    const touchedExplorerPaths = new Set<string>();
    let lastOpenedEditPath = '';
    let lastUiFireAt = 0;
    let pendingFire = false;

    const scheduleExplorerRefresh = (filePath: string) => {
      touchedExplorerPaths.add(filePath);
      if (explorerRefreshTimer) {
        clearTimeout(explorerRefreshTimer);
      }
      // Debounce so rapid multi-file edits refresh the tree live without thrashing.
      explorerRefreshTimer = setTimeout(() => {
        explorerRefreshTimer = null;
        void this.refreshExplorerLive([...touchedExplorerPaths]);
        touchedExplorerPaths.clear();
      }, 120);
    };

    const fireUiThrottled = () => {
      const now = Date.now();
      if (now - lastUiFireAt >= 120) {
        lastUiFireAt = now;
        pendingFire = false;
        this.fire();
        return;
      }
      if (pendingFire) return;
      pendingFire = true;
      setTimeout(() => {
        pendingFire = false;
        lastUiFireAt = Date.now();
        this.fire();
      }, 120);
    };

    const applyState = async (st: Awaited<ReturnType<IOlkilAiNodeService['clineGetState']>>) => {
      const status = olkilStatusLabel(st.status || '');
      if (status) {
        this.setStatus(status);
      }
      if (st.reasoning && st.reasoning !== lastReasoning) {
        lastReasoning = st.reasoning;
        if (!thinkingStarted) {
          thinkingStarted = true;
          this.pushActivity(pendingId, 'thinking', 'Thinking', undefined, false, {
            resultPreview: st.reasoning.slice(0, 800),
          });
          seenActivities.add('thinking_live');
        } else {
          for (let i = this.messages.length - 1; i >= 0; i--) {
            const m = this.messages[i];
            if (m.role === 'activity' && m.activity?.kind === 'thinking' && !m.activity.done) {
              m.activity = {
                ...m.activity,
                resultPreview: st.reasoning.slice(0, 800),
              };
              fireUiThrottled();
              break;
            }
          }
        }
      }
      if (st.text && st.text !== lastText) {
        lastText = st.text;
        if (!this.looksLikeGarbageToolDump(st.text)) {
          const painted = this.bubbleSafeContent(st.text);
          if (painted.trim().length > 0) {
            this.patchUi(pendingId, { content: painted, pending: true });
            fireUiThrottled();
          }
        }
      }
      for (const a of st.activities || []) {
        if (a.id === 'thinking_live') {
          continue;
        }
        if (!seenActivities.has(a.id)) {
          seenActivities.add(a.id);
          this.pushActivity(pendingId, a.kind, a.label, undefined, false, {
            filePath: a.filePath,
            command: a.command,
            argsPreview: a.argsPreview,
            toolCallId: a.id,
            groupId: a.groupId,
            parentId: a.parentId,
            lineRange: a.lineRange,
            filesExplored: a.filesExplored,
            searchCount: a.searchCount,
            resultPreview: a.resultPreview,
          });
        } else if (!a.done) {
          for (let i = this.messages.length - 1; i >= 0; i--) {
            const m = this.messages[i];
            if (m.role === 'activity' && m.activity?.toolCallId === a.id) {
              m.activity = {
                ...m.activity,
                label: a.label,
                resultPreview: a.resultPreview || m.activity.resultPreview,
                filesExplored: a.filesExplored ?? m.activity.filesExplored,
                searchCount: a.searchCount ?? m.activity.searchCount,
                lineRange: a.lineRange || m.activity.lineRange,
              };
              m.content = a.label;
              fireUiThrottled();
              break;
            }
          }
        }
        if (a.done && !finishedActivities.has(a.id)) {
          finishedActivities.add(a.id);
          this.completeActivityByToolId(a.id, a.label, {
            resultPreview: a.resultPreview,
            filesExplored: a.filesExplored,
            searchCount: a.searchCount,
            lineRange: a.lineRange,
          });
        }
      }
      for (const fc of st.fileChanges || []) {
        const fp = `${(fc.afterContent || '').length}:${(fc.afterContent || '').slice(0, 64)}`;
        if (fileChangeFingerprints.get(fc.path) === fp) {
          continue;
        }
        fileChangeFingerprints.set(fc.path, fp);
        try {
          await this.recordFileChange({
            kind: fc.kind,
            path: fc.path,
            beforeContent: fc.beforeContent,
            afterContent: fc.afterContent,
          });
          scheduleExplorerRefresh(fc.path);
          // Open only when the focus file changes — avoid editor thrash mid-thinking.
          if (fc.path !== lastOpenedEditPath) {
            lastOpenedEditPath = fc.path;
            void this.editorService.open(URI.file(fc.path)).catch(() => undefined);
          }
        } catch {
          // ignore card errors
        }
      }
    };

    try {
      while (!this.cancelRequested) {
        const st = await this.aiNode.clineGetState(runId);
        await applyState(st);
        if (st.done) {
          if (st.error && !st.text) {
            throw new Error(st.error);
          }
          return (st.text || lastText || '').trim();
        }
        const raced = await Promise.race([
          runPromise.then((r) => ({ kind: 'done' as const, r })),
          // 120ms: less IPC than 80ms while still feeling live.
          sleep(120).then(() => ({ kind: 'tick' as const, r: null })),
        ]);
        if (raced.kind === 'done') {
          await applyState(raced.r!);
          if (raced.r!.error && !raced.r!.text) {
            throw new Error(raced.r!.error);
          }
          return (raced.r!.text || lastText || '').trim();
        }
      }
      await this.aiNode.clineCancel(runId);
      return (lastText || '').trim() || 'Stopped.';
    } finally {
      if (explorerRefreshTimer) {
        clearTimeout(explorerRefreshTimer);
        explorerRefreshTimer = null;
      }
      if (touchedExplorerPaths.size > 0) {
        void this.refreshExplorerLive([...touchedExplorerPaths]);
        touchedExplorerPaths.clear();
      } else {
        void this.refreshExplorerLive([]);
      }
      this.activeClineRunId = null;
    }
  }

  private async runAgentLoop(pendingId: string): Promise<string> {
    const latestUser = [...this.history].reverse().find((m) => m.role === 'user')?.content || '';
    const liveTestIntent = this.liveTesting || this.isLiveTestIntent(latestUser);
    const needsImplementation =
      this.chatMode === 'agent' && this.requiresImplementation(latestUser);
    // Implement tasks are never Ask — "can you fix…?" must mutate
    const questionIntent = this.isQuestionIntent(latestUser) && !needsImplementation;
    const capabilityQuestion =
      questionIntent && this.isCapabilityQuestionIntent(latestUser);
    const flowQuestion =
      questionIntent && !capabilityQuestion && this.isFlowQuestionIntent(latestUser);
    // Keep in sync with cline-runtime maxIterations — large projects need many tool turns.
    const maxSteps = capabilityQuestion
      ? 12
      : flowQuestion
        ? 12
        : questionIntent
          ? 5
          : this.chatMode === 'ask'
            ? 24
            : this.chatMode === 'plan'
              ? 64
              : this.chatMode === 'agent'
                ? 200
                : 12;
    const active = this.editorService.currentResource?.uri.codeUri.fsPath;
    const casual = this.isCasualMessage(latestUser);

    // Auto checkpoint only when we may mutate files
    if (this.chatMode === 'agent' && !casual && needsImplementation) {
      this.createCheckpoint('Before turn');
    }

    const projectRules = this.getProjectRules();

    // Cursor Ask: wait for evidence pack (greps + file reads). Agent: soft-start faster.
    let repositoryContext = '';
    let candidatePaths: string[] = [];
    let researchInjected = false;
    let strongQuestionEvidence = false;
    let lateResearch: {
      context: string;
      candidates: string[];
      strongEvidence?: boolean;
    } | null = null;
    let researchPromise: Promise<{
      context: string;
      candidates: string[];
      strongEvidence?: boolean;
    }> | null = null;
    if (!casual && !liveTestIntent) {
      this.pushActivity(
        pendingId,
        'indexing',
        capabilityQuestion
          ? 'Finding enforcement rules…'
          : flowQuestion
            ? 'Tracing project flow…'
            : questionIntent
              ? 'Searching codebase…'
              : 'Scanning workspace…',
      );
      researchPromise = this.buildRepositoryContext(latestUser);
      researchPromise.then((r) => {
        lateResearch = r;
      }).catch(() => {
        lateResearch = { context: '', candidates: [] };
      });
      // Capability/Flow: wait for dossier. Fact Q: ~1.2s. Agent: soft-start.
      const softMs =
        capabilityQuestion || flowQuestion ? 3000 : questionIntent ? 1200 : 220;
      const soft = await Promise.race([
        researchPromise.then((r) => ({ ready: true as const, r })),
        sleep(softMs).then(() => ({ ready: false as const, r: null })),
      ]);
      if (soft.ready && soft.r) {
        repositoryContext = soft.r.context;
        candidatePaths = [...soft.r.candidates];
        strongQuestionEvidence = Boolean(soft.r.strongEvidence);
        researchInjected = true;
        lateResearch = soft.r;
        this.completeLastActivity(
          pendingId,
          candidatePaths.length
            ? questionIntent
              ? capabilityQuestion
                ? `Enforcement evidence · ${candidatePaths.length} files`
                : flowQuestion
                  ? `Flow dossier ready · ${candidatePaths.length} files`
                  : `Found ${candidatePaths.length} files · evidence ready`
              : `Found ${candidatePaths.length} likely targets`
            : 'Index ready — exploring with tools',
        );
      } else {
        this.setStatus(questionIntent ? 'Answering' : 'Thinking');
      }
    }

    const option = findModel(this.modelId);
    // Cline-style: keep more transcript turns so planning + tool context survives.
    const recentHistory = this.history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .filter((m) => !m.tool_calls?.length)
      .map((m) => ({
        role: m.role,
        content:
          typeof m.content === 'string' && m.content.length > 12_000
            ? `${m.content.slice(0, 12_000)}\n/* truncated */`
            : m.content,
      }))
      .slice(-14);

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: buildSystemPrompt(
          this.chatMode,
          this.workspaceRoot(),
          active,
          {
            provider: option.provider,
            model: option.model,
            label: option.label,
          },
          projectRules,
        ),
      },
      ...(repositoryContext
        ? [{ role: 'system' as const, content: repositoryContext }]
        : []),
      ...recentHistory,
    ];

    if (liveTestIntent && this.chatMode === 'agent') {
      const urlMatch = /https?:\/\/[^\s)'"`]+/i.exec(latestUser);
      const url = urlMatch?.[0] || '';
      // Wait briefly for Chromium bootstrap so the model gets a ready URL/snapshot hint.
      if (this.liveTestBootPromise) {
        try {
          await Promise.race([this.liveTestBootPromise, sleep(12_000)]);
        } catch {
          // continue — agent can still call live_test
        }
      }
      const boot = this.liveTestBootResult;
      const bootHint = boot
        ? `\nBootstrap result: ok=${boot.ok} url=${boot.url}` +
          (boot.notes?.length ? `\nNotes: ${boot.notes.join(' | ')}` : '') +
          (boot.error ? `\nError: ${boot.error}` : '') +
          `\nBrowser window should already be visible. Prefer browser_snapshot next (skip re-calling live_test unless bootstrap failed).`
        : `\nBootstrap still running or failed — call live_test headed=true once if needed.`;
      messages.push({
        role: 'system',
        content:
          `LIVE BROWSER TASK — prioritize tools now:\n` +
          `1) Call live_test${url ? ` with url=${url}` : ' (or browser_goto the URL the user gave)'} headed=true ONLY if browser is not open yet.\n` +
          `2) browser_snapshot → exercise the user goal with browser_click / browser_fill.\n` +
          `3) browser_console + browser_network for errors; fix code only if the UI fails.\n` +
          `Do NOT spend many rounds only reading backend helpers — open/use the browser first.` +
          bootHint,
      });
    }

    if (questionIntent) {
      messages.push({
        role: 'system',
        content: capabilityQuestion
          ? `CAPABILITY / BEHAVIOR QUESTION (Cursor-depth — NO GUESSING):\n` +
            `- User asks what someone CAN or CANNOT do after a status change (activate/deactivate/etc).\n` +
            `- Source of truth = Guard / middleware / validator that checks status — NOT the UI list screen.\n` +
            `- FORMAT like Cursor: short intro; ## What they cannot do; ## What they can still do; code fence for decisive if; ## Note.\n` +
            `- Prefer clean bullets (**Action** — reason + \`path\`). Well-formed GFM tables OK. No emoji headers.\n` +
            `- Quote the decisive condition (e.g. INACTIVE && NEW_TXN).\n` +
            `- Distinguish entity status vs user/login status — do NOT conflate them.\n` +
            `- NEVER invent statuses (e.g. DELETE) or claim login is blocked unless evidence shows it.\n` +
            `- If no Guard found yet: grep AccountStatusGuard / account_status / INACTIVE, read that file, THEN answer.\n` +
            `- CRITICAL: Final reply = user-facing answer ONLY. Never narrate tools, string=, list_dir, failures, or "let me try". No tooling caveats.\n` +
            `- No edits. No DSML/XML. No duplicate trailing text.`
          : flowQuestion
            ? `FLOW / ARCHITECTURE QUESTION (Cursor-depth accuracy):\n` +
              `- User wants the REAL project flow — not a generic guess.\n` +
              `- Use the FLOW DOSSIER above. Prefer trails + auto-read files.\n` +
              `- Answer as numbered steps: Entry → UI → Service → API → Backend.\n` +
              `- Cite a real path for EVERY step. If a layer is missing, say "not found in evidence".\n` +
              `- NEVER invent endpoints, modules, DB tables, or steps.\n` +
              `- If dossier is thin: 1–2 more tools (investigate_codepath / read_file along trail) then answer.\n` +
              `- No edits. No DSML/XML. Plain markdown for humans.`
            : `QUESTION TASK (Cursor Ask):\n` +
              `- User wants a clear ANSWER, not code changes.\n` +
              `- Evidence pack above already has greps + file contents when available.\n` +
              `- If evidence is enough → answer NOW in plain markdown (no tools).\n` +
              `- Else max 1–2 tools: grep / exact_code_search → read_file → ANSWER.\n` +
              `- Cite real paths. Do NOT invent facts not in evidence.\n` +
              `- NEVER call search_replace, write_file, create_file, update_todos, run_command.\n` +
              `- NEVER output DSML, XML, <invoke>, <parameter>, or fake toolcall text.\n` +
              `- Tools only via API tool_calls. Final reply = readable markdown for humans.`,
      });
    }

    // Greetings / chitchat: no tools, no edits, ignore prior task momentum
    if ((this.chatMode === 'agent' || this.chatMode === 'ask') && casual) {
      const lightHistory: ChatMessage[] = this.history
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .filter((m) => !m.tool_calls?.length)
        .map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' }))
        .slice(-6);
      const name = publicModelName(option);
      const isDazzlone = option.provider === 'poolside' || option.publicName === 'Dazzlone';
      const casualMessages: ChatMessage[] = [
        {
          role: 'system',
          content: isDazzlone
            ? `You are the coding agent inside the OLKIL IDE. Your selected model is Dazzlone. Reply in ONE short friendly sentence. If asked which model/AI you are, say Dazzlone. If asked which IDE/product this is, say OLKIL. Never say Laguna, Poolside, GPT-4, ChatGPT, or Claude. Do not edit files.`
            : `You are the coding agent inside the OLKIL IDE. Your selected model is ${name}. Reply in ONE short friendly sentence. If asked which model you are, say ${name}. If asked which IDE this is, say OLKIL. Never claim GPT-4/ChatGPT/Claude. Never say Laguna or Poolside. Do not edit files.`,
        },
        ...lightHistory,
      ];
      this.setStatus('Replying…');
      const result = await this.invokeCompletionResilient(pendingId, {
        messages: casualMessages,
        toolChoice: 'none',
        modelId: this.modelId,
        stream: true,
        maxTokens: 256,
      });
      return (result.content || '').trim() || 'Hey — what should we work on?';
    }

    let usedTools = false;
    let madeEdits = false;
    let editRejected = 0;
    let readCount = 0;
    let searchCount = 0;
    let researchNudges = 0;
    let implementNudges = 0;
    let rejectNudges = 0;
    let autoContinues = 0;
    let diagnosticsInjected = false;
    let lastChanceTools = false;
    const maxAutoContinues = 16;
    const maxResearchNudges = capabilityQuestion || flowQuestion ? 3 : questionIntent ? 2 : 4;
    const maxImplementNudges = needsImplementation ? 8 : 0;
    const maxRejectNudges = 6;
    const frontendOnly = this.isFrontendOnlyIntent(latestUser);
    const exploredPaths = new Set<string>(
      this.rankCandidatePaths(candidatePaths.slice(0, 12), latestUser).slice(0, 8),
    );
    if (active) {
      exploredPaths.add(normPath(active));
    }

    // Cursor speed: prefetch-read top targets so search_replace is not EDIT BLOCKED on round 1
    const hasSeedTargets =
      needsImplementation &&
      (Boolean(active) || candidatePaths.length > 0 || exploredPaths.size > 0);
    if (needsImplementation && hasSeedTargets) {
      const prefetchPaths = this.rankCandidatePaths(
        [...(active ? [active] : []), ...candidatePaths, ...exploredPaths],
        latestUser,
      ).slice(0, 2);
      const prefetched: string[] = [];
      for (const p of prefetchPaths) {
        try {
          const filePath = this.resolvePath(p);
          if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            continue;
          }
          const content = await this.readText(filePath);
          this.filesReadThisSession.add(normPath(filePath));
          readCount++;
          exploredPaths.add(normPath(filePath));
          const lines = content.split('\n');
          const end = Math.min(lines.length, 120);
          const slice = lines.slice(0, end).join('\n');
          prefetched.push(
            `FILE: ${filePath}\nLINES: 1-${end} of ${lines.length}\n\n${this.numberLines(slice, 1)}`,
          );
        } catch {
          // skip unreadable
        }
      }
      if (prefetched.length) {
        messages.push({
          role: 'system',
          content:
            `PREFETCHED TARGETS (already read — you MAY search_replace these immediately):\n\n` +
            prefetched.join('\n\n---\n\n').slice(0, 14_000),
        });
        this.pushActivity(
          pendingId,
          'reading',
          `Prefetched ${prefetched.length} target${prefetched.length > 1 ? 's' : ''} for edit`,
        );
      }
    }

    if (frontendOnly) {
      messages.push({
        role: 'system',
        content:
          'SCOPE LOCK: User requested FRONTEND ONLY. Do not open or edit backend/models/migrations/API files. ' +
          'Target *.html / *.ts component / *.scss under frontend. Pick the best UI match yourself — never ask which file.',
      });
    }

    const tryInjectLateResearch = () => {
      if (researchInjected || !lateResearch) {
        return;
      }
      researchInjected = true;
      repositoryContext = lateResearch.context;
      if (lateResearch.strongEvidence) strongQuestionEvidence = true;
      for (const p of this.rankCandidatePaths(lateResearch.candidates, latestUser)) {
        candidatePaths.push(p);
        exploredPaths.add(p);
      }
      if (lateResearch.context) {
        messages.splice(1, 0, { role: 'system', content: lateResearch.context });
        this.completeLastActivity(
          pendingId,
          lateResearch.candidates.length
            ? questionIntent
              ? `Evidence ready · ${lateResearch.candidates.length} files`
              : `Mapped ${lateResearch.candidates.length} module targets`
            : 'Workspace scan complete',
        );
      }
    };

    // One-shot only when evidence is truly strong (capability needs Guard/middleware).
    const canInstantAnswer =
      questionIntent &&
      !casual &&
      strongQuestionEvidence &&
      (capabilityQuestion
        ? this.hasEnforcementEvidence(candidatePaths, repositoryContext)
        : flowQuestion
          ? repositoryContext.includes('FLOW DOSSIER') || repositoryContext.length > 4000
          : true);
    if (canInstantAnswer) {
      tryInjectLateResearch();
      this.setStatus('Answering…');
      this.pushActivity(
        pendingId,
        'thinking',
        capabilityQuestion
          ? 'Writing grounded capability answer…'
          : flowQuestion
            ? 'Writing grounded flow answer…'
            : 'Writing answer…',
      );
      try {
        const instant = await this.invokeCompletionResilient(pendingId, {
          messages: [
            ...messages,
            {
              role: 'user',
              content: capabilityQuestion
                ? `Answer from the CAPABILITY DOSSIER only. Cursor-clean format:\n` +
                  `1) 2–3 sentence intro with the source file\n` +
                  `2) ## What they cannot do — bullets or a clean GFM table\n` +
                  `3) ## What they can still do — bullets\n` +
                  `4) Short \`\`\`js fence with the decisive if\n` +
                  `5) ## Note — status distinctions\n` +
                  `Output ONLY that answer in plain, friendly language a non-developer can skim. ` +
                  `No tool talk, no "string=", no "let me try", no tooling caveats, no duplicate ending.`
                : flowQuestion
                  ? `Write the accurate project FLOW now from the dossier only. ` +
                    `Numbered steps with a real path cited per step. Mark gaps as "not found in evidence". ` +
                    `No tools. No invention. No DSML/XML.`
                  : `Answer the question now using ONLY the evidence pack above. ` +
                    `Clear markdown. Bullet the allowed formats/fields if present. Cite paths. ` +
                    `No tools. No DSML/XML. Do not invent.`,
            },
          ],
          toolChoice: 'none',
          modelId: this.modelId,
          stream: true,
          maxTokens: capabilityQuestion || flowQuestion ? 1400 : 900,
        });
        const answer = this.stripGarbageToolDump((instant.content || '').trim());
        if (
          this.isValidFinalAnswer(answer, true) &&
          !this.looksLikeGarbageToolDump(answer) &&
          this.isGroundedAnswer(answer, candidatePaths, flowQuestion || capabilityQuestion) &&
          (!capabilityQuestion ||
            this.isCapabilityAnswerGrounded(answer, candidatePaths, repositoryContext))
        ) {
          this.setStatus('');
          return answer;
        }
        if (answer) {
          messages.push({ role: 'assistant', content: answer });
          messages.push({
            role: 'user',
            content: capabilityQuestion
              ? `That answer guessed from UI or conflated statuses. Find/read the AccountStatus Guard (or equivalent), ` +
                `then rewrite Cannot/Can tables citing only that enforcement code.`
              : flowQuestion
                ? `That answer was not grounded enough (missing real paths / invented steps). ` +
                  `Read 1–2 more files along the trail if needed, then rewrite a verified flow.`
                : `That reply was incomplete or ungrounded. Use 1 grep or read_file if needed, then give a complete markdown answer citing real paths.`,
          });
        }
      } catch {
        // fall through to tool loop
      }
    }

    for (let step = 0; step < maxSteps; step++) {
      if (this.cancelRequested) {
        return 'Stopped by user.';
      }

      tryInjectLateResearch();

      this.setStatus(
        liveTestIntent
          ? 'Testing'
          : step === 0
            ? this.chatMode === 'agent'
              ? 'Thinking'
              : this.chatMode === 'ask'
                ? 'Thinking'
                : 'Planning'
            : 'Thinking',
      );
      if (step === 0 && !liveTestIntent) {
        this.pushActivity(pendingId, 'thinking', 'Thinking');
      }

      const tools = selectAgentTools({
        mode: questionIntent ? 'ask' : this.chatMode,
        liveTest: liveTestIntent && !questionIntent,
        madeEdits,
        searchCount,
        readCount,
        hasSeedTargets: hasSeedTargets || exploredPaths.size > 0 || readCount > 0,
      });

      let result;
      try {
        // Capability: never force-answer until enforcement evidence or enough reads.
        const forceAnswer =
          questionIntent &&
          (capabilityQuestion
            ? (this.hasEnforcementEvidence(exploredPaths, repositoryContext) &&
                (readCount >= 1 || step >= 2)) ||
              step >= 4
            : readCount >= 1 ||
              searchCount >= 2 ||
              (step >= 1 && strongQuestionEvidence) ||
              step >= 3);
        result = await this.invokeCompletionResilient(pendingId, {
          messages,
          tools: forceAnswer ? undefined : tools,
          toolChoice: forceAnswer ? 'none' : 'auto',
          modelId: this.modelId,
          stream: true,
          maxTokens: questionIntent ? 900 : routingMaxTokens(step, madeEdits),
        });
      } catch (e: any) {
        // Transient API failures: auto-continue like Cursor (never dump "pick a file").
        if (
          this.isTransientLlmError(e) &&
          autoContinues < maxAutoContinues &&
          step < maxSteps - 1 &&
          !this.cancelRequested
        ) {
          autoContinues++;
          this.shrinkAgentMessages(messages, autoContinues);
          const top = this.rankCandidatePaths(exploredPaths, latestUser).slice(0, 4);
          const pathHint = top.length
            ? `Top targets to read+edit NOW:\n${top.map((p) => `- ${p}`).join('\n')}`
            : `Use exact_code_search on the user's UI labels, then read_file → search_replace.`;
          messages.push({
            role: 'user',
            content:
              `API hiccup — CONTINUE the same task. Do NOT restart. Do NOT ask which file. ` +
              `${pathHint}\n` +
              `Call tools only for remaining work. Keep final reply to 1–2 sentences after edits. ` +
              `Original: "${latestUser.slice(0, 280)}"`,
          });
          this.setStatus(`Auto-continuing (${autoContinues}/${maxAutoContinues})…`);
          this.pushActivity(
            pendingId,
            'info',
            `Provider hiccup — auto-continuing (${autoContinues}/${maxAutoContinues})`,
          );
          await sleep(350 + autoContinues * 120);
          continue;
        }
        if (madeEdits) {
          return this.fallbackSummary([...exploredPaths], latestUser);
        }
        // Still no edits — keep trying once more with forced non-stream path via continue budget
        if (autoContinues < maxAutoContinues && step < maxSteps - 1 && !this.cancelRequested) {
          autoContinues++;
          this.shrinkAgentMessages(messages, autoContinues + 2);
          messages.push({
            role: 'user',
            content: questionIntent
              ? `Provider error — recover and ANSWER now. Never ask continue/pick file. ` +
                `read_file top hit if needed, then answer. Request: "${latestUser.slice(0, 320)}"`
              : `Provider error — recover and FINISH with tools. Never ask the user to pick a file. ` +
                `read_file the best frontend HTML/TS hit → search_replace. Request: "${latestUser.slice(0, 320)}"`,
          });
          this.setStatus(`Recovering (${autoContinues})…`);
          await sleep(500);
          continue;
        }
        return await this.forceFinishWithoutAsking(
          pendingId,
          messages,
          exploredPaths,
          latestUser,
          questionIntent,
          { needsImplementation },
        );
      }

      if (this.cancelRequested) {
        return 'Stopped by user.';
      }

      let content = (result.content || '').trim();
      let toolCalls = result.tool_calls;

      // DeepSeek sometimes dumps tool calls as DSML/XML text instead of tool_calls[].
      // Recover those into real tools — never show the dump as the final answer.
      if ((!toolCalls || !toolCalls.length) && this.looksLikeGarbageToolDump(content)) {
        const recovered = this.parseEmbeddedToolCalls(content);
        if (recovered.length) {
          toolCalls = recovered;
          content = this.stripGarbageToolDump(content);
          this.setStatus('Recovering tools…');
        } else if (capabilityQuestion && step < maxSteps - 1) {
          // Empty DSML dumps → inject Cursor-style enforcement searches (never "string=")
          const entity =
            (latestUser.match(/\b(dealer|anchor|buyer|seller|oem|vendor|customer|partner)\b/i) || [])[0] ||
            'account';
          toolCalls = [
            {
              id: `auto_guard_${Date.now()}`,
              type: 'function',
              function: {
                name: 'grep',
                arguments: JSON.stringify({ query: 'AccountStatusGuard', maxResults: 20 }),
              },
            },
            {
              id: `auto_status_${Date.now()}`,
              type: 'function',
              function: {
                name: 'grep',
                arguments: JSON.stringify({
                  query: `${entity} account_status INACTIVE`,
                  maxResults: 20,
                }),
              },
            },
            {
              id: `auto_block_${Date.now()}`,
              type: 'function',
              function: {
                name: 'grep',
                arguments: JSON.stringify({ query: 'NEW_TXN', maxResults: 16 }),
              },
            },
          ];
          content = this.stripGarbageToolDump(content);
          this.setStatus('Searching enforcement rules…');
        }
      }

      if (toolCalls?.length) {
        usedTools = true;
        this.completeLastActivity(pendingId);
        // Clear any accidental DSML from the answer bubble while tools run (Cursor-style)
        this.patchUi(pendingId, { content: '', pending: true });
        const thoughtClean = this.bubbleSafeContent(content);
        if (thoughtClean && thoughtClean.length > 40) {
          this.pushActivity(pendingId, 'thinking', 'Thought', undefined, true, {
            resultPreview: thoughtClean.slice(0, 1200),
          });
        }
        messages.push({
          role: 'assistant',
          content: content || null,
          tool_calls: toolCalls,
        });

        const toolResults = await this.executeToolCallsParallel(pendingId, toolCalls);
        let rejectedThisRound = 0;
        const mutatedPathsThisRound: string[] = [];

        for (let i = 0; i < toolCalls.length; i++) {
          const call = toolCalls[i];
          const name = call.function?.name || '';
          const toolResult = toolResults[i] || '';
          if (
            name === 'read_file' ||
            name === 'get_active_file' ||
            name === 'related_files'
          ) {
            readCount++;
          }
          if (
            name === 'investigate_codepath' ||
            name === 'exact_code_search' ||
            name === 'goto_definition' ||
            name === 'find_references' ||
            name === 'find_module' ||
            name === 'repository_search' ||
            name === 'find_files' ||
            name === 'grep' ||
            name === 'repository_overview'
          ) {
            searchCount++;
          }
          this.collectExploredPaths(toolResult, exploredPaths);

          if (MUTATING_TOOL_NAMES.has(name)) {
            if (this.isSuccessfulMutation(toolResult)) {
              madeEdits = true;
              try {
                const a = call.function?.arguments
                  ? JSON.parse(call.function.arguments)
                  : {};
                const p = a.path || a.file_path || a.file;
                if (p) {
                  mutatedPathsThisRound.push(String(p));
                }
              } catch {
                // ignore
              }
            } else if (/EDIT (REJECTED|BLOCKED)|search_replace failed|failed:/i.test(toolResult)) {
              editRejected++;
              rejectedThisRound++;
            }
          }

          let toolPayload = toolResult;
          if (/EDIT (REJECTED|BLOCKED)/i.test(toolResult)) {
            toolPayload +=
              `\n\nACTION REQUIRED: The file was NOT changed. ` +
              `read_file the exact region again, fix the unbalanced/truncated code, then retry search_replace. ` +
              `Do NOT claim success. Do NOT invent a different approach that skips verification.`;
          }

          const toolCap = name === 'investigate_codepath' ? 10_000 : 4_000;
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content:
              toolPayload.length > toolCap
                ? `${toolPayload.slice(0, toolCap)}\n/* truncated */`
                : toolPayload,
          });
        }

        // Cursor-style: any rejected edit must be retried — even if earlier edits succeeded
        if (
          rejectedThisRound > 0 &&
          needsImplementation &&
          rejectNudges < maxRejectNudges &&
          step < maxSteps - 1
        ) {
          rejectNudges++;
          messages.push({
            role: 'user',
            content:
              `Your last edit(s) were REJECTED by the syntax/structure verifier — nothing was saved for those. ` +
              `Re-read the file region, write COMPLETE balanced code (every {([<> quote closed), ` +
              `and retry search_replace. Retry ${rejectNudges}/${maxRejectNudges}. Request: "${latestUser.slice(0, 320)}"`,
          });
          this.setStatus('Fixing rejected edit…');
          this.pushActivity(
            pendingId,
            'info',
            `Edit rejected — fixing syntax (${rejectNudges}/${maxRejectNudges})`,
          );
        }

        // Auto-inject diagnostics after successful mutations (Cursor verify step)
        if (
          madeEdits &&
          mutatedPathsThisRound.length > 0 &&
          !diagnosticsInjected &&
          needsImplementation &&
          step < maxSteps - 1
        ) {
          diagnosticsInjected = true;
          const pathHint = mutatedPathsThisRound[0];
          const diag = this.toolGetDiagnostics(pathHint, 'error', 30);
          messages.push({
            role: 'user',
            content:
              `POST-EDIT VERIFY (auto):\n${diag}\n` +
              `If these errors are from your edit, fix with search_replace now. ` +
              `Otherwise write a short 1–3 sentence summary + Suggested checks. Do not invent new scope.`,
          });
          this.pushActivity(pendingId, 'info', 'Checked diagnostics after edit');
        }
        continue;
      }

      const minimumReads = capabilityQuestion
        ? 2
        : flowQuestion
          ? 3
          : questionIntent
            ? 1
            : candidatePaths.length >= 4
              ? 2
              : 1;
      const needsResearch =
        !casual &&
        !madeEdits &&
        (questionIntent || this.chatMode === 'agent') &&
        this.isWorkRequest(latestUser) &&
        (readCount < minimumReads || searchCount + readCount < 1);

      const looksLost =
        !content ||
        this.looksLikePassiveOrFakeEdit(content, usedTools) ||
        this.looksLikeCannotFind(content) ||
        this.looksLikeAskUserToPickFile(content);

      // Force light research; for questions never push edits.
      if (needsResearch && researchNudges < maxResearchNudges && step < maxSteps - 1) {
        researchNudges++;
        if (content) {
          messages.push({ role: 'assistant', content });
        }
        const hintPaths = this.rankCandidatePaths(exploredPaths, latestUser).slice(0, 4);
        const pathHint = hintPaths.length
          ? `read_file these:\n${hintPaths.map((p) => `- ${p}`).join('\n')}`
          : `exact_code_search key nouns from the question, then read_file the top hit.`;
        messages.push({
          role: 'user',
          content: questionIntent
            ? `Need evidence. ${pathHint}\nThen ANSWER (docs/format/fields + paths). Do NOT edit. ${researchNudges}/${maxResearchNudges}.`
            : `Stop. You have not finished research. ${pathHint}\n` +
              `Then apply the requested changes with search_replace/write_file. ` +
              `Read at least ${minimumReads} evidence files. NEVER ask which file is correct. ` +
              `Retry ${researchNudges}/${maxResearchNudges}. Request: "${latestUser.slice(0, 400)}"`,
        });
        this.setStatus(questionIntent ? 'Checking code…' : 'Digging deeper…');
        this.pushActivity(
          pendingId,
          'searching',
          questionIntent
            ? `Gathering answer… (${researchNudges}/${maxResearchNudges})`
            : `Still researching… (${researchNudges}/${maxResearchNudges})`,
        );
        continue;
      }

      // Question answered after tools/reads → stop only if grounded.
      if (
        questionIntent &&
        this.isValidFinalAnswer(content, true) &&
        (usedTools ||
          readCount >= 1 ||
          searchCount >= 1 ||
          strongQuestionEvidence ||
          researchNudges >= maxResearchNudges ||
          step >= 1)
      ) {
        const grounded =
          this.isGroundedAnswer(content, exploredPaths, flowQuestion || capabilityQuestion) &&
          (!capabilityQuestion ||
            this.isCapabilityAnswerGrounded(content, exploredPaths, repositoryContext));
        if (grounded) {
          this.setStatus('');
          return content;
        }
        if (step < maxSteps - 1) {
          messages.push({ role: 'assistant', content });
          messages.push({
            role: 'user',
            content: capabilityQuestion
              ? `Rewrite with GROUNDED Cannot/Can tables from the Guard/middleware only. ` +
                `Do not invent login lockout or fake statuses. Enforcement paths:\n` +
                `${this.rankCandidatePaths(exploredPaths, latestUser)
                  .filter((p) => this.isEnforcementPath(p))
                  .slice(0, 6)
                  .map((p) => `- ${p}`)
                  .join('\n') ||
                  this.rankCandidatePaths(exploredPaths, latestUser)
                    .slice(0, 6)
                    .map((p) => `- ${p}`)
                    .join('\n')}`
              : flowQuestion
                ? `Rewrite with GROUNDED flow steps. Cite real paths from evidence for each step. ` +
                  `Do not invent. If unsure, say not found in evidence. Paths:\n` +
                  `${this.rankCandidatePaths(exploredPaths, latestUser)
                    .slice(0, 6)
                    .map((p) => `- ${p}`)
                    .join('\n')}`
                : `Rewrite citing real file paths from evidence. Do not invent.`,
          });
          this.setStatus('Improving answer…');
          continue;
        }
        this.setStatus('');
        return content;
      }

      // Model dumped broken tool XML as "answer" — force a clean prose reply.
      if (
        questionIntent &&
        content &&
        this.looksLikeGarbageToolDump(content) &&
        step < maxSteps - 1
      ) {
        messages.push({
          role: 'assistant',
          content: this.stripGarbageToolDump(content) || null,
        });
        messages.push({
          role: 'user',
          content:
            `STOP. You outputted broken tool XML/DSML — that is invalid. ` +
            `Answer in plain markdown NOW using evidence you already have. ` +
            `Be specific (formats, fields, paths). Never output toolcalls/invoke/DSML/XML.`,
        });
        this.setStatus('Writing answer…');
        try {
          const answer = await this.invokeCompletionResilient(pendingId, {
            messages,
            toolChoice: 'none',
            modelId: this.modelId,
            stream: true,
            maxTokens: 900,
          });
          const a = this.stripGarbageToolDump((answer.content || '').trim());
          if (this.isValidFinalAnswer(a, true)) {
            this.setStatus('');
            return a;
          }
        } catch {
          // continue loop
        }
        continue;
      }

      if (
        needsImplementation &&
        !madeEdits &&
        implementNudges < maxImplementNudges &&
        step < maxSteps - 1 &&
        (looksLost || readCount >= minimumReads || researchNudges >= maxResearchNudges)
      ) {
        implementNudges++;
        if (content) {
          messages.push({ role: 'assistant', content });
        }
        const top = this.rankCandidatePaths(exploredPaths, latestUser).slice(0, 4);
        const pick =
          top.length > 0
            ? `AUTO-PICK (do not ask user): read_file → search_replace on:\n${top.map((p) => `- ${p}`).join('\n')}`
            : `exact_code_search the UI labels → read_file best HTML/TS → search_replace.`;
        messages.push({
          role: 'user',
          content:
            `Do not stop and do NOT ask which file. Execute now. ${pick}\n` +
            `Investigation retry ${implementNudges}/${maxImplementNudges}. Request: "${latestUser.slice(0, 400)}"`,
        });
        this.setStatus('Agent working…');
        this.pushActivity(
          pendingId,
          'thinking',
          `Continuing work… (${implementNudges}/${maxImplementNudges})`,
        );
        continue;
      }

      // Never treat "please pick a file" / empty research dump as a completed agent turn.
      if (
        content &&
        (madeEdits || !needsImplementation || this.chatMode !== 'agent' || questionIntent)
      ) {
        if (
          needsImplementation &&
          !madeEdits &&
          implementNudges < maxImplementNudges &&
          step < maxSteps - 1
        ) {
          // Model tried to finish without edits — force one more implement round.
          implementNudges++;
          messages.push({ role: 'assistant', content });
          const top = this.rankCandidatePaths(exploredPaths, latestUser).slice(0, 3);
          messages.push({
            role: 'user',
            content:
              `You replied without a verified edit. That is incomplete. ` +
              `NOW: read_file + search_replace on ${top[0] || 'the best frontend match'}. ` +
              `Do not ask the user. Request: "${latestUser.slice(0, 320)}"`,
          });
          this.pushActivity(pendingId, 'thinking', `Forcing edit… (${implementNudges}/${maxImplementNudges})`);
          continue;
        }
        if (this.looksLikeAskUserToPickFile(content) || this.looksLikeGarbageToolDump(content)) {
          return await this.forceFinishWithoutAsking(
            pendingId,
            messages,
            exploredPaths,
            latestUser,
            questionIntent,
            { needsImplementation },
          );
        }
        if (!this.isValidFinalAnswer(content, questionIntent)) {
          // Incomplete / garbage — keep going if budget remains
          if (step < maxSteps - 1) {
            messages.push({ role: 'assistant', content });
            messages.push({
              role: 'user',
              content: questionIntent
                ? `That reply was incomplete or invalid. Answer clearly in markdown with formats + file paths. No tool XML.`
                : `That reply was incomplete. Continue with tools and finish the task. Never ask continue.`,
            });
            continue;
          }
          return await this.forceFinishWithoutAsking(
            pendingId,
            messages,
            exploredPaths,
            latestUser,
            questionIntent,
            { needsImplementation },
          );
        }
        this.setStatus('');
        return content;
      }

      if (usedTools || madeEdits) {
        if (
          !madeEdits &&
          needsImplementation &&
          implementNudges < maxImplementNudges &&
          step < maxSteps - 1
        ) {
          implementNudges++;
          const top = this.rankCandidatePaths(exploredPaths, latestUser).slice(0, 4);
          messages.push({
            role: 'user',
            content:
              `Tools ran but no verified edit landed. Finish now — do NOT ask which file. ` +
              `read_file → search_replace on:\n${(top.length ? top : ['(best frontend HTML/TS match)']).map((p) => `- ${p}`).join('\n')}\n` +
              `Request: "${latestUser.slice(0, 320)}"`,
          });
          this.pushActivity(
            pendingId,
            'thinking',
            `Finishing edit… (${implementNudges}/${maxImplementNudges})`,
          );
          continue;
        }
        if (questionIntent && !(content || '').trim()) {
          messages.push({
            role: 'user',
            content:
              'You have enough tool evidence. Answer NOW: required documents/formats/fields with file paths. No more tools.',
          });
          try {
            const answer = await this.invokeCompletionResilient(pendingId, {
              messages,
              toolChoice: 'none',
              modelId: this.modelId,
              stream: true,
              maxTokens: 700,
            });
            const a = (answer.content || '').trim();
            if (a) {
              this.setStatus('');
              return a;
            }
          } catch {
            // fall through
          }
        }
        this.setStatus(questionIntent ? 'Answering…' : 'Writing summary…');
        this.pushActivity(pendingId, 'thinking', questionIntent ? 'Writing answer…' : 'Writing summary…');
        this.patchUi(pendingId, { content: '', pending: true });
        messages.push({
          role: 'user',
          content: questionIntent
            ? 'Write the final answer now: required documents/formats/fields + file paths. No tools.'
            : 'Tools finished. Write a Cursor-style completion: (1) 1–3 sentences on what changed and why, ' +
              '(2) a short **Suggested checks** list (2–3 concrete steps). Do not call tools. Never reply empty.',
        });
        try {
          const summary = await this.invokeCompletionResilient(pendingId, {
            messages,
            toolChoice: 'none',
            modelId: this.modelId,
            stream: true,
            maxTokens: questionIntent ? 700 : 500,
          });
          const s = (summary.content || '').trim();
          if (s) {
            this.completeLastActivity(pendingId, 'Done', true);
            this.setStatus('');
            return s;
          }
        } catch {
          // Summary is optional once edits landed.
        }
        this.setStatus('');
        return this.fallbackSummary(this.rankCandidatePaths(exploredPaths, latestUser), latestUser);
      }

      // Prefer one more in-loop implement nudge before last-chance tools
      if (
        needsImplementation &&
        !madeEdits &&
        !lastChanceTools &&
        implementNudges < maxImplementNudges
      ) {
        lastChanceTools = true;
        implementNudges++;
        const top = this.rankCandidatePaths(exploredPaths, latestUser).slice(0, 4);
        messages.push({
          role: 'user',
          content:
            `FINAL TOOL ROUND — call read_file → search_replace NOW on:\n` +
            `${(top.length ? top : ['(best match)']).map((p) => `- ${p}`).join('\n')}\n` +
            `Do not narrate. Request: "${latestUser.slice(0, 320)}"`,
        });
        this.pushActivity(pendingId, 'thinking', 'Final edit attempt…');
        continue;
      }
      return await this.forceFinishWithoutAsking(
        pendingId,
        messages,
        exploredPaths,
        latestUser,
        questionIntent,
        { needsImplementation },
      );
    }

    return await this.forceFinishWithoutAsking(
      pendingId,
      messages,
      exploredPaths,
      latestUser,
      questionIntent,
      { needsImplementation },
    );
  }

  /**
   * Run consecutive read-only tools in parallel (Cursor-style). Mutations stay serial.
   * Results are returned in the original tool_call order.
   */
  private async executeToolCallsParallel(
    pendingId: string,
    toolCalls: ChatToolCall[],
  ): Promise<string[]> {
    const results: string[] = new Array(toolCalls.length).fill('');
    let i = 0;
    while (i < toolCalls.length) {
      if (this.cancelRequested) {
        break;
      }
      const name = toolCalls[i].function?.name || '';
      if (READONLY_TOOL_NAMES.has(name) && !MUTATING_TOOL_NAMES.has(name)) {
        const batch: number[] = [];
        while (
          i < toolCalls.length &&
          READONLY_TOOL_NAMES.has(toolCalls[i].function?.name || '') &&
          !MUTATING_TOOL_NAMES.has(toolCalls[i].function?.name || '')
        ) {
          batch.push(i);
          i++;
        }
        // Cap parallelism so we don't stampede the index/RPC layer
        const CONCURRENCY = 4;
        for (let b = 0; b < batch.length; b += CONCURRENCY) {
          const slice = batch.slice(b, b + CONCURRENCY);
          for (const idx of slice) {
            this.announceToolStart(pendingId, toolCalls[idx]);
          }
          const settled = await Promise.all(
            slice.map(async (idx) => {
              const r = await this.executeTool(toolCalls[idx]);
              return { idx, r };
            }),
          );
          for (const { idx, r } of settled) {
            results[idx] = r;
            this.announceToolDone(pendingId, toolCalls[idx], r);
          }
        }
      } else {
        this.announceToolStart(pendingId, toolCalls[i]);
        results[i] = await this.executeTool(toolCalls[i]);
        this.announceToolDone(pendingId, toolCalls[i], results[i]);
        i++;
      }
    }
    return results;
  }

  private announceToolStart(pendingId: string, call: ChatToolCall) {
    const { kind, label, detail, toolName, argsPreview, filePath, command } =
      this.describeToolCall(call);
    this.setStatus(label);
    this.pushActivity(pendingId, kind, label, detail, false, {
      toolName,
      argsPreview,
      filePath,
      command,
    });
  }

  private announceToolDone(pendingId: string, call: ChatToolCall, result: string) {
    const name = call.function?.name || '';
    const ok = !/EDIT (REJECTED|BLOCKED)|failed:|not found|error/i.test((result || '').slice(0, 200));
    let exitCode: number | null | undefined;
    let resultPreview = (result || '').slice(0, 2500);
    try {
      const parsed = JSON.parse(result);
      if (typeof parsed?.exitCode === 'number' || parsed?.exitCode === null) {
        exitCode = parsed.exitCode;
      }
      if (parsed?.stdout || parsed?.stderr) {
        const out = [parsed.stdout, parsed.stderr].filter(Boolean).join('\n').slice(0, 2500);
        if (out) {
          resultPreview = out;
        }
      }
      // Cursor-like: search expand shows top hits, not raw JSON wall
      if (Array.isArray(parsed?.matches) && parsed.matches.length) {
        resultPreview = parsed.matches
          .slice(0, 8)
          .map((m: any) => `${m.file || m.path || '?'}:${m.line || '?'}  ${(m.text || '').trim().slice(0, 100)}`)
          .join('\n');
      } else if (Array.isArray(parsed?.hits) && parsed.hits.length) {
        resultPreview = parsed.hits
          .slice(0, 8)
          .map((h: any) => `${h.path || '?'}  ${(h.excerpt || h.reason || '').toString().slice(0, 100)}`)
          .join('\n');
      }
    } catch {
      // plain text result
    }
    if (this.looksLikeGarbageToolDump(resultPreview)) {
      resultPreview = '';
    }
    this.completeLastActivity(pendingId, undefined, ok, {
      resultPreview: resultPreview.slice(0, 1800),
      exitCode: ok ? undefined : exitCode,
    });
  }

  /** Cursor past-tense activity labels when a step finishes. */
  private toPastActivityLabel(label: string): string {
    let l = (label || '').replace(/…/g, '').trim();
    if (!l) return l;
    l = l
      .replace(/^Thinking\b/i, 'Thought')
      .replace(/^Reading\b/i, 'Read')
      .replace(/^Exploring\b/i, 'Explored')
      .replace(/^Searching\b/i, 'Explored')
      .replace(/^Editing\b/i, 'Edited')
      .replace(/^Patching\b/i, 'Patched')
      .replace(/^Creating\b/i, 'Created')
      .replace(/^Writing\b/i, 'Wrote')
      .replace(/^Deleting\b/i, 'Deleted')
      .replace(/^Running\b/i, 'Ran')
      .replace(/^Updating\b/i, 'Updated')
      .replace(/^Finding\b/i, 'Found')
      .replace(/^Planning\b/i, 'Planned')
      .replace(/^Tracing\b/i, 'Traced')
      .replace(/^Gathering\b/i, 'Gathered')
      .replace(/^Listing\b/i, 'Listed')
      .replace(/^Resolving\b/i, 'Resolved')
      .replace(/^Following\b/i, 'Followed')
      .replace(/^Mapping\b/i, 'Mapped')
      .replace(/^Exact-searching\b/i, 'Exact-searched')
      .replace(/^Grepping\b/i, 'Grepped')
      .replace(/^Browsing\b/i, 'Browsed')
      .replace(/^Asking\b/i, 'Asked');
    return l;
  }

  private describeToolCall(call: ChatToolCall): {
    kind: ActivityKind;
    label: string;
    detail?: string;
    toolName: string;
    argsPreview?: string;
    filePath?: string;
    command?: string;
  } {
    const name = this.normalizeToolName(call.function?.name || '');
    if (call.function && name) {
      call.function.name = name;
    }
    let args: any = {};
    try {
      args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      args = {};
    }
    const pathHint = args.path || args.query || args.symbol || args.command || '';
    let short =
      typeof pathHint === 'string' && pathHint.trim().length >= 2
        ? pathHint.trim().slice(0, 72)
        : '';
    // Hide broken DeepSeek args like "string=" / "true" / empty
    if (
      !short ||
      /^(string|number|boolean|true|false|null|undefined)=?$/i.test(short) ||
      /^string=/i.test(short)
    ) {
      short = '';
    }
    let argsPreview: string | undefined;
    try {
      argsPreview = JSON.stringify(args, null, 2).slice(0, 1200);
    } catch {
      argsPreview = call.function?.arguments?.slice(0, 1200);
    }
    const filePath =
      typeof args.path === 'string'
        ? args.path
        : typeof args.new_path === 'string'
          ? args.new_path
          : undefined;
    const command = typeof args.command === 'string' ? args.command : undefined;

    const base = { toolName: name, argsPreview, filePath, command };

    switch (name) {
      case 'update_todos':
        return { ...base, kind: 'todo', label: 'Updating todos…', detail: `${(args.todos || []).length || 0} items` };
      case 'read_file':
      case 'get_active_file':
        return {
          ...base,
          kind: 'reading',
          label: short ? `Reading ${short}` : 'Reading file…',
          detail: short,
        };
      case 'grep':
      case 'exact_code_search':
      case 'find_files':
      case 'find_module':
      case 'repository_search':
      case 'goto_definition':
      case 'find_references':
      case 'investigate_codepath':
      case 'repository_overview':
      case 'related_files':
        return {
          ...base,
          kind: 'searching',
          label: short
            ? name === 'grep' || name === 'exact_code_search'
              ? `Searching \`${short}\``
              : `Searching ${short}`
            : 'Searching codebase…',
          detail: short || undefined,
          argsPreview: short ? argsPreview : undefined,
        };
      case 'search_replace':
      case 'write_file':
      case 'create_file':
      case 'rename_file':
      case 'delete_file':
        return {
          ...base,
          kind: 'editing',
          label: short ? `Editing ${short}` : `Applying ${name}…`,
          detail: short,
        };
      case 'run_command':
      case 'get_command_output':
      case 'stop_command':
      case 'detect_dev_server':
        return {
          ...base,
          kind: 'running',
          label: short ? `$ ${short}` : 'Running command…',
          detail: short,
        };
      case 'live_test':
      case 'browser_launch':
      case 'browser_goto':
      case 'browser_reload':
      case 'browser_snapshot':
      case 'browser_click':
      case 'browser_fill':
      case 'browser_upload':
      case 'browser_type':
      case 'browser_press':
      case 'browser_console':
      case 'browser_network':
      case 'browser_devtools':
      case 'browser_screenshot':
      case 'browser_close':
        return {
          ...base,
          kind: 'browsing',
          label: `Browser: ${name.replace(/^browser_/, '')}`,
          detail: short,
        };
      default:
        return { ...base, kind: 'info', label: name || 'Working…', detail: short };
    }
  }

  /** Insert an activity row BEFORE the pending assistant bubble (Cursor timeline order). */
  private pushActivity(
    pendingId: string,
    kind: ActivityKind,
    label: string,
    detail?: string,
    done = false,
    extra?: Partial<ActivityInfo>,
  ) {
    const activity: ActivityInfo = { kind, label, detail, done, ...extra };
    const msg: UiChatMessage = {
      id: nextId(),
      role: 'activity',
      content: label,
      activity,
    };
    this.insertBeforePending(pendingId, msg);
  }

  private completeLastActivity(
    pendingId: string,
    label?: string,
    done = true,
    extra?: Partial<ActivityInfo>,
  ) {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.id === pendingId) {
        continue;
      }
      if (m.role === 'activity' && m.activity && !m.activity.done) {
        const nextLabel = label || (done ? this.toPastActivityLabel(m.activity.label) : m.activity.label);
        m.activity = {
          ...m.activity,
          ...extra,
          done,
          label: nextLabel,
        };
        m.content = m.activity.label;
        this.fire();
        return;
      }
      if (m.role === 'user') {
        return;
      }
    }
  }

  private completeActivityByToolId(
    toolCallId: string,
    label?: string,
    extra?: Partial<ActivityInfo>,
  ) {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === 'activity' && m.activity && !m.activity.done && m.activity.toolCallId === toolCallId) {
        const nextLabel = label || this.toPastActivityLabel(m.activity.label);
        m.activity = {
          ...m.activity,
          ...extra,
          done: true,
          label: nextLabel,
        };
        m.content = m.activity.label;
        this.fire();
        return;
      }
    }
    // Fallback: complete the latest live activity
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === 'activity' && m.activity && !m.activity.done) {
        const nextLabel = label || this.toPastActivityLabel(m.activity.label);
        m.activity = {
          ...m.activity,
          ...extra,
          done: true,
          label: nextLabel,
        };
        m.content = m.activity.label;
        this.fire();
        return;
      }
    }
  }

  private insertBeforePending(pendingId: string, msg: UiChatMessage) {
    const idx = this.messages.findIndex((m) => m.id === pendingId);
    if (idx >= 0) {
      this.messages.splice(idx, 0, msg);
    } else {
      this.messages.push(msg);
    }
    if (this.messages.length > 160) {
      // Prefer dropping old activity rows, keep file cards + recent chat
      const keep: UiChatMessage[] = [];
      for (const m of this.messages) {
        if (keep.length < 140 || m.role !== 'activity' || !m.activity?.done) {
          keep.push(m);
        }
      }
      this.messages = keep.slice(-140);
    }
    this.fire();
  }

  private collectExploredPaths(toolResult: string, into: Set<string>) {
    try {
      const parsed = JSON.parse(toolResult);
      const hits =
        parsed?.evidence ||
        parsed?.hits ||
        parsed?.files ||
        parsed?.matches ||
        parsed?.results;
      if (Array.isArray(hits)) {
        for (const hit of hits.slice(0, 16)) {
          const p =
            typeof hit === 'string'
              ? hit
              : hit?.path || hit?.file || hit?.filename || hit?.uri;
          if (typeof p === 'string' && p.trim()) into.add(p.replace(/\\/g, '/'));
        }
      }
      if (typeof parsed?.path === 'string') {
        into.add(parsed.path.replace(/\\/g, '/'));
      }
      if (typeof parsed?.file === 'string') {
        into.add(parsed.file.replace(/\\/g, '/'));
      }
    } catch {
      const fileMatch = /^FILE:\s*(.+)$/m.exec(toolResult);
      if (fileMatch?.[1]) {
        into.add(fileMatch[1].trim().replace(/\\/g, '/'));
      }
    }
  }

  private looksLikeAskUserToPickFile(content: string): boolean {
    const lower = (content || '').toLowerCase();
    return (
      /tell me which (one|file|path|target)/i.test(lower) ||
      /which (one|file|path).{0,40}(correct|should i|do you mean)/i.test(lower) ||
      /could not finish a verified edit/i.test(lower) ||
      /likely targets but could not/i.test(lower) ||
      /rephrase the change/i.test(lower) ||
      /send\s*\*?\*?continue\*?\*?/i.test(lower) ||
      /narrowed it to these files/i.test(lower)
    );
  }

  /** DeepSeek/etc sometimes emit tool XML/DSML into content instead of tool_calls. */
  /** DeepSeek/etc sometimes emit tool XML/DSML into content instead of tool_calls. */
  private looksLikeGarbageToolDump(content: string): boolean {
    const t = content || '';
    if (!t.trim()) return false;
    return (
      /DSML/i.test(t) ||
      /tool[_]?calls/i.test(t) ||
      /<\/?invoke\b/i.test(t) ||
      /\binvoke\s+name=/i.test(t) ||
      /parameter\s+name=/i.test(t) ||
      /\|+DSML\|+/i.test(t) ||
      /｜+DSML｜+/i.test(t) || // fullwidth pipes DeepSeek uses
      /<\|[^|>]*tool[^|>]*\|>/i.test(t) ||
      /```(?:xml|tool)?\s*<invoke/i.test(t) ||
      (/name=["']grep["']|name=["']read_file["']|name=["']exact_code_search["']/i.test(t) &&
        /parameter|invoke|toolcall/i.test(t))
    );
  }

  private stripGarbageToolDump(content: string): string {
    let t = content || '';
    t = t.replace(/<\|[^|>]*\|>/g, '');
    t = t.replace(/｜+[^｜\n]*｜+/g, ''); // fullwidth DSML markers
    t = t.replace(/<\/?DSML[^>]*>/gi, '');
    t = t.replace(/<\/?tool[_]?calls?>/gi, '');
    t = t.replace(/<invoke[\s\S]*?<\/invoke>/gi, '');
    t = t.replace(/<\/?parameter[^>]*>[\s\S]*?<\/parameter>/gi, '');
    t = t.replace(/\|+DSML\|+/gi, '');
    t = t.replace(/tool[_]?calls/gi, '');
    t = t.replace(/\binvoke\s+name=["'][^"']+["'][^\n]*/gi, '');
    return t.replace(/\n{3,}/g, '\n\n').trim();
  }

  /** Safe text for the assistant bubble — never DSML / tool XML. */
  private bubbleSafeContent(text: string): string {
    const raw = text || '';
    if (this.looksLikeGarbageToolDump(raw)) {
      const cleaned = this.stripGarbageToolDump(raw);
      if (!cleaned || this.looksLikeGarbageToolDump(cleaned) || cleaned.length < 24) {
        return '';
      }
      return this.formatAnswerForUi(cleaned);
    }
    return this.formatAnswerForUi(raw);
  }

  /** Best-effort parse of DSML/XML-ish tool dumps into OpenAI tool_calls. */
  private parseEmbeddedToolCalls(content: string): ChatToolCall[] {
    const out: ChatToolCall[] = [];
    const text = content || '';
    const isUsefulArgs = (name: string, args: Record<string, unknown>): boolean => {
      if (name === 'grep' || name === 'exact_code_search' || name === 'find_files' || name === 'find_module') {
        const q = String(args.query || args.pattern || '').trim();
        return q.length >= 2;
      }
      if (name === 'read_file') {
        return String(args.path || '').trim().length >= 2;
      }
      return Object.keys(args).length > 0;
    };
    // <invoke name="grep"> ... <parameter name="query">...</parameter>
    const invokeRe = /<invoke\b[^>]*\bname=["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke>/gi;
    let m: RegExpExecArray | null;
    while ((m = invokeRe.exec(text)) && out.length < 8) {
      const name = this.normalizeToolName(m[1] || '');
      if (!name) continue;
      const body = m[2] || '';
      const args: Record<string, unknown> = {};
      const paramRe = /<parameter\b[^>]*\bname=["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
      let p: RegExpExecArray | null;
      while ((p = paramRe.exec(body))) {
        const key = String(p[1] || '').trim();
        const rawVal = String(p[2] || '').trim();
        if (!key || !rawVal) continue;
        const mapped =
          key.toLowerCase() === 'maxresults'
            ? 'maxResults'
            : key.toLowerCase() === 'filepath'
              ? 'path'
              : key;
        const num = Number(rawVal);
        args[mapped] = Number.isFinite(num) && /^-?\d+(\.\d+)?$/.test(rawVal) ? num : rawVal;
      }
      if (!isUsefulArgs(name, args)) continue;
      out.push({
        id: `recovered_${out.length}_${Date.now()}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      });
    }
    // Fallback: name="grep" with query=/path= nearby
    if (!out.length) {
      const loose = /name=["'](grep|read_file|exact_code_search|find_files)["']([\s\S]{0,500})/gi;
      let lm: RegExpExecArray | null;
      while ((lm = loose.exec(text)) && out.length < 4) {
        const name = this.normalizeToolName(lm[1]);
        const chunk = lm[2] || '';
        const args: Record<string, unknown> = {};
        const q = /(?:query|pattern)["'\s:=]+([^"'<\n]+)/i.exec(chunk);
        const pathM = /(?:path|file)["'\s:=]+([^"'<\n]+)/i.exec(chunk);
        if (q && q[1].trim().length >= 2) args.query = q[1].trim();
        if (pathM && pathM[1].trim().length >= 2) args.path = pathM[1].trim();
        if (!isUsefulArgs(name, args)) continue;
        out.push({
          id: `recovered_loose_${out.length}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        });
      }
    }
    return out;
  }

  private isValidFinalAnswer(content: string, questionIntent: boolean): boolean {
    const t = this.formatAnswerForUi(content || '');
    if (t.length < 40) return false;
    if (this.looksLikeAskUserToPickFile(t)) return false;
    if (this.looksLikeGarbageToolDump(t)) return false;
    if (this.looksLikeAgentMonologue(t.split(/\n{2,}/)[0] || '')) return false;
    if (/^(let me |i'll |i will |looking |searching |i need to |i'll check|the tool )/i.test(t) && t.length < 200) {
      return false;
    }
    if (questionIntent) {
      // Real answer: substance + structure, not "let me look…"
      return (
        t.length >= 100 ||
        (t.length >= 60 &&
          (/\b(pdf|docx?|xlsx?|csv|png|jpg|jpeg|accept|\.pdf|format|allowed|document|required|field)\b/i.test(
            t,
          ) ||
            /[•\-*]\s+\S+/.test(t) ||
            /`[^`]+`/.test(t) ||
            /\.(html|ts|tsx|js|scss)\b/i.test(t)))
      );
    }
    return true;
  }

  /**
   * Cursor-level grounding: answers must cite real workspace paths from evidence.
   * Flow/capability answers need ≥2 path citations; fact answers need ≥1 when candidates exist.
   */
  private isGroundedAnswer(
    content: string,
    candidates: Iterable<string>,
    deepQuestion: boolean,
  ): boolean {
    const text = content || '';
    if (!text.trim()) return false;
    const cand = [...candidates].map((p) => p.replace(/\\/g, '/'));
    if (!cand.length) {
      if (!deepQuestion) return true;
      return /[`/][\w.-]+\/[\w./-]+\.\w{1,5}/.test(text);
    }
    const lower = text.toLowerCase().replace(/\\/g, '/');
    let hits = 0;
    for (const p of cand.slice(0, 20)) {
      const base = p.split('/').pop() || '';
      if (p.length >= 8 && lower.includes(p.toLowerCase())) {
        hits += 1;
        continue;
      }
      if (base.length >= 6 && lower.includes(base.toLowerCase())) {
        hits += 1;
      }
    }
    const pathMentions = (text.match(/[\w.-]+\/[\w./-]+\.\w{1,5}/g) || []).length;
    if (deepQuestion) {
      return hits >= 2 || (hits >= 1 && pathMentions >= 2) || pathMentions >= 3;
    }
    return hits >= 1 || pathMentions >= 1 || text.length >= 200;
  }

  /** Capability answers must cite enforcement code and not invent full lockout without evidence. */
  private isCapabilityAnswerGrounded(
    content: string,
    candidates: Iterable<string>,
    context = '',
  ): boolean {
    const text = content || '';
    const lower = text.toLowerCase();
    const cand = [...candidates];
    const citesEnforce =
      cand.some((p) => this.isEnforcementPath(p) && lower.includes((p.split(/[/\\]/).pop() || '').toLowerCase())) ||
      /guard|middleware|validator|account_status|new_txn|block_messages/i.test(text);
    if (!citesEnforce && this.hasEnforcementEvidence(cand, context)) {
      return false;
    }
    // Reject common hallucination: claims cannot login when evidence has no auth+status link
    const claimsLoginBlock =
      /\b(cannot|can't|unable to)\s+(log\s*in|login|sign\s*in)\b/i.test(text) ||
      /\blogin\s*\/\s*access blocked\b/i.test(text) ||
      /\blocked out of the (entire )?system\b/i.test(text);
    if (claimsLoginBlock) {
      const evidence = `${context}\n${cand.join('\n')}`.toLowerCase();
      const loginEnforced =
        /login.*inactive|inactive.*login|isac_status|auth.*account_status|account_status.*auth/i.test(
          evidence,
        );
      if (!loginEnforced) return false;
    }
    // Invented DELETE status without evidence
    if (/\bDELETE\b/.test(text) && !/\bDELETE\b/.test(context) && !cand.some((p) => /delete/i.test(p))) {
      // soft: only fail if they present DELETE as a status enum
      if (/status.*DELETE|DELETE\s*→|DELETE\s*—/i.test(text) && !/DELETE/.test(context)) {
        return false;
      }
    }
    return citesEnforce || /cannot do|can still do|blocked|allowed/i.test(text);
  }

  private looksLikeCannotFind(content: string): boolean {
    const lower = (content || '').toLowerCase();
    return /\b(could not|couldn't|cannot|can't|unable to)\b.{0,40}\b(find|locate|verify)\b/.test(lower)
      || /\bno (such )?(module|file|folder)\b/.test(lower)
      || /\bnot found\b/.test(lower)
      || /\bcould not verify a concrete change\b/.test(lower);
  }

  /** 500/502/503/429/network — worth auto-retry / auto-continue. */
  private isTransientLlmError(err: any): boolean {
    const msg = String(err?.message || err || '').toLowerCase();
    return (
      /\b(500|502|503|504|429)\b/.test(msg) ||
      /internal server error|bad gateway|service unavailable|gateway timeout|too many requests|rate limit|econnreset|etimedout|enotfound|network|fetch failed|socket hang up|temporarily unavailable|overloaded|capacity|timeout|timed out|invalid.*json|unexpected end|premature close|deepseek api/.test(
        msg,
      )
    );
  }

  /** Shrink in-flight agent context so the next Poolside call is less likely to 500. */
  private shrinkAgentMessages(messages: ChatMessage[], intensity = 1) {
    const toolCap = intensity >= 3 ? 1500 : intensity >= 2 ? 2500 : 4000;
    const otherCap = intensity >= 3 ? 3000 : 6000;
    for (const m of messages) {
      if (typeof m.content !== 'string') {
        continue;
      }
      const cap = m.role === 'tool' ? toolCap : otherCap;
      if (m.content.length > cap) {
        m.content = `${m.content.slice(0, cap)}\n/* trimmed for retry */`;
      }
    }
    if (messages.length > 16) {
      const head = messages[0];
      const tail = messages.slice(-(intensity >= 3 ? 8 : 12));
      messages.splice(0, messages.length, head, ...tail.filter((m) => m !== head));
    }
  }

  private cloneAndShrinkMessages(messages: ChatMessage[], attempt: number): ChatMessage[] {
    const cloned = messages.map((m) => ({
      ...m,
      content: m.content,
      tool_calls: m.tool_calls,
    }));
    this.shrinkAgentMessages(cloned, attempt);
    return cloned;
  }

  /**
   * Retries transient provider failures (esp. Poolside 500) with backoff +
   * smaller payloads before giving up.
   */
  private async invokeCompletionResilient(
    pendingId: string,
    request: {
      messages: ChatMessage[];
      tools?: typeof AGENT_TOOLS;
      toolChoice?: 'auto' | 'none';
      modelId: string;
      stream: boolean;
      maxTokens?: number;
    },
  ) {
    const maxAttempts = 4;
    let lastErr: any;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.cancelRequested) {
        throw new Error('Stopped by user.');
      }
      try {
        const req =
          attempt === 1
            ? request
            : {
                ...request,
                // Keep enough room for tool calls + patches on retry (don't starve DeepSeek).
                maxTokens: Math.min(request.maxTokens || 2200, attempt >= 3 ? 1600 : 2000),
                messages: this.cloneAndShrinkMessages(request.messages, attempt),
                stream: false as const,
              };
        if (attempt > 1) {
          this.setStatus(`Retrying AI (${attempt}/${maxAttempts})…`);
          this.pushActivity(
            pendingId,
            'info',
            `Provider hiccup — retrying ${attempt}/${maxAttempts}`,
          );
          await sleep(350 * attempt + Math.floor(Math.random() * 250));
        }
        return await this.invokeCompletion(pendingId, req);
      } catch (e: any) {
        lastErr = e;
        if (!this.isTransientLlmError(e) || attempt === maxAttempts) {
          throw e;
        }
      }
    }
    throw lastErr;
  }

  /** Hi / thanks / ok — not a coding task. */
  private isCasualMessage(text: string): boolean {
    const t = (text || '').trim().toLowerCase();
    if (!t || t.length > 48) {
      return false;
    }
    if (this.isWorkRequest(t)) {
      return false;
    }
    return /^(hi|hii+|hello|hey|yo|sup|hola|namaste|thanks|thank you|thx|ok|okay|oky|hmm+|yes|yep|no|nope|cool|nice|great|bye|good morning|good evening|gm|gn)[\s!.?]*$/i.test(
      t,
    );
  }

  /** Coding / file work — used to distinguish chitchat from real tasks. */
  private isWorkRequest(text: string): boolean {
    const t = (text || '').toLowerCase();
    if (t.length < 2) {
      return false;
    }
    if (this.isQuestionIntent(t)) {
      return true; // research/answer still counts as work for research nudges
    }
    return /\b(fix|edit|change|update|rename|create|add|remove|delete|seo|keyword|meta|title|refactor|bug|error|implement|build|make|write|patch|file|code|css|html|js|ts|react|project|folder|readme|feature|module|timeline|analyze|analyse|understand|inspect|investigate|architecture|performance|optimize|banao|bana|karo|karna|likho|badlo|samjho|samajh|dekho|hatana|hatao)\b/i.test(
      t,
    );
  }

  /** Cursor Ask-class: pure Q&A — NOT "can you fix/add/update…". */
  private isQuestionIntent(text: string): boolean {
    const raw = String(text || '');
    const t = raw.toLowerCase();
    if (!t.trim()) return false;
    // Imperative coding wins — even with a trailing "?"
    if (
      /\b(fix|add|create|implement|build|update|edit|change|remove|delete|refactor|patch|banao|badlo|hatao|likh|karo|karna)\b/i.test(
        t,
      ) &&
      !/\b(which|what|konsa|kaunsa|document format|required docs?|allowed formats?)\b/i.test(t)
    ) {
      // "what should I fix" is still a question; "fix the title" is work
      if (!/\b(what|which|konsa|kaunsa|kya|batao|samjhao|explain|describe)\b/i.test(t)) {
        return false;
      }
      if (
        /\b(can you|could you|please|pls|kindly)\b/i.test(t) &&
        /\b(fix|add|update|create|implement|change|edit)\b/i.test(t)
      ) {
        return false;
      }
    }
    if (
      /\b(please (fix|add|create|implement|build)|banao|badlo|hatao|likh do|add karo|fix karo|implement karo|update karo)\b/i.test(
        t,
      )
    ) {
      return false;
    }
    if (/\?/.test(raw)) {
      // "?" alone with implement verbs → still work
      if (/\b(fix|add|update|create|implement|change|edit|banao|karo)\b/i.test(t)) {
        return false;
      }
      return true;
    }
    if (
      /\b(what|which|where|how|why|when|who|explain|describe|list|tell me|show me|does|is there|are there|konsa|kaunsa|kya|kahan|kahaan|kaise|kyu|kyun|batao|batana|samjhao|kitne|kitna|lagta|chahiye|required|needed|format)\b/i.test(
        t,
      )
    ) {
      if (
        /\b(how (do i|to|can i)|kaise)\b/i.test(t) &&
        /\b(fix|add|create|implement|build|banao)\b/i.test(t) &&
        !/\b(which|what|konsa|document|docs?|format|required|needed|lagta|field|upload)\b/i.test(t)
      ) {
        return false;
      }
      return true;
    }
    return false;
  }

  private requiresImplementation(text: string): boolean {
    const t = (text || '').toLowerCase();
    // Coding verbs always mean implement — even if also phrased as a question
    if (
      /\b(fix|change|update|edit|add|remove|delete|create|implement|build|make|patch|refactor|optimi[sz]e|not working|broken|bug|error|issue|problem|karo|karna|banao|badlo|hatao|likh)\b/i.test(
        t,
      )
    ) {
      // Pure "what is the bug" / "which error" without asking to fix
      if (
        this.isQuestionIntent(text) &&
        !/\b(fix|add|update|create|implement|change|edit|banao|karo|please fix|can you fix)\b/i.test(t)
      ) {
        return false;
      }
      return true;
    }
    return false;
  }

  /** True when the model is stalling (asks permission) or claims edits without tools. */
  private isSuccessfulMutation(toolResult: string): boolean {
    const text = (toolResult || '').trim();
    if (!text) return false;
    if (/EDIT (REJECTED|BLOCKED)|search_replace failed|failed:|is required|not found|BLOCKED/i.test(text)) {
      return false;
    }
    if (text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text);
        return parsed?.ok === true;
      } catch {
        // fall through to prefix checks
      }
    }
    return /^(Created |Wrote |Deleted |Renamed )/i.test(text) || /\b"ok"\s*:\s*true\b/.test(text);
  }

  private looksLikePassiveOrFakeEdit(content: string, usedTools: boolean): boolean {
    const lower = content.toLowerCase();
    const asks =
      /let me know|would you like|should i proceed|if you'?d like|confirm|shall i|want me to proceed/.test(
        lower,
      );
    const claimsEdit =
      /\b(updated|changed|fixed|improved|edited|modified)\b/.test(lower) &&
      /\b(keyword|seo|title|meta|file|project)\b/.test(lower);
    if (asks) {
      return true;
    }
    if (claimsEdit && !usedTools) {
      return true;
    }
    if (!usedTools && /\b(i('ll| will)|going to|let me (explore|check|start))\b/.test(lower) && !/\b(hi|hello|hey)\b/.test(lower)) {
      return true;
    }
    if (
      !usedTools &&
      /\b(no (file )?edits? (were|are) needed|no changes? (were|are) needed|nothing (to|needs to) change|workspace (was|is) checked)\b/.test(
        lower,
      )
    ) {
      return true;
    }
    return false;
  }

  /**
   * Non-stream for tool rounds; SSE stream only for final prose (toolChoice none).
   */
  private async invokeCompletion(
    pendingId: string,
    request: {
      messages: ChatMessage[];
      tools?: typeof AGENT_TOOLS;
      toolChoice?: 'auto' | 'none';
      modelId: string;
      stream: boolean;
      maxTokens?: number;
    },
  ) {
    if (!request.stream) {
      return this.aiNode.chatCompletion({
        messages: request.messages,
        tools: request.tools,
        toolChoice: request.toolChoice,
        modelId: request.modelId,
        stream: false,
        maxTokens: request.maxTokens,
      });
    }

    const streamId = nextId();
    let stopPoll = false;
    const announcedTools = new Set<string>();
    const poll = (async () => {
      let last = '';
      while (!stopPoll && !this.cancelRequested) {
        try {
          const state = await this.aiNode.getStreamState(streamId);
          if (state.error) {
            break;
          }
          if (state.text && state.text !== last) {
            last = state.text;
            const prose = state.text.trim();
            // Live final answer into the assistant bubble — NEVER paint DSML / tool XML.
            if (this.looksLikeGarbageToolDump(state.text)) {
              this.setStatus('Thinking');
            } else {
              const painted = this.bubbleSafeContent(state.text);
              // Cursor: during tool rounds, NEVER paint into the answer bubble — activity only.
              if (request.tools?.length && request.toolChoice === 'auto') {
                if (painted.trim().length > 8) {
                  this.setStatus('Thinking');
                }
              } else if (!painted) {
                this.setStatus('Writing');
              } else {
                this.patchUi(pendingId, { content: painted, pending: true });
                if (painted.trim().length > 8) {
                  this.setStatus('Writing');
                  this.completeLastActivity(pendingId, undefined, true);
                }
              }
            }
          }
          if (state.toolNames?.length) {
            for (const raw of state.toolNames) {
              const name = this.normalizeToolName(raw);
              if (name && !announcedTools.has(name)) {
                announcedTools.add(name);
                // Cursor: status only — don't spam "Planning grep…" into the timeline
                this.setStatus(`Planning ${name}…`);
              }
            }
          }
          if (state.done) {
            break;
          }
        } catch {
          break;
        }
        await sleep(20);
      }
    })();

    try {
      const result = await this.aiNode.chatCompletion({
        messages: request.messages,
        tools: request.tools,
        toolChoice: request.toolChoice,
        modelId: request.modelId,
        stream: true,
        streamId,
        maxTokens: request.maxTokens,
      });
      stopPoll = true;
      await poll;
      return result;
    } catch (e) {
      stopPoll = true;
      // Streaming+tools sometimes fails on providers — fall back once
      if (request.tools?.length && request.toolChoice === 'auto') {
        return this.aiNode.chatCompletion({
          messages: request.messages,
          tools: request.tools,
          toolChoice: request.toolChoice,
          modelId: request.modelId,
          stream: false,
          maxTokens: request.maxTokens,
        });
      }
      throw e;
    } finally {
      stopPoll = true;
    }
  }

  private async executeTool(call: ChatToolCall): Promise<string> {
    const rawName = call.function?.name || '';
    const name = this.normalizeToolName(rawName);
    if (call.function && name !== rawName) {
      call.function.name = name;
    }
    let args: any = {};
    try {
      args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      return `Invalid JSON arguments for ${name || rawName}`;
    }
    args = this.sanitizeToolArgs(args);

    try {
      switch (name) {
        case 'get_active_file':
          this.setStatus('Reading active file…');
          return await this.toolGetActiveFile();
        case 'update_todos':
          this.setStatus('Updating todos…');
          return this.toolUpdateTodos(args.todos, Boolean(args.merge));
        case 'get_diagnostics':
          this.setStatus('Reading diagnostics…');
          return this.toolGetDiagnostics(
            args.path ? String(args.path) : undefined,
            args.severity ? String(args.severity) : 'error',
            args.max_results != null ? Number(args.max_results) : 40,
          );
        case 'get_git_status':
          this.setStatus('Reading git status…');
          return this.toolGetGitStatus(args.max_results != null ? Number(args.max_results) : 40);
        case 'get_selection':
          this.setStatus('Reading selection…');
          return this.toolGetSelection();
        case 'exact_code_search':
          this.setStatus(`Exact-searching ${args.query}…`);
          return await this.toolExactCodeSearch(
            String(args.query || ''),
            args.max_results != null ? Number(args.max_results) : 20,
          );
        case 'goto_definition':
          this.setStatus(`Resolving ${args.symbol}…`);
          return await this.toolGotoDefinition(
            String(args.symbol || ''),
            args.max_results != null ? Number(args.max_results) : 20,
          );
        case 'find_references':
          this.setStatus(`Finding references to ${args.symbol}…`);
          return await this.toolFindReferences(
            String(args.symbol || ''),
            args.max_results != null ? Number(args.max_results) : 40,
          );
        case 'investigate_codepath':
          this.setStatus('Traversing code evidence graph…');
          return await this.toolInvestigateCodepath(
            String(args.query || ''),
            args.max_evidence != null ? Number(args.max_evidence) : 28,
          );
        case 'find_module':
          this.setStatus(`Finding module ${args.query}…`);
          return await this.toolFindModule(
            String(args.query || ''),
            args.max_results != null ? Number(args.max_results) : 16,
          );
        case 'repository_search':
          this.setStatus('Searching repository intelligence…');
          return await this.toolRepositorySearch(
            String(args.query || ''),
            args.max_results != null ? Number(args.max_results) : 12,
          );
        case 'repository_overview':
          this.setStatus('Mapping repository architecture…');
          return await this.toolRepositoryOverview();
        case 'related_files':
          this.setStatus(`Following dependencies for ${args.path}…`);
          return await this.toolRelatedFiles(
            String(args.path || ''),
            args.max_results != null ? Number(args.max_results) : 16,
          );
        case 'find_files':
          this.setStatus(`Finding ${args.query}…`);
          return await this.toolFindFiles(
            String(args.query || ''),
            args.max_results != null ? Number(args.max_results) : 30,
          );
        case 'grep':
          if (!String(args.query || '').trim()) {
            return 'query is required';
          }
          this.setStatus(`Grepping ${args.query}…`);
          return await this.toolGrep(
            String(args.query || ''),
            args.max_results != null ? Number(args.max_results) : 40,
          );
        case 'read_file':
          if (!String(args.path || '').trim()) {
            return 'path is required';
          }
          this.setStatus(`Reading ${args.path}…`);
          return await this.toolReadFile(
            String(args.path || ''),
            args.start_line != null ? Number(args.start_line) : undefined,
            args.end_line != null ? Number(args.end_line) : undefined,
          );
        case 'search_replace':
          this.setStatus(`Patching ${args.path}…`);
          return await this.toolSearchReplace(
            String(args.path || ''),
            String(args.search ?? ''),
            String(args.replace ?? ''),
            Boolean(args.replace_all),
          );
        case 'rename_file':
          this.setStatus(`Renaming ${args.path}…`);
          return await this.toolRenameFile(String(args.path || ''), String(args.new_path || ''));
        case 'create_file':
          this.setStatus(`Creating ${args.path}…`);
          return await this.toolCreateFile(String(args.path || ''), String(args.content ?? ''));
        case 'write_file':
          this.setStatus(`Writing ${args.path}…`);
          return await this.toolWriteFile(String(args.path || ''), String(args.content ?? ''));
        case 'delete_file':
          this.setStatus(`Deleting ${args.path}…`);
          return await this.toolDeleteFile(String(args.path || ''));
        case 'list_dir':
          this.setStatus(`Listing ${args.path || '.'}…`);
          return await this.toolListDir(args.path ? String(args.path) : '');
        case 'detect_dev_server':
          this.setStatus('Detecting dev server…');
          return this.fmtJson(await this.aiNode.detectDevServer(this.workspaceRoot()));
        case 'run_command':
          this.setStatus(`Running ${args.command}…`);
          return this.fmtJson(
            await this.aiNode.runCommand({
              command: String(args.command || ''),
              cwd: args.cwd ? String(args.cwd) : this.workspaceRoot(),
              background: Boolean(args.background),
              timeoutMs: args.timeout_ms != null ? Number(args.timeout_ms) : undefined,
            }),
          );
        case 'get_command_output':
          this.setStatus('Reading command output…');
          return this.fmtJson(await this.aiNode.getCommandOutput(String(args.id || '')));
        case 'stop_command':
          this.setStatus('Stopping command…');
          return this.fmtJson({ stopped: await this.aiNode.stopCommand(String(args.id || '')) });
        case 'live_test':
          this.setStatus('Live testing in browser…');
          return this.fmtJson(
            await this.aiNode.liveTest({
              workspaceRoot: this.workspaceRoot(),
              url: args.url ? String(args.url) : undefined,
              goal: args.goal ? String(args.goal) : undefined,
              startApp: args.start_app !== false,
              headed: args.headed !== false,
            }),
          );
        case 'browser_launch':
          this.setStatus('Launching browser…');
          return this.fmtJson(await this.aiNode.browserLaunch(args.headed !== false));
        case 'browser_goto':
          this.setStatus(`Opening ${args.url}…`);
          return this.fmtJson(await this.aiNode.browserGoto(String(args.url || '')));
        case 'browser_reload':
          this.setStatus('Reloading page…');
          return this.fmtJson(await this.aiNode.browserReload());
        case 'browser_snapshot':
          this.setStatus('Snapshotting page…');
          return this.fmtJson(await this.aiNode.browserSnapshot());
        case 'browser_click':
          this.setStatus('Clicking in browser…');
          return this.fmtJson(
            await this.aiNode.browserClick({
              role: args.role ? String(args.role) : undefined,
              name: args.name ? String(args.name) : undefined,
              text: args.text ? String(args.text) : undefined,
              selector: args.selector ? String(args.selector) : undefined,
              testid: args.testid ? String(args.testid) : undefined,
              exact: Boolean(args.exact),
            }),
          );
        case 'browser_fill':
          this.setStatus('Filling form…');
          return this.fmtJson(
            await this.aiNode.browserFill({
              value: String(args.value ?? ''),
              role: args.role ? String(args.role) : undefined,
              name: args.name ? String(args.name) : undefined,
              text: args.text ? String(args.text) : undefined,
              selector: args.selector ? String(args.selector) : undefined,
              testid: args.testid ? String(args.testid) : undefined,
            }),
          );
        case 'browser_upload':
          this.setStatus('Uploading file…');
          return this.fmtJson(
            await this.aiNode.browserUpload({
              value: args.value ? String(args.value) : undefined,
              role: args.role ? String(args.role) : undefined,
              name: args.name ? String(args.name) : undefined,
              text: args.text ? String(args.text) : undefined,
              selector: args.selector ? String(args.selector) : undefined,
              testid: args.testid ? String(args.testid) : undefined,
              kind: args.kind ? String(args.kind) : undefined,
              accept: args.accept ? String(args.accept) : undefined,
            }),
          );
        case 'browser_type':
          this.setStatus('Typing in browser…');
          return this.fmtJson(
            await this.aiNode.browserType({
              value: String(args.value ?? ''),
              role: args.role ? String(args.role) : undefined,
              name: args.name ? String(args.name) : undefined,
              selector: args.selector ? String(args.selector) : undefined,
              testid: args.testid ? String(args.testid) : undefined,
            }),
          );
        case 'browser_press':
          this.setStatus(`Pressing ${args.key}…`);
          return this.fmtJson(await this.aiNode.browserPress(String(args.key || 'Enter')));
        case 'browser_console':
          this.setStatus('Reading browser console…');
          return this.fmtJson(await this.aiNode.browserConsole());
        case 'browser_network':
          this.setStatus('Reading network / API calls…');
          return this.fmtJson(await this.aiNode.browserNetwork());
        case 'browser_devtools':
          this.setStatus(
            args.action === 'close' ? 'Closing DevTools…' : 'Opening DevTools…',
          );
          return this.fmtJson(
            await this.aiNode.browserDevtools({
              action: (['open', 'close', 'toggle', 'show'].includes(String(args.action))
                ? String(args.action)
                : 'open') as 'open' | 'close' | 'toggle' | 'show',
              panel: args.panel ? String(args.panel) : undefined,
            }),
          );
        case 'browser_screenshot':
          this.setStatus('Capturing screenshot…');
          return this.fmtJson(await this.aiNode.browserScreenshot());
        case 'browser_close':
          this.setStatus('Closing browser…');
          return this.fmtJson(await this.aiNode.browserClose());
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (e: any) {
      return `Tool ${name} failed: ${e?.message || e}`;
    }
  }

  private fmtJson(value: unknown): string {
    try {
      const text = JSON.stringify(value, null, 2);
      return text.length > 28_000 ? `${text.slice(0, 28_000)}\n/* truncated */` : text;
    } catch {
      return String(value);
    }
  }

  private isLiveTestIntent(text: string): boolean {
    const t = String(text || '');
    return /LIVE TEST MODE|live\s*test|browser.*(test|check|verify|open)|open.*(browser|chrome)|headed chromium|not working.*(browser|ui|page|button)|localhost:\d+|http:\/\/127\.0\.0\.1:\d+|http:\/\/localhost:\d+|login.*(user|pass|username)|test.*(login|ui|app|program)/i.test(
      t,
    );
  }

  /** Collapse streamed duplicates: read_fileread_file → read_file */
  private normalizeToolName(raw: string): string {
    const name = (raw || '').trim();
    if (!name) {
      return '';
    }
    const known = AGENT_TOOLS.map((t) => t.function.name);
    if (known.includes(name)) {
      return name;
    }
    const sorted = [...known].sort((a, b) => b.length - a.length);
    for (const k of sorted) {
      if (name.length % k.length === 0 && k.repeat(name.length / k.length) === name) {
        return k;
      }
      if (name.startsWith(k) && name.slice(k.length).startsWith(k)) {
        return k;
      }
      if (name.startsWith(k)) {
        return k;
      }
    }
    return name;
  }

  /** Strip DeepSeek/DSML `string=` / `path=` prefixes that break read_file / grep. */
  private cleanToolArgValue(value: unknown): string {
    let s = String(value ?? '').trim();
    if (!s) return '';
    s = s.replace(/^(?:string|number|boolean|path|query|pattern|file|filepath)\s*=\s*/i, '');
    s = s.replace(/^["']|["']$/g, '');
    return s.trim();
  }

  private sanitizeToolArgs(args: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...args };
    for (const key of ['path', 'query', 'pattern', 'symbol', 'new_path', 'command', 'url']) {
      if (key in out) {
        out[key] = this.cleanToolArgValue(out[key]);
      }
    }
    // Drop empty search keys so we don't run "Searching string="
    if (typeof out.query === 'string' && !out.query) delete out.query;
    if (typeof out.path === 'string' && !out.path) delete out.path;
    return out;
  }

  private displayPath(filePath: string): string {
    const root = this.workspaceRoot();
    if (root) {
      const rel = path.relative(root, filePath);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        return rel.replace(/\\/g, '/');
      }
    }
    return path.basename(filePath);
  }

  private async writeFullContent(filePath: string, content: string) {
    const uri = URI.file(filePath);
    const ref = await this.docService.createModelReference(uri, 'olkil-ai-revert');
    try {
      const monacoModel = ref.instance.getMonacoModel();
      const full = monacoModel.getFullModelRange();
      monacoModel.pushEditOperations(
        null,
        [{ range: full, text: content }] as any,
        () => null,
      );
      await ref.instance.save();
    } finally {
      ref.dispose();
    }
  }

  private async recordFileChange(opts: {
    kind: FileChangeKind;
    path: string;
    newPath?: string;
    beforeContent: string | null;
    afterContent: string | null;
  }): Promise<FileChangeInfo> {
    const trackPath = opts.kind === 'rename' && opts.newPath ? opts.newPath : opts.path;
    const existingIdx = this.messages.findIndex(
      (m) =>
        m.role === 'file_change' &&
        m.fileChange?.status === 'pending' &&
        m.fileChange.kind !== 'rename' &&
        opts.kind !== 'rename' &&
        normPath(m.fileChange.path) === normPath(opts.path),
    );

    // Merge multiple edits to the SAME pending file into one card
    if (existingIdx >= 0) {
      const msg = this.messages[existingIdx];
      const prev = msg.fileChange!;
      const snap = this.snapshots.get(prev.id);
      // Always diff against the FIRST version so one card shows the full delta.
      // For created files, baseline stays empty so revert can delete the file.
      const originalBefore =
        prev.kind === 'create' || snap?.kind === 'create'
          ? snap?.beforeContent ?? ''
          : snap?.beforeContent ?? opts.beforeContent ?? '';
      const after = opts.afterContent ?? '';
      const stats = countLineStats(originalBefore, after);
      const preview = buildDiffPreview(originalBefore, after, 40);
      const summary = buildChangeSummary(originalBefore, after);
      const hunks = buildDiffHunks(originalBefore, after).map((h) => ({
        id: h.id,
        title: h.title,
        additions: h.additions,
        deletions: h.deletions,
        status: 'pending' as const,
        preview: h.preview,
      }));

      const updated: FileChangeInfo = {
        ...prev,
        additions: stats.additions,
        deletions: stats.deletions,
        preview,
        summary,
        hunks,
        editCount: (prev.editCount || 1) + 1,
        // keep 'create' if the file was newly created in this turn
        kind: prev.kind === 'create' ? 'create' : opts.kind,
      };

      msg.fileChange = updated;
      this.snapshots.set(prev.id, {
        changeId: prev.id,
        kind: updated.kind,
        path: opts.path,
        newPath: opts.newPath,
        beforeContent: originalBefore,
        afterContent: after,
      });

      // Move card just before the pending assistant bubble (chronological Cursor order)
      this.messages.splice(existingIdx, 1);
      const pendingIdx = this.messages.findIndex((m) => m.role === 'assistant' && m.pending);
      if (pendingIdx >= 0) {
        this.messages.splice(pendingIdx, 0, msg);
      } else {
        this.messages.push(msg);
      }

      if (updated.kind === 'edit' || updated.kind === 'create') {
        await this.decorations.apply(prev.id, trackPath, originalBefore, after);
      }
      this.fire();
      return updated;
    }

    const changeId = nextChangeId();
    const before = opts.beforeContent ?? '';
    const after = opts.afterContent ?? '';
    let additions = 0;
    let deletions = 0;
    let preview = buildDiffPreview(before, after);
    let summary = buildChangeSummary(before, after);

    if (opts.kind === 'create') {
      additions = Math.max(1, after.split(/\r?\n/).length);
      deletions = 0;
      preview = after
        .split(/\r?\n/)
        .slice(0, 12)
        .map((text, i) => ({ type: 'add' as const, lineNumber: i + 1, text }));
      summary = `Created ${this.displayPath(opts.path)}`;
    } else if (opts.kind === 'delete') {
      additions = 0;
      deletions = Math.max(1, before.split(/\r?\n/).length);
      preview = before
        .split(/\r?\n/)
        .slice(0, 12)
        .map((text, i) => ({ type: 'del' as const, lineNumber: i + 1, text }));
      summary = `Deleted ${this.displayPath(opts.path)}`;
    } else if (opts.kind === 'rename') {
      additions = 0;
      deletions = 0;
      preview = [
        { type: 'del', text: this.displayPath(opts.path) },
        { type: 'add', text: this.displayPath(opts.newPath || '') },
      ];
      summary = `Renamed ${this.displayPath(opts.path)} → ${this.displayPath(opts.newPath || '')}`;
    } else {
      const stats = countLineStats(before, after);
      additions = stats.additions;
      deletions = stats.deletions;
      preview = buildDiffPreview(before, after, 40);
      summary = buildChangeSummary(before, after);
    }

    const hunks =
      opts.kind === 'edit' || opts.kind === 'create'
        ? buildDiffHunks(before, after).map((h) => ({
            id: h.id,
            title: h.title,
            additions: h.additions,
            deletions: h.deletions,
            status: 'pending' as const,
            preview: h.preview,
          }))
        : undefined;

    const info: FileChangeInfo = {
      id: changeId,
      kind: opts.kind,
      path: opts.path,
      displayName: this.displayPath(opts.path),
      newPath: opts.newPath,
      newDisplayName: opts.newPath ? this.displayPath(opts.newPath) : undefined,
      additions,
      deletions,
      status: 'pending',
      preview,
      summary,
      hunks,
      editCount: 1,
    };

    this.snapshots.set(changeId, {
      changeId,
      kind: opts.kind,
      path: opts.path,
      newPath: opts.newPath,
      beforeContent: opts.beforeContent,
      afterContent: opts.afterContent,
    });

    this.messages.push({
      id: nextId(),
      role: 'file_change',
      content: '',
      fileChange: info,
    });
    // Keep pending assistant reply at the bottom — insert card before it
    const pendingIdx = this.messages.findIndex((m) => m.role === 'assistant' && m.pending);
    if (pendingIdx >= 0 && pendingIdx < this.messages.length - 1) {
      const card = this.messages.pop()!;
      this.messages.splice(pendingIdx, 0, card);
    }
    if (this.messages.length > 120) {
      this.messages = this.messages.slice(-120);
    }

    if (opts.kind === 'edit' || opts.kind === 'create') {
      await this.decorations.apply(changeId, trackPath, before, after);
    }

    this.fire();
    return info;
  }

  private workspaceRoot(): string {
    try {
      const roots = this.workspaceService?.tryGetRoots?.() || [];
      for (const root of roots) {
        const fsPath = new URI(root.uri).codeUri.fsPath;
        if (fsPath && fs.existsSync(fsPath)) {
          return fsPath;
        }
      }
      const ws = this.workspaceService?.workspace;
      if (ws?.uri) {
        const fsPath = new URI(ws.uri).codeUri.fsPath;
        if (fsPath && fs.existsSync(fsPath) && !/\.code-workspace$/i.test(fsPath)) {
          return fsPath;
        }
      }
    } catch {
      // fall through
    }
    const fromConfig = this.appConfig.workspaceDir || '';
    // appConfig can point at the IDE install during boot — never treat that as
    // the user's project unless they explicitly opened it (roots above).
    if (fromConfig && fs.existsSync(fromConfig) && !this.isIdeInstallPath(fromConfig)) {
      return fromConfig;
    }
    // Never fall back to process.cwd() — that is usually the IDE install folder.
    return '';
  }

  /** True when the user is asking to create/edit files in a project. */
  private wantsProjectFolder(text: string): boolean {
    if (this.requiresImplementation(text)) return true;
    const t = (text || '').toLowerCase();
    return /\b(landing\s*page|website|webpage|html|css|react|next\.?js|folder|project|file|code|banao|bana|karo|likh|create|build|make|write|add|edit|fix|update)\b/i.test(
      t,
    );
  }

  private isIdeInstallPath(candidate: string): boolean {
    const n = path.resolve(candidate).replace(/\\/g, '/').toLowerCase();
    if (n.includes('/ide-electron/') || n.endsWith('/ide-electron')) return true;
    if (n.includes('/packages/olkil-engine')) return true;
    return false;
  }

  /**
   * Refresh the sidebar file tree as soon as agent tools create/edit files,
   * instead of waiting until the turn finishes.
   */
  private async refreshExplorerLive(filePaths: string[]): Promise<void> {
    try {
      await this.fileTreeService?.refresh?.();
    } catch {
      // Explorer may not be ready yet.
    }
    for (const p of filePaths) {
      try {
        await this.refreshRepositoryIndex([p]);
      } catch {
        // ignore
      }
    }
  }

  private resolvePath(input: string): string {
    const root = this.workspaceRoot();
    if (!input || input === '.') {
      return root;
    }
    if (path.isAbsolute(input)) {
      return input;
    }
    return path.join(root, input);
  }

  private async refreshRepositoryIndex(filePaths: string[]) {
    try {
      await this.aiNode.refreshRepositoryFiles(this.workspaceRoot(), filePaths);
    } catch {
      // The edit is authoritative; indexing is an acceleration layer and can
      // self-heal on the next background reconciliation.
    }
  }

  private numberLines(text: string, startLine = 1): string {
    const lines = text.split('\n');
    return lines
      .map((line, i) => `${String(startLine + i).padStart(4, ' ')}|${line}`)
      .join('\n');
  }

  private clipText(text: string): string {
    if (text.length <= MAX_READ_CHARS) {
      return text;
    }
    return `${text.slice(0, MAX_READ_CHARS)}\n\n/* truncated — use start_line/end_line */`;
  }

  private async readText(filePath: string): Promise<string> {
    const uri = URI.file(filePath);
    try {
      const ref = await this.docService.createModelReference(uri, 'olkil-ai');
      try {
        return ref.instance.getText();
      } finally {
        ref.dispose();
      }
    } catch {
      const file = await this.fileService.readFile(uri.toString());
      return file.content.toString();
    }
  }

  private async toolGetActiveFile(): Promise<string> {
    const resource = this.editorService.currentResource;
    const editor = this.editorService.currentEditor;
    if (!resource || !editor?.currentDocumentModel) {
      return 'No active file in the editor.';
    }
    const filePath = resource.uri.codeUri.fsPath;
    const content = editor.currentDocumentModel.getText();
    const lines = content.split('\n');
    const preview = lines.slice(0, MAX_PREVIEW_LINES).join('\n');
    const numbered = this.numberLines(this.clipText(preview), 1);
    return JSON.stringify({
      path: filePath,
      language: editor.currentDocumentModel.languageId,
      total_lines: lines.length,
      preview: numbered,
      note:
        lines.length > MAX_PREVIEW_LINES
          ? `Preview shows first ${MAX_PREVIEW_LINES} lines. Use read_file with start_line/end_line.`
          : undefined,
    });
  }

  private async toolRepositorySearch(query: string, maxResults: number): Promise<string> {
    if (!query.trim()) {
      return 'query is required';
    }
    const result = await this.aiNode.searchRepository(
      this.workspaceRoot(),
      query,
      Math.max(1, Math.min(30, maxResults || 12)),
    );
    return JSON.stringify(result, null, 2);
  }

  private async toolExactCodeSearch(query: string, maxResults: number): Promise<string> {
    if (!query.trim()) return 'query is required';
    const result = await this.aiNode.exactRepositorySearch(
      this.workspaceRoot(),
      query,
      Math.max(1, Math.min(80, maxResults || 20)),
    );
    return JSON.stringify(result, null, 2);
  }

  private async toolGotoDefinition(symbol: string, maxResults: number): Promise<string> {
    if (!symbol.trim()) return 'symbol is required';
    const result = await this.aiNode.findSymbolDefinitions(
      this.workspaceRoot(),
      symbol,
      Math.max(1, Math.min(80, maxResults || 20)),
    );
    return JSON.stringify(result, null, 2);
  }

  private async toolFindReferences(symbol: string, maxResults: number): Promise<string> {
    if (!symbol.trim()) return 'symbol is required';
    const result = await this.aiNode.findSymbolReferences(
      this.workspaceRoot(),
      symbol,
      Math.max(1, Math.min(160, maxResults || 40)),
    );
    return JSON.stringify(result, null, 2);
  }

  private async toolInvestigateCodepath(query: string, maxEvidence: number): Promise<string> {
    if (!query.trim()) {
      return 'query is required';
    }
    const result = await this.aiNode.investigateRepository(
      this.workspaceRoot(),
      query,
      Math.max(8, Math.min(50, maxEvidence || 28)),
    );
    return JSON.stringify(result, null, 2);
  }

  private async toolFindModule(query: string, maxResults: number): Promise<string> {
    if (!query.trim()) {
      return 'query is required';
    }
    const result = await this.aiNode.findModules(
      this.workspaceRoot(),
      query,
      Math.max(1, Math.min(40, maxResults || 16)),
    );
    return JSON.stringify(
      {
        ...result,
        hint:
          result.hits.length > 0
            ? 'Read the top paths with read_file, then edit. Prefer folder/index files that match the module name.'
            : 'No module path matched. Try a shorter name (e.g. just "timeline") or grep for the feature text.',
      },
      null,
      2,
    );
  }

  private async toolRepositoryOverview(): Promise<string> {
    const result = await this.aiNode.getRepositoryOverview(this.workspaceRoot());
    return JSON.stringify(result, null, 2);
  }

  private async toolRelatedFiles(inputPath: string, maxResults: number): Promise<string> {
    if (!inputPath) {
      return 'path is required';
    }
    const result = await this.aiNode.getRelatedFiles(
      this.workspaceRoot(),
      this.resolvePath(inputPath),
      Math.max(1, Math.min(30, maxResults || 16)),
    );
    return JSON.stringify(result, null, 2);
  }

  private async toolReadFile(
    inputPath: string,
    startLine?: number,
    endLine?: number,
  ): Promise<string> {
    if (!inputPath) {
      return 'path is required';
    }
    const filePath = this.resolvePath(inputPath);
    const content = await this.readText(filePath);
    this.filesReadThisSession.add(normPath(filePath));
    const lines = content.split('\n');
    const start = Math.max(1, startLine || 1);
    const end = Math.min(lines.length, endLine || Math.min(lines.length, start + MAX_PREVIEW_LINES - 1));
    const slice = lines.slice(start - 1, end).join('\n');
    return this.clipText(
      `FILE: ${filePath}\nLINES: ${start}-${end} of ${lines.length}\n\n${this.numberLines(slice, start)}`,
    );
  }

  private async toolSearchReplace(
    inputPath: string,
    searchInput: string,
    replaceInput: string,
    replaceAll: boolean,
  ): Promise<string> {
    if (!inputPath) {
      return 'path is required';
    }
    if (!searchInput) {
      return 'search is required (exact unique snippet from the file)';
    }

    const filePath = this.resolvePath(inputPath);

    // Read-before-edit: blind edits are the #1 source of broken files.
    if (!this.filesReadThisSession.has(normPath(filePath))) {
      return (
        `EDIT BLOCKED: you have not read ${filePath} in this session. ` +
        `Call read_file on it first, copy the exact snippet you want to change, then retry search_replace.`
      );
    }

    // Models copy "  12|" prefixes from read_file output; strip them.
    const search = stripLineNumberArtifacts(searchInput);
    const replace = stripMarkdownFence(stripLineNumberArtifacts(replaceInput));

    const artifact = findContentArtifact(replace);
    if (artifact) {
      return `EDIT REJECTED: ${artifact}. Retry with the full literal code.`;
    }

    const uri = URI.file(filePath);
    const ref = await this.docService.createModelReference(uri, 'olkil-ai');

    try {
      const monacoModel = ref.instance.getMonacoModel();
      const text = monacoModel.getValue();

      // Normalize common mismatch: CRLF vs LF in search string
      const candidates = [search];
      if (search.includes('\n') && !search.includes('\r\n') && text.includes('\r\n')) {
        candidates.push(search.replace(/\n/g, '\r\n'));
      }
      if (search.includes('\r\n') && !text.includes('\r\n')) {
        candidates.push(search.replace(/\r\n/g, '\n'));
      }

      let usedSearch = search;
      let occurrences: number[] = [];
      for (const cand of candidates) {
        occurrences = [];
        let from = 0;
        while (from <= text.length) {
          const idx = text.indexOf(cand, from);
          if (idx < 0) {
            break;
          }
          occurrences.push(idx);
          from = idx + Math.max(cand.length, 1);
          if (!replaceAll && occurrences.length > 1) {
            break;
          }
        }
        if (occurrences.length > 0) {
          usedSearch = cand;
          break;
        }
      }

      let replaceText = replace;

      // Whitespace-tolerant fallback: match trimmed lines, anchor to the REAL
      // text on disk, and shift the replacement to the real indentation.
      // Works for multi-line AND single-line snippets (length ≥ 8).
      if (occurrences.length === 0) {
        const fuzzy = fuzzyLocate(text, search);
        if (fuzzy.kind === 'found') {
          occurrences = [fuzzy.index];
          usedSearch = fuzzy.actual;
          replaceText = reindentReplacement(fuzzy.actual, search, replace);
        } else if (fuzzy.kind === 'ambiguous') {
          return `search_replace failed: snippet matches ${fuzzy.count} places (ignoring indentation). Include more surrounding lines to make it unique.`;
        }
      }

      if (occurrences.length === 0) {
        return `search_replace failed: search text not found in ${filePath}. Re-read the file and use an exact unique snippet (without line-number prefixes).`;
      }
      if (!replaceAll && occurrences.length > 1) {
        return `search_replace failed: search matched ${occurrences.length} times. Make search more unique, or set replace_all=true.`;
      }

      const targets = replaceAll ? occurrences : [occurrences[0]];
      if (usedSearch.includes('\r\n') && !replaceText.includes('\r\n') && replaceText.includes('\n')) {
        replaceText = replaceText.replace(/\n/g, '\r\n');
      }

      // Simulate the edit in the string domain and syntax-check BEFORE
      // touching the editor. A broken result is rejected, never saved.
      let simulated = '';
      let cursor = 0;
      for (const idx of [...targets].sort((a, b) => a - b)) {
        simulated += text.slice(cursor, idx) + replaceText;
        cursor = idx + usedSearch.length;
      }
      simulated += text.slice(cursor);

      const destructive = destructiveEditIssue(text, simulated, {
        searchLen: usedSearch.length * targets.length,
        replaceLen: replaceText.length * targets.length,
      });
      if (destructive) {
        return `EDIT REJECTED: ${destructive}. Nothing was changed.`;
      }

      const freshIssues = newlyIntroducedIssues(
        syntaxIssues(filePath, text),
        syntaxIssues(filePath, simulated),
      );
      if (freshIssues.length) {
        const detail = freshIssues.map((issue) => `line ${issue.line}: ${issue.message}`).join('; ');
        return (
          `EDIT REJECTED (would break the file): ${detail}. ` +
          `Nothing was changed. Re-read the region and retry with balanced, complete code.`
        );
      }

      const edits = [...targets]
        .sort((a, b) => b - a)
        .map((idx) => {
          const start = monacoModel.getPositionAt(idx);
          const end = monacoModel.getPositionAt(idx + usedSearch.length);
          return {
            range: {
              startLineNumber: start.lineNumber,
              startColumn: start.column,
              endLineNumber: end.lineNumber,
              endColumn: end.column,
            },
            text: replaceText,
          };
        });

      monacoModel.pushEditOperations(null, edits as any, () => null);
      await ref.instance.save();
      await this.editorService.open(uri);

      const afterText = monacoModel.getValue();
      await this.recordFileChange({
        kind: 'edit',
        path: filePath,
        beforeContent: text,
        afterContent: afterText,
      });
      await this.refreshRepositoryIndex([filePath]);

      // Cursor-style post-edit proof: show the landed region so the model
      // (and user) can verify what actually hit disk.
      const firstIdx = Math.min(...targets);
      const startPos = monacoModel.getPositionAt(firstIdx);
      const endPos = monacoModel.getPositionAt(
        Math.min(afterText.length, firstIdx + replaceText.length),
      );
      const verifyStart = Math.max(1, startPos.lineNumber - 1);
      const verifyEnd = Math.min(
        afterText.split(/\r?\n/).length,
        endPos.lineNumber + 1,
      );
      const verifyLines = afterText
        .split(/\r?\n/)
        .slice(verifyStart - 1, verifyEnd)
        .map((line, i) => `${String(verifyStart + i).padStart(4, ' ')}|${line}`)
        .join('\n');

      return JSON.stringify({
        ok: true,
        path: filePath,
        replacements: targets.length,
        chars_removed: usedSearch.length * targets.length,
        chars_added: replaceText.length * targets.length,
        syntax_check: 'passed',
        verified_lines: `${verifyStart}-${verifyEnd}`,
        verified_preview: verifyLines.slice(0, 1200),
        next: 'If the preview looks wrong, immediately search_replace again to fix it.',
      });
    } finally {
      ref.dispose();
    }
  }

  private walkFiles(root: string, onFile: (absPath: string) => void | false) {
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        if (ent.name.startsWith('.') && ent.name !== '.env.example') {
          // still allow searching dotfiles if needed, but skip heavy dirs
        }
        if (ent.isDirectory()) {
          if (SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) {
            continue;
          }
          stack.push(path.join(dir, ent.name));
          continue;
        }
        if (ent.isFile()) {
          const stop = onFile(path.join(dir, ent.name));
          if (stop === false) {
            return;
          }
        }
      }
    }
  }

  private async toolFindFiles(query: string, maxResults = 30): Promise<string> {
    const q = (query || '').trim().toLowerCase();
    if (!q) {
      return 'query is required';
    }
    const root = this.workspaceRoot();
    if (!root || !fs.existsSync(root)) {
      return `No workspace open (root=${root}). Ask user to open a folder.`;
    }

    // Extreme path: indexed basename/path-token lookup (no full-tree walk).
    try {
      const indexed = await this.aiNode.findFilesByName(root, q, Math.max(1, Math.min(200, maxResults)));
      if (indexed.files.length) {
        return JSON.stringify({
          workspace: root,
          query,
          engine: indexed.engine,
          elapsedMs: indexed.elapsedMs,
          count: indexed.files.length,
          files: indexed.files,
          hint: 'Use these relative paths with read_file / search_replace.',
        });
      }
    } catch {
      // fall through to FS walk
    }

    const needle = q.replace(/\*/g, '');
    const matches: string[] = [];
    this.walkFiles(root, (abs) => {
      const base = path.basename(abs).toLowerCase();
      const rel = path.relative(root, abs).toLowerCase().replace(/\\/g, '/');
      if (base.includes(needle) || rel.includes(needle)) {
        matches.push(path.relative(root, abs).replace(/\\/g, '/'));
        if (matches.length >= maxResults) {
          return false;
        }
      }
    });

    return JSON.stringify({
      workspace: root,
      query,
      engine: 'fs-walk',
      count: matches.length,
      files: matches,
      hint: matches.length
        ? 'Use these relative paths with read_file / search_replace.'
        : 'No matches. Try a shorter query or grep for text inside files.',
    });
  }

  private async toolGrep(query: string, maxResults = 40): Promise<string> {
    const q = query || '';
    if (!q) {
      return 'query is required';
    }
    const root = this.workspaceRoot();
    if (!root || !fs.existsSync(root)) {
      return `No workspace open (root=${root}). Ask user to open a folder.`;
    }

    // Native ripgrep on the node process: millisecond scans, sticky-cached.
    const frontendOnly = this.isFrontendOnlyIntent(
      [...this.history].reverse().find((m) => m.role === 'user')?.content || '',
    );
    const result = await this.aiNode.grepRepository(root, q, {
      maxResults: Math.max(1, Math.min(200, maxResults)),
      ...(frontendOnly
        ? {
            // Prefer UI sources when user locked frontend-only scope
          }
        : {}),
    });
    // When frontend-only, also try a second scoped pass if first is noisy — use globs via index ranking in collectExploredPaths.
    if (result.engine === 'ripgrep') {
      let matches = result.matches.map((m) => ({ file: m.path, line: m.line, text: m.text }));
      if (frontendOnly) {
        const ui = matches.filter((m) =>
          /frontend|src\/app|components?\/|\.(html|scss|css|tsx|jsx|vue)$/i.test(m.file),
        );
        if (ui.length) matches = ui;
      }
      return JSON.stringify({
        workspace: root,
        query: q,
        engine: 'ripgrep',
        elapsedMs: result.elapsedMs,
        truncated: result.truncated,
        count: matches.length,
        matches,
      });
    }

    // Fallback: verified index search when ripgrep binary is missing.
    const fallback = await this.aiNode.exactRepositorySearch(root, q, maxResults);
    return JSON.stringify({
      workspace: root,
      query: q,
      engine: 'index',
      count: fallback.hits.length,
      matches: fallback.hits.map((hit) => ({ file: hit.path, reason: hit.reason, excerpt: hit.excerpt })),
    });
  }

  private async toolRenameFile(inputPath: string, newPath: string): Promise<string> {
    if (!inputPath || !newPath) {
      return 'path and new_path are required';
    }
    const from = this.resolvePath(inputPath);
    const to = this.resolvePath(newPath);
    const fromUri = URI.file(from);
    const toUri = URI.file(to);
    const exists = await this.fileService.access(fromUri.toString());
    if (!exists) {
      return `Source not found: ${from}. Use find_files first.`;
    }
    const destExists = await this.fileService.access(toUri.toString());
    if (destExists) {
      return `Destination already exists: ${to}`;
    }
    await this.fileService.move(fromUri.toString(), toUri.toString(), { overwrite: false });
    await this.editorService.open(toUri);
    await this.recordFileChange({
      kind: 'rename',
      path: from,
      newPath: to,
      beforeContent: null,
      afterContent: null,
    });
    await this.refreshRepositoryIndex([from, to]);
    return JSON.stringify({ ok: true, from, to });
  }

  private async toolCreateFile(inputPath: string, contentInput: string): Promise<string> {
    if (!inputPath) {
      return 'path is required';
    }
    const filePath = this.resolvePath(inputPath);
    const uri = URI.file(filePath);
    const exists = await this.fileService.access(uri.toString());
    if (exists) {
      return `File already exists: ${filePath}. Use search_replace or write_file to update it.`;
    }
    const content = stripMarkdownFence(contentInput);
    const guardError = this.guardFullContent(filePath, content);
    if (guardError) {
      return guardError;
    }
    await this.fileService.createFile(uri.toString(), { content });
    this.filesReadThisSession.add(normPath(filePath));
    await this.editorService.open(uri);
    await this.recordFileChange({
      kind: 'create',
      path: filePath,
      beforeContent: null,
      afterContent: content,
    });
    await this.refreshRepositoryIndex([filePath]);
    return `Created ${filePath} (${content.length} chars)`;
  }

  /**
   * Validate full-file content before it touches disk: no truncation
   * placeholders, no conflict markers, no structurally broken code.
   */
  private guardFullContent(filePath: string, content: string): string | undefined {
    const artifact = findContentArtifact(content);
    if (artifact) {
      return `EDIT REJECTED: ${artifact}. Nothing was written.`;
    }
    const issues = syntaxIssues(filePath, content);
    if (issues.length) {
      const detail = issues.map((issue) => `line ${issue.line}: ${issue.message}`).join('; ');
      return (
        `EDIT REJECTED (content has syntax errors): ${detail}. ` +
        `Nothing was written. Fix the code and retry with the complete corrected file.`
      );
    }
    return undefined;
  }

  /** Create or overwrite a file (full content). */
  private async toolWriteFile(inputPath: string, contentInput: string): Promise<string> {
    if (!inputPath) {
      return 'path is required';
    }
    const filePath = this.resolvePath(inputPath);
    const content = stripMarkdownFence(contentInput);
    const guardError = this.guardFullContent(filePath, content);
    if (guardError) {
      return guardError;
    }
    const uri = URI.file(filePath);
    const exists = await this.fileService.access(uri.toString());
    if (!exists) {
      await this.fileService.createFile(uri.toString(), { content });
      this.filesReadThisSession.add(normPath(filePath));
      await this.editorService.open(uri);
      await this.recordFileChange({
        kind: 'create',
        path: filePath,
        beforeContent: null,
        afterContent: content,
      });
      await this.refreshRepositoryIndex([filePath]);
      return `Created ${filePath} (${content.length} chars)`;
    }
    // Overwriting an unread file silently destroys its contents — block it.
    if (!this.filesReadThisSession.has(normPath(filePath))) {
      return (
        `EDIT BLOCKED: ${filePath} exists and you have not read it in this session. ` +
        `write_file OVERWRITES the whole file. read_file it first, then prefer search_replace for partial edits.`
      );
    }
    let before = '';
    try {
      before = await this.readText(filePath);
    } catch {
      before = '';
    }
    const destructive = destructiveEditIssue(before, content);
    if (destructive) {
      return `EDIT REJECTED: ${destructive}. Prefer search_replace for surgical edits.`;
    }
    const freshIssues = newlyIntroducedIssues(
      syntaxIssues(filePath, before),
      syntaxIssues(filePath, content),
    );
    if (freshIssues.length) {
      const detail = freshIssues.map((issue) => `line ${issue.line}: ${issue.message}`).join('; ');
      return (
        `EDIT REJECTED (would break the file): ${detail}. ` +
        `Nothing was written. Fix the code and retry.`
      );
    }
    await this.writeFullContent(filePath, content);
    await this.editorService.open(uri);
    await this.recordFileChange({
      kind: 'edit',
      path: filePath,
      beforeContent: before,
      afterContent: content,
    });
    await this.refreshRepositoryIndex([filePath]);
    return `Wrote ${filePath} (${content.length} chars)`;
  }

  /** Delete a file (or empty directory) from disk. */
  private async toolDeleteFile(inputPath: string): Promise<string> {
    if (!inputPath) {
      return 'path is required';
    }
    const filePath = this.resolvePath(inputPath);
    const uri = URI.file(filePath);
    const exists = await this.fileService.access(uri.toString());
    if (!exists) {
      return `Not found: ${filePath}. Use find_files or list_dir first.`;
    }
    let before: string | null = null;
    let isDir = false;
    try {
      const st = fs.statSync(filePath);
      isDir = st.isDirectory();
      if (!isDir) {
        before = await this.readText(filePath);
      }
    } catch {
      // still try delete
    }
    if (isDir) {
      const children = fs.readdirSync(filePath);
      if (children.length > 0) {
        return `Directory not empty: ${filePath}. Delete files inside first.`;
      }
    }
    await this.fileService.delete(uri.toString());
    await this.recordFileChange({
      kind: 'delete',
      path: filePath,
      beforeContent: before,
      afterContent: null,
    });
    await this.refreshRepositoryIndex([filePath]);
    return `Deleted ${filePath}`;
  }

  private async toolListDir(inputPath: string): Promise<string> {
    const dirPath = this.resolvePath(inputPath || '.');
    const uri = URI.file(dirPath);
    const stat = await this.fileService.getFileStat(uri.toString(), true);
    if (!stat) {
      return `Directory not found: ${dirPath}`;
    }
    if (!stat.isDirectory) {
      return `Not a directory: ${dirPath}`;
    }
    const children = (stat.children || []).map((c) => ({
      name: path.basename(c.uri),
      type: c.isDirectory ? 'dir' : 'file',
    }));
    return JSON.stringify({ path: dirPath, entries: children.slice(0, 200) }, null, 2);
  }

  private getProjectRules(): string {
    const root = this.workspaceRoot();
    if (!root) {
      return '';
    }
    const now = Date.now();
    if (this.rulesCache && this.rulesCache.root === root && now - this.rulesCache.at < 60_000) {
      return this.rulesCache.text;
    }
    const text = loadProjectRules(root);
    this.rulesCache = { root, text, at: now };
    return text;
  }

  private toolGetDiagnostics(pathFilter?: string, severity = 'error', maxResults = 40): string {
    try {
      const manager = this.markerService.getManager();
      const want =
        severity === 'all'
          ? MarkerSeverity.Error | MarkerSeverity.Warning | MarkerSeverity.Info
          : severity === 'warning'
            ? MarkerSeverity.Error | MarkerSeverity.Warning
            : MarkerSeverity.Error;
      let markers = manager.getMarkers({ severities: want, take: 500 }) || [];
      if (pathFilter) {
        const needle = normPath(this.resolvePath(pathFilter));
        markers = markers.filter((m) => normPath(m.resource || '').includes(needle) || normPath(m.resource || '').endsWith(needle));
      }
      const rows = markers.slice(0, maxResults).map((m) => ({
        severity:
          m.severity === MarkerSeverity.Error
            ? 'error'
            : m.severity === MarkerSeverity.Warning
              ? 'warning'
              : 'info',
        path: m.resource,
        line: m.startLineNumber,
        column: m.startColumn,
        message: m.message,
        source: m.source,
      }));
      return JSON.stringify({ ok: true, count: rows.length, diagnostics: rows }, null, 2);
    } catch (e: any) {
      return JSON.stringify({ ok: false, message: e?.message || String(e) });
    }
  }

  private toolGetGitStatus(maxResults = 40): string {
    try {
      const out: Array<{ group: string; path: string; letter?: string }> = [];
      const repos =
        this.scmService.selectedRepositories?.length
          ? this.scmService.selectedRepositories
          : this.scmService.repositories || [];
      for (const repo of repos) {
        const provider = repo.provider;
        for (const group of provider.groups?.elements || []) {
          for (const r of group.elements || []) {
            const uri = (r as any).sourceUri;
            const fsPath = uri?.codeUri?.fsPath || uri?.fsPath || String(uri || '');
            out.push({
              group: group.label,
              path: fsPath,
              letter: (r as any).decorations?.letter,
            });
            if (out.length >= maxResults) {
              break;
            }
          }
          if (out.length >= maxResults) {
            break;
          }
        }
      }
      if (!out.length) {
        // Fallback: git status --porcelain via sync? Keep message for agent.
        return JSON.stringify({
          ok: true,
          count: 0,
          files: [],
          note: 'No SCM provider changes visible. Open a git repo or stage files.',
        });
      }
      return JSON.stringify({ ok: true, count: out.length, files: out }, null, 2);
    } catch (e: any) {
      return JSON.stringify({ ok: false, message: e?.message || String(e) });
    }
  }

  private toolGetSelection(): string {
    try {
      const editor = this.editorService.currentEditor;
      const model = editor?.currentDocumentModel;
      const resource = this.editorService.currentResource;
      if (!editor || !model || !resource) {
        return JSON.stringify({ ok: false, message: 'No active editor' });
      }
      const sels = editor.getSelections?.() || [];
      if (!sels.length) {
        return JSON.stringify({ ok: false, message: 'No selection' });
      }
      const s = sels[0];
      const startLine = Math.min(s.selectionStartLineNumber, s.positionLineNumber);
      const endLine = Math.max(s.selectionStartLineNumber, s.positionLineNumber);
      const startCol =
        s.selectionStartLineNumber < s.positionLineNumber ||
        (s.selectionStartLineNumber === s.positionLineNumber &&
          s.selectionStartColumn <= s.positionColumn)
          ? s.selectionStartColumn
          : s.positionColumn;
      const endCol =
        s.selectionStartLineNumber < s.positionLineNumber ||
        (s.selectionStartLineNumber === s.positionLineNumber &&
          s.selectionStartColumn <= s.positionColumn)
          ? s.positionColumn
          : s.selectionStartColumn;
      if (startLine === endLine && startCol === endCol) {
        return JSON.stringify({ ok: false, message: 'Empty selection (caret only)' });
      }
      const text = model.getText({
        startLineNumber: startLine,
        startColumn: startCol,
        endLineNumber: endLine,
        endColumn: endCol,
      });
      const path = resource.uri.codeUri.fsPath;
      this.filesReadThisSession.add(normPath(path));
      return JSON.stringify({
        ok: true,
        path,
        startLine,
        endLine,
        startColumn: startCol,
        endColumn: endCol,
        text: (text || '').slice(0, 12_000),
      });
    } catch (e: any) {
      return JSON.stringify({ ok: false, message: e?.message || String(e) });
    }
  }

  private async toolCodebaseContext(query: string): Promise<string> {
    const root = this.workspaceRoot();
    if (!root) {
      return 'No workspace open.';
    }
    try {
      const result = await this.aiNode.investigateRepository(root, query || 'overview', 16);
      if (!result) {
        return 'Index still warming — use find_module/grep.';
      }
      const lines = (result.evidence || []).slice(0, 10).map(
        (e, i) => `${i + 1}. ${e.path} [${e.score}%] — ${e.reasons?.slice(0, 2).join('; ') || ''}`,
      );
      return `Codebase hits for "${query}":\n${lines.join('\n') || '(none)'}\nConfidence: ${result.confidence}`;
    } catch (e: any) {
      return `Codebase search failed: ${e?.message || e}`;
    }
  }

  private toolUpdateTodos(rawTodos: unknown, merge: boolean): string {
    const list = Array.isArray(rawTodos) ? rawTodos : [];
    const normalized: AgentTodoItem[] = list
      .map((t: any, i: number) => ({
        id: String(t?.id || `t${i + 1}`),
        content: String(t?.content || '').trim(),
        status: (['pending', 'in_progress', 'completed', 'cancelled'].includes(t?.status)
          ? t.status
          : 'pending') as AgentTodoItem['status'],
      }))
      .filter((t) => t.content);

    if (merge && this.agentTodos.length) {
      const map = new Map(this.agentTodos.map((t) => [t.id, t]));
      for (const t of normalized) {
        map.set(t.id, t);
      }
      this.agentTodos = [...map.values()];
    } else {
      this.agentTodos = normalized;
    }

    // Upsert sticky todos card before pending assistant
    const existingIdx = this.messages.findIndex((m) => m.role === 'todos');
    const card: UiChatMessage = {
      id: existingIdx >= 0 ? this.messages[existingIdx].id : nextId(),
      role: 'todos',
      content: 'Todos',
      todos: this.agentTodos.map((t) => ({ ...t })),
    };
    if (existingIdx >= 0) {
      this.messages[existingIdx] = card;
      // Move near end (before pending)
      this.messages.splice(existingIdx, 1);
      const pendingIdx = this.messages.findIndex((m) => m.role === 'assistant' && m.pending);
      if (pendingIdx >= 0) {
        this.messages.splice(pendingIdx, 0, card);
      } else {
        this.messages.push(card);
      }
    } else {
      const pendingIdx = this.messages.findIndex((m) => m.role === 'assistant' && m.pending);
      if (pendingIdx >= 0) {
        this.messages.splice(pendingIdx, 0, card);
      } else {
        this.messages.push(card);
      }
    }
    this.fire();
    return JSON.stringify({ ok: true, todos: this.agentTodos }, null, 2);
  }

  private pushUi(role: UiChatMessage['role'], content: string) {
    this.messages.push({ id: nextId(), role, content });
    if (this.messages.length > 80) {
      this.messages = this.messages.slice(-80);
    }
    this.fire();
  }

  private patchUi(id: string, patch: Partial<UiChatMessage>) {
    const idx = this.messages.findIndex((m) => m.id === id);
    if (idx >= 0) {
      this.messages[idx] = { ...this.messages[idx], ...patch };
      this.fire();
    }
  }

  private setStatus(status: string) {
    this.status = status;
    this.fire();
  }

  private fire() {
    this._onDidChange.fire();
  }
}
