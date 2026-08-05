import { Autowired, Injectable } from '@opensumi/di';
import { Emitter, Event, URI, Disposable } from '@opensumi/ide-core-common';
import { AppConfig } from '@opensumi/ide-core-browser';
import { WorkbenchEditorService } from '@opensumi/ide-editor';
import { IEditorDocumentModelService } from '@opensumi/ide-editor/lib/browser';
import { IFileServiceClient } from '@opensumi/ide-file-service/lib/common';
import { IWorkspaceService } from '@opensumi/ide-workspace/lib/common';
import * as path from 'path';
import {
  ChatAttachment,
  ChatMessage,
  ChatToolCall,
  FileChangeInfo,
  FileChangeKind,
  IOlkilAiNodeService,
  IOlkilChatService,
  OlkilAiNodeServicePath,
  OllamaDownloadUiState,
  UiChatMessage,
} from '../common';
import { AI_MODELS, DEFAULT_MODEL_ID, findModel, publicModelName } from '../common/models';
import { buildSystemPrompt, AGENT_TOOLS, DEFAULT_CHAT_MODE, ChatMode } from '../common/tools';
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

  private history: ChatMessage[] = [];
  private cancelRequested = false;
  /** Files the agent has actually read — edits to unread files are blocked. */
  private filesReadThisSession = new Set<string>();
  /** Snapshots needed to revert agent edits */
  private snapshots = new Map<string, ChangeSnapshot>();
  private diffDecorations?: OlkilDiffDecorationManager;

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
    if (mode !== 'agent' && mode !== 'plan') {
      return;
    }
    this.chatMode = mode;
    this.pushUi(
      'status',
      mode === 'agent'
        ? 'Agent mode — will explore & edit files on its own.'
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
    if ((!text && !attachments.length) || this.busy) {
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
    this.pushUi('user', display || '(attachments)');

    const enriched = await this.buildUserContentWithAttachments(text, attachments);
    this.history.push({ role: 'user', content: enriched });

    const pendingId = nextId();
    this.messages.push({ id: pendingId, role: 'assistant', content: '', pending: true });
    this.setStatus(this.chatMode === 'agent' ? 'Agent thinking…' : 'Planning…');

    try {
      const reply = await this.runAgentLoop(pendingId);
      const finalText = (reply || '').trim() || this.fallbackSummary();
      await this.typeOut(pendingId, finalText);
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
    }
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
    if (!root || !fs.existsSync(root)) {
      return [];
    }
    const q = (query || '').trim().toLowerCase().replace(/^@/, '');
    const results: ChatAttachment[] = [];
    this.walkFiles(root, (abs) => {
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      const base = path.basename(abs).toLowerCase();
      if (!q || base.includes(q) || rel.toLowerCase().includes(q)) {
        results.push({ path: abs, name: rel, kind: 'file' });
      }
      return results.length < limit ? undefined : false;
    });
    // Also include top-level folders matching query
    try {
      for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
        if (!ent.isDirectory() || SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) {
          continue;
        }
        if (!q || ent.name.toLowerCase().includes(q)) {
          results.unshift({
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

  /** Progressive reveal so replies feel live (ChatGPT/Cursor style). */
  private async typeOut(pendingId: string, full: string) {
    const text = full || '';
    if (!text) {
      this.patchUi(pendingId, { content: this.fallbackSummary(), pending: false });
      return;
    }
    // If text already streamed into the bubble, just finalize
    const existing = this.messages.find((m) => m.id === pendingId)?.content || '';
    if (existing.length >= text.length - 2 && existing.trim()) {
      this.patchUi(pendingId, { content: text, pending: false });
      return;
    }

    let i = existing.length;
    if (i > text.length) {
      i = 0;
    }
    while (i < text.length) {
      if (this.cancelRequested) {
        break;
      }
      // Adaptive speed: short replies feel typed, long replies never crawl.
      // Whole reveal is capped at ~1.2s regardless of length.
      const remaining = text.length - i;
      const step = Math.max(4, Math.ceil(remaining / 40));
      i = Math.min(text.length, i + step);
      this.patchUi(pendingId, { content: text.slice(0, i), pending: true });
      await sleep(8);
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
      return `Done. Here's what changed:\n${lines.join('\n')}`;
    }
    if (this.chatMode !== 'agent') {
      return 'I do not have more to add yet. Tell me which part of the plan to apply.';
    }
    if (exploredPaths.length) {
      return (
        `I found these likely targets but could not finish a verified edit yet:\n` +
        exploredPaths
          .slice(0, 8)
          .map((p) => `• ${p}`)
          .join('\n') +
        `\nTell me which one is correct, or rephrase the change — I will continue from there.`
      );
    }
    return (
      'I could not confidently locate the named module yet. ' +
      'Try naming it again (exact folder/module name helps), or open one file from that module and ask again.'
    );
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
      this.setStatus('Investigating code path…');
      // First index of a huge repo can take a while — never block the agent's
      // first reply past this budget; tools can investigate deeper later.
      const investigation = await Promise.race([
        this.aiNode.investigateRepository(root, query, 30),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 12_000)),
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
      const evidence = investigation.evidence.slice(0, 18).map((item, index) => {
        const link = item.from ? `${item.from} --${item.via}--> ${item.path}` : `seed → ${item.path}`;
        return `### E${index + 1} ${link} [${item.score}%]
why: ${item.reasons.join(' | ')}
symbols: ${item.symbols.slice(0, 12).join(', ') || '(none)'}
calls: ${item.calls.slice(0, 12).join(', ') || '(none)'}
API/routes: ${item.apiEndpoints.join(', ') || '(none)'}
${item.excerpt}`;
      });
      const trails = investigation.trails.length
        ? investigation.trails
            .slice(0, 8)
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
          context.length > 24_000
            ? `${context.slice(0, 24_000)}\n/* investigation dossier clipped */`
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
      this.chatMode === 'agent' ? (liveTestIntent ? 48 : 36) : 12;
    const active = this.editorService.currentResource?.uri.codeUri.fsPath;
    const casual = this.isCasualMessage(latestUser);
    const research = casual
      ? { context: '', candidates: [] as string[] }
      : await this.buildRepositoryContext(latestUser);
    const repositoryContext = research.context;
    const candidatePaths = [...research.candidates];

    const option = findModel(this.modelId);
    // Keep API payloads small — long histories cause provider 500s.
    const recentHistory = this.history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .filter((m) => !m.tool_calls?.length)
      .map((m) => ({
        role: m.role,
        content:
          typeof m.content === 'string' && m.content.length > 10_000
            ? `${m.content.slice(0, 10_000)}\n/* truncated */`
            : m.content,
      }))
      .slice(-10);

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: buildSystemPrompt(this.chatMode, this.workspaceRoot(), active, {
          provider: option.provider,
          model: option.model,
          label: option.label,
        }),
      },
      ...(repositoryContext
        ? [{ role: 'system' as const, content: repositoryContext }]
        : []),
      ...recentHistory,
    ];

    // Greetings / chitchat: no tools, no edits, ignore prior task momentum
    if (this.chatMode === 'agent' && casual) {
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
    let nudgeCount = 0;
    let autoContinues = 0;
    const maxAutoContinues = 8;
    const exploredPaths = new Set<string>(candidatePaths.slice(0, 8));
    const MUTATING_TOOLS = new Set([
      'search_replace',
      'create_file',
      'write_file',
      'rename_file',
      'delete_file',
    ]);

    for (let step = 0; step < maxSteps; step++) {
      if (this.cancelRequested) {
        return 'Stopped by user.';
      }

      this.setStatus(
        step === 0
          ? this.chatMode === 'agent'
            ? candidatePaths.length
              ? 'Researching module targets…'
              : 'Agent thinking…'
            : 'Planning…'
          : `${this.chatMode === 'agent' ? 'Agent' : 'Plan'} working (step ${step + 1})…`,
      );

      let result;
      try {
        // Tool rounds MUST be non-streaming — streaming+tools breaks Sarvam/OpenAI-compat
        result = await this.invokeCompletionResilient(pendingId, {
          messages,
          tools: AGENT_TOOLS,
          toolChoice: 'auto',
          modelId: this.modelId,
          stream: false,
          maxTokens: 1600,
        });
      } catch (e: any) {
        // Poolside often 500s on long thinking. Auto-continue like the user typing "continue".
        if (
          this.isTransientLlmError(e) &&
          autoContinues < maxAutoContinues &&
          step < maxSteps - 1 &&
          !this.cancelRequested
        ) {
          autoContinues++;
          this.shrinkAgentMessages(messages, autoContinues);
          messages.push({
            role: 'user',
            content:
              `API hiccup — continue automatically from where you left off. ` +
              `Do NOT restart finished work. Call tools only for remaining steps. ` +
              `Keep the final reply to 1–2 short sentences. ` +
              `Original request: "${latestUser.slice(0, 280)}"`,
          });
          this.setStatus(`Auto-continuing (${autoContinues}/${maxAutoContinues})…`);
          this.patchUi(pendingId, {
            content: `Provider hiccup — auto-continuing (${autoContinues}/${maxAutoContinues})…`,
            pending: true,
          });
          await sleep(600 + autoContinues * 250);
          continue;
        }
        if (madeEdits || usedTools) {
          return this.fallbackSummary([...exploredPaths]);
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
        if (content) {
          this.patchUi(pendingId, { content, pending: true });
        }
        messages.push({
          role: 'assistant',
          content: content || null,
          tool_calls: toolCalls,
        });

        for (const call of toolCalls) {
          if (this.cancelRequested) {
            return 'Stopped by user.';
          }
          const name = call.function?.name || '';
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
          const toolResult = await this.executeTool(call);
          this.collectExploredPaths(toolResult, exploredPaths);

          // Cursor-style: only count REAL successful mutations. Rejected /
          // blocked edits must NOT look like progress — otherwise the agent
          // stops after a broken patch and claims "done".
          if (MUTATING_TOOLS.has(name)) {
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

          const toolCap = name === 'investigate_codepath' ? 16_000 : 6000;
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
          nudgeCount < 6 &&
          step < maxSteps - 1
        ) {
          nudgeCount++;
          messages.push({
            role: 'user',
            content:
              `Your last edit(s) were REJECTED by the syntax/structure verifier — nothing was saved. ` +
              `This is how Cursor-class agents work: broken patches never land. ` +
              `Re-read the file region, write COMPLETE balanced code (every {([<> quote closed), ` +
              `and retry search_replace. Retry ${nudgeCount}/6. Request: "${latestUser.slice(0, 320)}"`,
          });
          this.setStatus('Fixing rejected edit…');
          this.patchUi(pendingId, {
            content: `Edit rejected — fixing syntax and retrying (${nudgeCount}/6)`,
            pending: true,
          });
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
        this.looksLikeCannotFind(content);

      // Force Cursor-style research: don't accept "can't find / done" until files were read.
      if (
        needsResearch &&
        nudgeCount < 6 &&
        step < maxSteps - 1
      ) {
        nudgeCount++;
        if (content) {
          messages.push({ role: 'assistant', content });
        }
        const hintPaths = [...exploredPaths].slice(0, 6);
        const pathHint = hintPaths.length
          ? `Start by read_file on these candidates:\n${hintPaths.map((p) => `- ${p}`).join('\n')}`
          : `Call find_module with the module name from the user request, then read the top hits.`;
        messages.push({
          role: 'user',
          content:
            `Stop. You have not finished research. ${pathHint}\n` +
            `Then apply the requested changes with search_replace/write_file. ` +
            `Read at least ${minimumReads} evidence files and follow their calls/imports. ` +
            `Retry ${nudgeCount}/6. Request: "${latestUser.slice(0, 400)}"`,
        });
        this.setStatus('Digging deeper into the project…');
        this.patchUi(pendingId, {
          content: `Still researching… checking module candidates (${nudgeCount}/6)`,
          pending: true,
        });
        continue;
      }

      if (
        this.chatMode === 'agent' &&
        !casual &&
        this.requiresImplementation(latestUser) &&
        !madeEdits &&
        nudgeCount < 6 &&
        step < maxSteps - 1 &&
        (looksLost || readCount >= minimumReads)
      ) {
        nudgeCount++;
        if (content) {
          messages.push({ role: 'assistant', content });
        }
        messages.push({
          role: 'user',
          content: `Do not stop. Execute the request with tools now (find_module → read_file → search_replace). Investigation retry ${nudgeCount}/6. Latest request: "${latestUser.slice(0, 400)}"`,
        });
        this.setStatus('Agent working…');
        continue;
      }

      if (content) {
        return content;
      }

      if (usedTools || madeEdits) {
        this.setStatus('Writing summary…');
        messages.push({
          role: 'user',
          content:
            'Tools finished. Reply in 1–3 short sentences confirming what you changed. Do not call tools. Never reply empty.',
        });
        try {
          const summary = await this.invokeCompletionResilient(pendingId, {
            messages,
            tools: AGENT_TOOLS,
            toolChoice: 'none',
            modelId: this.modelId,
            stream: true,
            maxTokens: 400,
          });
          const s = (summary.content || '').trim();
          if (s) {
            return s;
          }
        } catch {
          // Summary is optional once edits landed.
        }
        return this.fallbackSummary([...exploredPaths]);
      }

      return this.fallbackSummary([...exploredPaths]);
    }

    return usedTools || madeEdits
      ? this.fallbackSummary([...exploredPaths])
      : 'Stopped after too many tool steps. Try naming the module more exactly or open one file from it.';
  }

  private collectExploredPaths(toolResult: string, into: Set<string>) {
    try {
      const parsed = JSON.parse(toolResult);
      const hits = parsed?.evidence || parsed?.hits || parsed?.files;
      if (Array.isArray(hits)) {
        for (const hit of hits.slice(0, 12)) {
          const p = typeof hit === 'string' ? hit : hit?.path;
          if (typeof p === 'string' && p.trim()) into.add(p.replace(/\\/g, '/'));
        }
      }
    } catch {
      const fileMatch = /^FILE:\s*(.+)$/m.exec(toolResult);
      if (fileMatch?.[1]) {
        into.add(fileMatch[1].trim().replace(/\\/g, '/'));
      }
    }
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
      /internal server error|bad gateway|service unavailable|gateway timeout|too many requests|rate limit|econnreset|etimedout|enotfound|network|fetch failed|socket hang up|temporarily unavailable/.test(
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
    const maxAttempts = 5;
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
                maxTokens: Math.min(request.maxTokens || 1600, attempt >= 4 ? 700 : attempt >= 3 ? 1000 : 1200),
                messages: this.cloneAndShrinkMessages(request.messages, attempt),
                stream: false as const,
              };
        if (attempt > 1) {
          this.setStatus(`Retrying AI (${attempt}/${maxAttempts})…`);
          this.patchUi(pendingId, {
            content: `Provider hiccup — retrying ${attempt}/${maxAttempts}…`,
            pending: true,
          });
          await sleep(700 * attempt + Math.floor(Math.random() * 500));
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
            this.patchUi(pendingId, { content: state.text, pending: true });
          }
          if (state.done) {
            break;
          }
        } catch {
          break;
        }
        await sleep(40);
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
      if (result.content) {
        this.patchUi(pendingId, { content: result.content, pending: true });
      }
      return result;
    } catch (e) {
      stopPoll = true;
      try {
        return await this.aiNode.chatCompletion({
          messages: request.messages,
          tools: request.tools,
          toolChoice: request.toolChoice,
          modelId: request.modelId,
          stream: false,
          maxTokens: request.maxTokens,
        });
      } catch {
        throw e;
      }
    }
  }

  private async executeTool(call: ChatToolCall): Promise<string> {
    const name = call.function?.name || '';
    let args: any = {};
    try {
      args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      return `Invalid JSON arguments for ${name}`;
    }

    try {
      switch (name) {
        case 'get_active_file':
          this.setStatus('Reading active file…');
          return await this.toolGetActiveFile();
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
    return /LIVE TEST MODE|live\s*test|browser.*(test|check|verify)|verify.*(browser|ui)|headed chromium|not working.*(browser|ui|page|button)/i.test(
      t,
    );
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
      const preview = buildDiffPreview(originalBefore, after);
      const summary = buildChangeSummary(originalBefore, after);

      const updated: FileChangeInfo = {
        ...prev,
        additions: stats.additions,
        deletions: stats.deletions,
        preview,
        summary,
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

      // Move card to end of chat so it stays near the latest agent activity
      this.messages.splice(existingIdx, 1);
      this.messages.push(msg);

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
    }

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

    // Native ripgrep on the node process: millisecond scans, gitignore-aware.
    const result = await this.aiNode.grepRepository(root, q, {
      maxResults: Math.max(1, Math.min(200, maxResults)),
    });
    if (result.engine === 'ripgrep') {
      return JSON.stringify({
        workspace: root,
        query: q,
        engine: 'ripgrep',
        elapsedMs: result.elapsedMs,
        truncated: result.truncated,
        count: result.matches.length,
        matches: result.matches.map((m) => ({ file: m.path, line: m.line, text: m.text })),
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
