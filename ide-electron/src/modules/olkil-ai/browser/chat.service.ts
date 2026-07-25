import { Autowired, Injectable } from '@opensumi/di';
import { Emitter, Event, URI, Disposable } from '@opensumi/ide-core-common';
import { AppConfig } from '@opensumi/ide-core-browser';
import { WorkbenchEditorService } from '@opensumi/ide-editor';
import { IEditorDocumentModelService } from '@opensumi/ide-editor/lib/browser';
import { IFileServiceClient } from '@opensumi/ide-file-service/lib/common';
import * as path from 'path';
import {
  ChatMessage,
  ChatToolCall,
  FileChangeInfo,
  FileChangeKind,
  IOlkilAiNodeService,
  IOlkilChatService,
  OlkilAiNodeServicePath,
  UiChatMessage,
} from '../common';
import { AI_MODELS, DEFAULT_MODEL_ID, findModel } from '../common/models';
import { buildSystemPrompt, AGENT_TOOLS, DEFAULT_CHAT_MODE, ChatMode } from '../common/tools';
import { buildChangeSummary, buildDiffPreview, countLineStats } from '../common/diff';
import { OlkilDiffDecorationManager } from './diff-decorations';
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
  models: Array<{ id: string; provider: string; model: string; label: string }> = AI_MODELS.map((m) => ({
    id: m.id,
    provider: m.provider,
    model: m.model,
    label: m.label,
  }));

  private history: ChatMessage[] = [];
  private cancelRequested = false;
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
      this.models = await this.aiNode.listModels();
      this.modelName = await this.aiNode.getModelName(this.modelId);
      const option = findModel(this.modelId);
      const ok = await this.aiNode.hasApiKey(option.provider);
      if (!ok) {
        this.pushUi(
          'status',
          `Missing API key for ${option.provider}. Add it to .env`,
        );
      }
      this.fire();
    } catch (e: any) {
      this.pushUi('status', `AI backend init error: ${e?.message || e}`);
    }
  }

  setModel(modelId: string) {
    if (this.busy) {
      return;
    }
    this.modelId = modelId;
    const option = findModel(modelId);
    this.modelName = option.model;
    this.pushUi('status', `Model switched to ${option.label}`);
    this.fire();
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
    await this.editorService.open(URI.file(target));
    if (change.status === 'pending') {
      // Re-paint red deleted zones after navigation
      this.decorations.refreshForOpenFile();
      this.decorations.applyViewZones(changeId);
    }
  }

  async send(userText: string) {
    const text = userText.trim();
    if (!text || this.busy) {
      return;
    }

    this.cancelRequested = false;
    this.busy = true;
    this.pushUi('user', text);
    this.history.push({ role: 'user', content: text });

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
      this.patchUi(pendingId, {
        content: `Error: ${e?.message || String(e)}`,
        pending: false,
      });
      this.setStatus('');
    } finally {
      this.busy = false;
      this.fire();
    }
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
      // ~2–6 chars per tick for natural typing speed
      const step = text.charCodeAt(i) < 128 ? 3 + (i % 3) : 1;
      i = Math.min(text.length, i + step);
      this.patchUi(pendingId, { content: text.slice(0, i), pending: true });
      await sleep(14);
    }
    this.patchUi(pendingId, { content: text, pending: false });
  }

  private fallbackSummary(): string {
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
    return this.chatMode === 'agent'
      ? 'Done — I checked the workspace and no file edits were needed.'
      : 'I do not have more to add yet. Tell me which part of the plan to apply.';
  }

  private async runAgentLoop(pendingId: string): Promise<string> {
    const maxSteps = this.chatMode === 'agent' ? 20 : 10;
    const active = this.editorService.currentResource?.uri.codeUri.fsPath;
    const latestUser = [...this.history].reverse().find((m) => m.role === 'user')?.content || '';
    const casual = this.isCasualMessage(latestUser);

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: buildSystemPrompt(this.chatMode, this.workspaceRoot(), active),
      },
      ...this.history,
    ];

    // Greetings / chitchat: no tools, no edits, ignore prior task momentum
    if (this.chatMode === 'agent' && casual) {
      const lightHistory: ChatMessage[] = this.history
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .filter((m) => !m.tool_calls?.length)
        .map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' }))
        .slice(-8);
      const casualMessages: ChatMessage[] = [
        {
          role: 'system',
          content:
            'You are OLKIL. The user sent a casual message (greeting/thanks/ack). Reply in ONE short friendly sentence. Do not mention SEO, keywords, or file edits. Do not continue previous coding tasks.',
        },
        ...lightHistory,
      ];
      this.setStatus('Replying…');
      const result = await this.invokeCompletion(pendingId, {
        messages: casualMessages,
        toolChoice: 'none',
        modelId: this.modelId,
        stream: true,
      });
      return (result.content || '').trim() || 'Hey — what should we work on?';
    }

    let usedTools = false;
    let madeEdits = false;
    let nudgeCount = 0;

    for (let step = 0; step < maxSteps; step++) {
      if (this.cancelRequested) {
        return 'Stopped by user.';
      }

      this.setStatus(
        step === 0
          ? this.chatMode === 'agent'
            ? 'Agent thinking…'
            : 'Planning…'
          : `${this.chatMode === 'agent' ? 'Agent' : 'Plan'} working (step ${step + 1})…`,
      );

      // Tool rounds MUST be non-streaming — streaming+tools breaks Sarvam/OpenAI-compat
      const result = await this.invokeCompletion(pendingId, {
        messages,
        tools: AGENT_TOOLS,
        toolChoice: 'auto',
        modelId: this.modelId,
        stream: false,
      });

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
          if (name === 'search_replace' || name === 'create_file' || name === 'write_file' || name === 'rename_file') {
            madeEdits = true;
          }
          const toolResult = await this.executeTool(call);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: toolResult,
          });
        }
        continue;
      }

      // Only nudge on REAL tasks when the model stalls / asks permission / fakes edits
      if (
        this.chatMode === 'agent' &&
        !casual &&
        this.isWorkRequest(latestUser) &&
        !madeEdits &&
        nudgeCount < 2 &&
        step < maxSteps - 1 &&
        content &&
        this.looksLikePassiveOrFakeEdit(content, usedTools)
      ) {
        nudgeCount++;
        messages.push({ role: 'assistant', content });
        messages.push({
          role: 'user',
          content: `Stop asking for permission. Execute my latest request now with tools (find_files/grep/list_dir → read_file → search_replace/create_file as needed). Latest request: "${latestUser.slice(0, 240)}"`,
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
        const summary = await this.invokeCompletion(pendingId, {
          messages,
          tools: AGENT_TOOLS,
          toolChoice: 'none',
          modelId: this.modelId,
          stream: true,
        });
        const s = (summary.content || '').trim();
        if (s) {
          return s;
        }
        return this.fallbackSummary();
      }

      return '';
    }

    return usedTools || madeEdits
      ? this.fallbackSummary()
      : 'Stopped after too many tool steps. Try a more specific request.';
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
    return /\b(fix|edit|change|update|rename|create|add|remove|delete|seo|keyword|meta|title|refactor|bug|error|implement|build|make|write|patch|file|code|css|html|js|ts|react|project|folder)\b/i.test(
      t,
    );
  }

  /** True when the model is stalling (asks permission) or claims edits without tools. */
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
    },
  ) {
    if (!request.stream) {
      return this.aiNode.chatCompletion({
        messages: request.messages,
        tools: request.tools,
        toolChoice: request.toolChoice,
        modelId: request.modelId,
        stream: false,
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
          return await this.toolCreateFile(String(args.path || ''), String(args.content ?? ''));
        case 'list_dir':
          this.setStatus(`Listing ${args.path || '.'}…`);
          return await this.toolListDir(args.path ? String(args.path) : '');
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (e: any) {
      return `Tool ${name} failed: ${e?.message || e}`;
    }
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
    return this.appConfig.workspaceDir || process.cwd();
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
    search: string,
    replace: string,
    replaceAll: boolean,
  ): Promise<string> {
    if (!inputPath) {
      return 'path is required';
    }
    if (!search) {
      return 'search is required (exact unique snippet from the file)';
    }

    const filePath = this.resolvePath(inputPath);
    const uri = URI.file(filePath);
    const ref = await this.docService.createModelReference(uri, 'olkil-ai');

    try {
      const monacoModel = ref.instance.getMonacoModel();
      let text = monacoModel.getValue();

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

      if (occurrences.length === 0) {
        return `search_replace failed: search text not found in ${filePath}. Re-read the file and use an exact unique snippet.`;
      }
      if (!replaceAll && occurrences.length > 1) {
        return `search_replace failed: search matched ${occurrences.length} times. Make search more unique, or set replace_all=true.`;
      }

      const targets = replaceAll ? occurrences : [occurrences[0]];
      let replaceText = replace;
      if (usedSearch.includes('\r\n') && !replace.includes('\r\n') && replace.includes('\n')) {
        replaceText = replace.replace(/\n/g, '\r\n');
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

      return JSON.stringify({
        ok: true,
        path: filePath,
        replacements: targets.length,
        chars_removed: usedSearch.length * targets.length,
        chars_added: replaceText.length * targets.length,
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

    const hits: Array<{ file: string; line: number; text: string }> = [];
    const textExt = new Set([
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '.json',
      '.md',
      '.html',
      '.css',
      '.less',
      '.scss',
      '.py',
      '.java',
      '.go',
      '.rs',
      '.txt',
      '.yml',
      '.yaml',
      '.xml',
      '.vue',
      '.svelte',
    ]);

    this.walkFiles(root, (abs) => {
      const ext = path.extname(abs).toLowerCase();
      if (ext && !textExt.has(ext)) {
        return;
      }
      let content = '';
      try {
        const stat = fs.statSync(abs);
        if (stat.size > 1_500_000) {
          return;
        }
        content = fs.readFileSync(abs, 'utf8');
      } catch {
        return;
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(q)) {
          hits.push({
            file: path.relative(root, abs).replace(/\\/g, '/'),
            line: i + 1,
            text: lines[i].trim().slice(0, 200),
          });
          if (hits.length >= maxResults) {
            return false;
          }
        }
      }
    });

    return JSON.stringify({
      workspace: root,
      query: q,
      count: hits.length,
      matches: hits,
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
    return JSON.stringify({ ok: true, from, to });
  }

  private async toolCreateFile(inputPath: string, content: string): Promise<string> {
    if (!inputPath) {
      return 'path is required';
    }
    const filePath = this.resolvePath(inputPath);
    const uri = URI.file(filePath);
    const exists = await this.fileService.access(uri.toString());
    if (exists) {
      return `File already exists: ${filePath}. Use search_replace to edit it (do not rewrite whole file).`;
    }
    await this.fileService.createFile(uri.toString(), { content });
    await this.editorService.open(uri);
    await this.recordFileChange({
      kind: 'create',
      path: filePath,
      beforeContent: null,
      afterContent: content,
    });
    return `Created ${filePath} (${content.length} chars)`;
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
