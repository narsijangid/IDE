import { Autowired, Injectable } from '@opensumi/di';
import { Emitter, Event, URI, Disposable } from '@opensumi/ide-core-common';
import { AppConfig } from '@opensumi/ide-core-browser';
import { WorkbenchEditorService } from '@opensumi/ide-editor';
import { IEditorDocumentModelService } from '@opensumi/ide-editor/lib/browser';
import { IFileServiceClient } from '@opensumi/ide-file-service/lib/common';
import { IWorkspaceService } from '@opensumi/ide-workspace/lib/common';
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
import { loadProjectRules } from '../common/rules';
import { buildDiffHunks, applyAcceptedHunks } from '../common/hunks';
import { buildChangeSummary, buildDiffPreview, countLineStats } from '../common/diff';
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

let msgSeq = 0;
const nextId = () => `m_${Date.now()}_${++msgSeq}`;
const nextChangeId = () => `c_${Date.now()}_${++msgSeq}`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

  @Autowired(IMarkerService)
  private markerService!: IMarkerService;

  @Autowired(SCMService)
  private scmService!: SCMService;

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
    } catch (e: any) {
      this.pushUi('status', `AI backend init error: ${e?.message || e}`);
    }
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
    this.chatMode = mode;
    this.pushUi(
      'status',
      mode === 'agent'
        ? 'Agent mode — will explore & edit files on its own.'
        : mode === 'ask'
          ? 'Ask mode — read-only answers (no file edits).'
          : 'Plan mode — will outline a plan and ask before big edits.',
    );
    this.fire();
  }

  /** One-click: agent starts app → headed browser → test → fix → retest. */
  async startLiveTest(goal?: string) {
    if (this.busy) {
      return;
    }
    this.chatMode = 'agent';
    const focus = (goal || '').trim();
    const prompt = `LIVE TEST MODE — Verify this project in a real browser (headed Chromium on my screen).

${focus ? `Focus / bug report:\n${focus}\n` : ''}
Required loop:
1. Call live_test (start_app true, headed true)${focus ? ` with goal set to the focus above` : ''}.
2. Read the snapshot. Exercise the main UI (and the reported bug if any) via browser_click / browser_fill using role+name.
3. Call browser_console + browser_network + browser_screenshot. Treat pageerror / 4xx–5xx as bugs.
4. Only if you need the visible inspector: browser_devtools panel=console|network (right dock). Close it when done — do NOT leave DevTools open by default.
5. If broken: investigate_codepath / read_file → search_replace fix → browser_reload → retest the SAME flow.
6. Max 5 fix rounds. End with PASS/FAIL, evidence (console/network), and files changed.
7. Do not claim success without a successful retest in this turn. Start now.`;
    await this.send(prompt);
  }

  clear() {
    void this.decorations.clearAll();
    this.history = [];
    this.snapshots.clear();
    this.queuedMessages = [];
    this.agentTodos = [];
    this.checkpoints = [];
    this.checkpointSnapshots.clear();
    this.messages = [
      {
        id: nextId(),
        role: 'system',
        content: 'Chat cleared. OLKIL ready.',
      },
    ];
    this.status = '';
    this.fire();
  }

  stop() {
    this.cancelRequested = true;
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

  async send(userText: string, attachments: ChatAttachment[] = []) {
    const text = userText.trim();
    if (!text && !attachments.length) {
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
    this.busy = true;

    const display =
      attachments.length > 0
        ? `${text}${text ? '\n' : ''}${attachments.map((a) => `@${a.name}`).join(' ')}`
        : text;
    this.messages.push({
      id: nextId(),
      role: 'user',
      content: display || '(attachments)',
      attachments: attachments.length ? [...attachments] : undefined,
    });
    if (this.messages.length > 160) {
      this.messages = this.messages.slice(-160);
    }
    this.fire();

    const enriched = await this.buildUserContentWithAttachments(text, attachments);
    this.history.push({ role: 'user', content: enriched });

    const pendingId = nextId();
    this.messages.push({ id: pendingId, role: 'assistant', content: '', pending: true });
    this.setStatus(this.chatMode === 'agent' ? 'Agent thinking…' : 'Planning…');

    try {
      const reply = await this.runAgentLoop(pendingId);
      const finalText = (reply || '').trim() || this.fallbackSummary();
      const suggestions = this.extractSuggestions(finalText);
      await this.typeOut(pendingId, finalText);
      this.patchUi(pendingId, { suggestions: suggestions.length ? suggestions : undefined });
      this.history.push({ role: 'assistant', content: finalText });
      this.setStatus('');
    } catch (e: any) {
      // If the outer loop still blows up on a transient 500 but edits already
      // landed, don't leave a scary error bubble — show what was done.
      if (this.isTransientLlmError(e) && this.pendingChanges.length) {
        const summary = this.fallbackSummary();
        await this.typeOut(pendingId, summary);
        this.history.push({ role: 'assistant', content: summary });
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
    const text = full || '';
    if (!text) {
      this.patchUi(pendingId, { content: this.fallbackSummary(), pending: false });
      return;
    }
    this.patchUi(pendingId, { content: text, pending: false });
  }

  private fallbackSummary(exploredPaths: string[] = []): string {
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
    if (this.chatMode !== 'agent') {
      return 'I do not have more to add yet. Tell me which part of the plan to apply.';
    }
    const ranked = this.rankCandidatePaths(exploredPaths);
    if (ranked.length) {
      return (
        `I narrowed it to these files but the API stalled before a verified edit landed:\n` +
        ranked
          .slice(0, 5)
          .map((p) => `• ${p}`)
          .join('\n') +
        `\n\nSend **continue** and I will read + patch the top match myself (I will not ask you to pick a file).`
      );
    }
    return (
      'I could not locate a confident target yet (search noise / API stall). ' +
      'Send **continue** with one exact UI label or open the file — I will keep searching and edit without asking you to pick.'
    );
  }

  /** Prefer frontend UI sources when the user asked for frontend-only work. */
  private isFrontendOnlyIntent(text: string): boolean {
    return /\b(only\s+frontend|frontend\s+only|ui\s+only|only\s+ui|sirf\s+frontend|frontend\s+par)\b/i.test(
      text || '',
    );
  }

  private rankCandidatePaths(paths: Iterable<string>, userText = ''): string[] {
    const frontendOnly = this.isFrontendOnlyIntent(userText);
    const scored = [...new Set([...paths].map((p) => p.replace(/\\/g, '/')))].map((p) => {
      const lower = p.toLowerCase();
      let score = 0;
      if (/\.(html|htm|tsx|jsx|vue|svelte|scss|css)$/i.test(p)) score += 40;
      if (/\.(ts|js)$/i.test(p) && !/\.(spec|test)\./i.test(p)) score += 20;
      if (/frontend|src\/app|components?\//i.test(lower)) score += 30;
      if (/bulk-upload|upload/i.test(lower)) score += 15;
      if (/backend|migrations?|models?\//i.test(lower)) score -= 35;
      if (/\.spec\.|\.test\./i.test(lower)) score -= 20;
      if (frontendOnly && /backend|migrations?|models?\//i.test(lower)) score -= 80;
      if (frontendOnly && /\.(html|scss|css|tsx|jsx|vue)$/i.test(p)) score += 25;
      return { p, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.p);
  }

  private async buildRepositoryContext(query: string): Promise<{
    context: string;
    candidates: string[];
  }> {
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

  private async runAgentLoop(pendingId: string): Promise<string> {
    const latestUser = [...this.history].reverse().find((m) => m.role === 'user')?.content || '';
    const liveTestIntent = this.isLiveTestIntent(latestUser);
    const maxSteps =
      this.chatMode === 'ask' ? 16 : this.chatMode === 'agent' ? (liveTestIntent ? 48 : 36) : 12;
    const active = this.editorService.currentResource?.uri.codeUri.fsPath;
    const casual = this.isCasualMessage(latestUser);

    // Auto checkpoint at start of agent work
    if (this.chatMode === 'agent' && !casual) {
      this.createCheckpoint('Before turn');
    }

    const projectRules = this.getProjectRules();

    // Cursor-class: never block first token. Soft-wait ~180ms for warm cache;
    // otherwise start LLM immediately and inject dossier when ready.
    let repositoryContext = '';
    let candidatePaths: string[] = [];
    let researchInjected = false;
    let lateResearch: { context: string; candidates: string[] } | null = null;
    let researchPromise: Promise<{ context: string; candidates: string[] }> | null = null;
    if (!casual) {
      this.pushActivity(pendingId, 'indexing', 'Scanning workspace…');
      researchPromise = this.buildRepositoryContext(latestUser);
      researchPromise.then((r) => {
        lateResearch = r;
      }).catch(() => {
        lateResearch = { context: '', candidates: [] };
      });
      const soft = await Promise.race([
        researchPromise.then((r) => ({ ready: true as const, r })),
        sleep(180).then(() => ({ ready: false as const, r: null })),
      ]);
      if (soft.ready && soft.r) {
        repositoryContext = soft.r.context;
        candidatePaths = [...soft.r.candidates];
        researchInjected = true;
        lateResearch = soft.r;
        this.completeLastActivity(
          pendingId,
          candidatePaths.length
            ? `Found ${candidatePaths.length} likely targets`
            : 'Index ready — exploring with tools',
        );
      } else {
        this.setStatus('Agent thinking…');
      }
    }

    const option = findModel(this.modelId);
    // Keep API payloads small — Cursor-style token discipline.
    const recentHistory = this.history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .filter((m) => !m.tool_calls?.length)
      .map((m) => ({
        role: m.role,
        content:
          typeof m.content === 'string' && m.content.length > 6_000
            ? `${m.content.slice(0, 6_000)}\n/* truncated */`
            : m.content,
      }))
      .slice(-6);

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
      messages.push({
        role: 'system',
        content:
          `LIVE BROWSER TASK — prioritize tools now:\n` +
          `1) Call live_test${url ? ` with url=${url}` : ' (or browser_goto the URL the user gave)'} headed=true.\n` +
          `2) browser_snapshot → login/create-program flow with the credentials the user gave.\n` +
          `3) browser_console + browser_network for errors; fix code only if the UI fails.\n` +
          `Do NOT spend many rounds only reading backend helpers — open the browser first.`,
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
    const maxAutoContinues = 12;
    const maxResearchNudges = 4;
    const maxImplementNudges = 8;
    const maxRejectNudges = 6;
    const frontendOnly = this.isFrontendOnlyIntent(latestUser);
    const exploredPaths = new Set<string>(
      this.rankCandidatePaths(candidatePaths.slice(0, 12), latestUser).slice(0, 8),
    );

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
      for (const p of this.rankCandidatePaths(lateResearch.candidates, latestUser)) {
        candidatePaths.push(p);
        exploredPaths.add(p);
      }
      if (lateResearch.context) {
        messages.splice(1, 0, { role: 'system', content: lateResearch.context });
        this.completeLastActivity(
          pendingId,
          lateResearch.candidates.length
            ? `Mapped ${lateResearch.candidates.length} module targets`
            : 'Workspace scan complete',
        );
      }
    };

    for (let step = 0; step < maxSteps; step++) {
      if (this.cancelRequested) {
        return 'Stopped by user.';
      }

      tryInjectLateResearch();

      this.setStatus(
        step === 0
          ? this.chatMode === 'agent'
            ? 'Agent thinking…'
            : this.chatMode === 'ask'
              ? 'Ask thinking…'
              : 'Planning…'
          : `${this.chatMode === 'agent' ? 'Agent' : this.chatMode === 'ask' ? 'Ask' : 'Plan'} working…`,
      );
      if (step === 0) {
        this.pushActivity(pendingId, 'thinking', 'Thinking…');
      }

      const tools = selectAgentTools({
        mode: this.chatMode,
        liveTest: liveTestIntent,
        madeEdits,
        searchCount,
        readCount,
      });

      let result;
      try {
        // Stream tool rounds for live Cursor-like activity (Poolside/Ollama SSE).
        // Fall back to non-stream inside invokeCompletion if provider breaks.
        result = await this.invokeCompletionResilient(pendingId, {
          messages,
          tools,
          toolChoice: 'auto',
          modelId: this.modelId,
          stream: true,
          maxTokens: routingMaxTokens(step, madeEdits),
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
          return this.fallbackSummary([...exploredPaths]);
        }
        // Still no edits — keep trying once more with forced non-stream path via continue budget
        if (autoContinues < maxAutoContinues && step < maxSteps - 1 && !this.cancelRequested) {
          autoContinues++;
          this.shrinkAgentMessages(messages, autoContinues + 2);
          messages.push({
            role: 'user',
            content:
              `Provider error — recover and FINISH with tools. Never ask the user to pick a file. ` +
              `read_file the best frontend HTML/TS hit → search_replace. Request: "${latestUser.slice(0, 320)}"`,
          });
          this.pushActivity(pendingId, 'info', `Recovering from provider error (${autoContinues})`);
          await sleep(500);
          continue;
        }
        throw e;
      }

      if (this.cancelRequested) {
        return 'Stopped by user.';
      }

      const content = (result.content || '').trim();
      const toolCalls = result.tool_calls;

      if (toolCalls?.length) {
        usedTools = true;
        this.completeLastActivity(pendingId);
        if (content) {
          this.pushActivity(pendingId, 'thinking', 'Thought', undefined, true, {
            resultPreview: content.slice(0, 4000),
          });
        }
        messages.push({
          role: 'assistant',
          content: content || null,
          tool_calls: toolCalls,
        });

        const toolResults = await this.executeToolCallsParallel(pendingId, toolCalls);

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
            } else if (/EDIT (REJECTED|BLOCKED)|search_replace failed|failed:/i.test(toolResult)) {
              editRejected++;
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

        // If the last round only produced rejected edits, force a retry nudge
        // before the model can invent a fake "done" reply.
        if (
          editRejected > 0 &&
          !madeEdits &&
          this.requiresImplementation(latestUser) &&
          rejectNudges < maxRejectNudges &&
          step < maxSteps - 1
        ) {
          rejectNudges++;
          messages.push({
            role: 'user',
            content:
              `Your last edit(s) were REJECTED by the syntax/structure verifier — nothing was saved. ` +
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
        continue;
      }

      const minimumReads = candidatePaths.length >= 4 ? 2 : 1;
      const needsResearch =
        this.chatMode === 'agent' &&
        !casual &&
        this.isWorkRequest(latestUser) &&
        !madeEdits &&
        (readCount < minimumReads || searchCount + readCount < 1);

      const looksLost =
        !content ||
        this.looksLikePassiveOrFakeEdit(content, usedTools) ||
        this.looksLikeCannotFind(content) ||
        this.looksLikeAskUserToPickFile(content);

      // Force Cursor-style research: don't accept "can't find / done" until files were read.
      if (needsResearch && researchNudges < maxResearchNudges && step < maxSteps - 1) {
        researchNudges++;
        if (content) {
          messages.push({ role: 'assistant', content });
        }
        const hintPaths = this.rankCandidatePaths(exploredPaths, latestUser).slice(0, 6);
        const pathHint = hintPaths.length
          ? `Start by read_file on these ranked candidates:\n${hintPaths.map((p) => `- ${p}`).join('\n')}`
          : `Call exact_code_search with the user's exact UI labels, then read the top hits.`;
        messages.push({
          role: 'user',
          content:
            `Stop. You have not finished research. ${pathHint}\n` +
            `Then apply the requested changes with search_replace/write_file. ` +
            `Read at least ${minimumReads} evidence files. NEVER ask which file is correct. ` +
            `Retry ${researchNudges}/${maxResearchNudges}. Request: "${latestUser.slice(0, 400)}"`,
        });
        this.setStatus('Digging deeper…');
        this.pushActivity(
          pendingId,
          'searching',
          `Still researching… (${researchNudges}/${maxResearchNudges})`,
        );
        continue;
      }

      if (
        this.chatMode === 'agent' &&
        !casual &&
        this.requiresImplementation(latestUser) &&
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
        (madeEdits ||
          !this.requiresImplementation(latestUser) ||
          this.chatMode !== 'agent' ||
          this.looksLikeAskUserToPickFile(content) === false)
      ) {
        if (
          this.chatMode === 'agent' &&
          this.requiresImplementation(latestUser) &&
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
        this.pushActivity(pendingId, 'done', 'Completed', undefined, true);
        return content;
      }

      if (usedTools || madeEdits) {
        if (
          !madeEdits &&
          this.chatMode === 'agent' &&
          this.requiresImplementation(latestUser) &&
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
        this.setStatus('Writing summary…');
        this.pushActivity(pendingId, 'thinking', 'Writing summary…');
        messages.push({
          role: 'user',
          content:
            'Tools finished. Write a Cursor-style completion: (1) 1–3 sentences on what changed and why, ' +
            '(2) a short **Suggested checks** list (2–3 concrete steps). Do not call tools. Never reply empty.',
        });
        try {
          const summary = await this.invokeCompletionResilient(pendingId, {
            messages,
            tools: AGENT_TOOLS,
            toolChoice: 'none',
            modelId: this.modelId,
            stream: true,
            maxTokens: 500,
          });
          const s = (summary.content || '').trim();
          if (s) {
            this.completeLastActivity(pendingId, 'Done', true);
            this.pushActivity(pendingId, 'done', 'Completed', undefined, true);
            return s;
          }
        } catch {
          // Summary is optional once edits landed.
        }
        this.pushActivity(pendingId, 'done', 'Completed', undefined, true);
        return this.fallbackSummary(this.rankCandidatePaths(exploredPaths, latestUser));
      }

      return this.fallbackSummary(this.rankCandidatePaths(exploredPaths, latestUser));
    }

    return this.fallbackSummary(this.rankCandidatePaths(exploredPaths, latestUser));
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
    } catch {
      // plain text result
    }
    this.completeLastActivity(pendingId, undefined, ok, { resultPreview, exitCode });
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
    const short = typeof pathHint === 'string' ? pathHint.slice(0, 72) : '';
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
          label: short ? `Searching ${short}` : `Running ${name}…`,
          detail: short,
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
        m.activity = {
          ...m.activity,
          ...extra,
          done,
          label: label || m.activity.label,
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
      /rephrase the change/i.test(lower)
    );
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

  /** Looks like the user wants code/file work done. */
  private isWorkRequest(text: string): boolean {
    const t = (text || '').toLowerCase();
    if (t.length < 2) {
      return false;
    }
    return /\b(fix|edit|change|update|rename|create|add|remove|delete|seo|keyword|meta|title|refactor|bug|error|implement|build|make|write|patch|file|code|css|html|js|ts|react|project|folder|readme|feature|module|timeline|analyze|analyse|understand|inspect|investigate|architecture|performance|optimize|banao|bana|karo|karna|likho|badlo|samjho|samajh|dekho|hatana|hatao)\b/i.test(
      t,
    );
  }

  private requiresImplementation(text: string): boolean {
    const t = (text || '').toLowerCase();
    return /\b(fix|change|update|edit|add|remove|delete|create|implement|build|make|patch|refactor|optimi[sz]e|not working|broken|bug|error|issue|problem|nahi|nahin|karo|karna|banao|badlo|hatao)\b/i.test(
      t,
    );
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
            // Only paint into the bubble for final prose (no tools). During tool
            // rounds, show Thought activity instead so the timeline stays clean.
            if (request.toolChoice === 'none') {
              this.patchUi(pendingId, { content: state.text, pending: true });
            } else if (state.text.trim().length > 8) {
              this.setStatus('Thinking…');
            }
          }
          if (state.toolNames?.length) {
            for (const raw of state.toolNames) {
              const name = this.normalizeToolName(raw);
              if (name && !announcedTools.has(name)) {
                announcedTools.add(name);
                this.pushActivity(pendingId, 'info', `Planning ${name}…`, name, false, {
                  toolName: name,
                });
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
          this.setStatus(`Grepping ${args.query}…`);
          return await this.toolGrep(
            String(args.query || ''),
            args.max_results != null ? Number(args.max_results) : 40,
          );
        case 'read_file':
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
    if (fromConfig && fs.existsSync(fromConfig)) {
      return fromConfig;
    }
    return process.cwd();
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
