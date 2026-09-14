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
    /Agent mode: edit or write/i.test(t) ||
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

function toolLabel(part: any): string {
  const name = String(part.tool || part.name || 'tool').toLowerCase();
  const input = part.state?.input || part.input || {};
  const file = String(input.path || input.file_path || input.filePath || input.target_file || '').replace(/\\/g, '/');
  const base = file.split('/').pop();
  if (/edit|write|apply_patch|str_replace/.test(name)) return base ? 'Editing ' + base : 'Editing file';
  if (/read/.test(name)) return base ? 'Reading ' + base : 'Reading file';
  if (/grep|search|glob/.test(name)) return base ? 'Searching ' + base : 'Searching the workspace';
  if (/bash|shell|cmd/.test(name)) return 'Running command';
  if (/webfetch|web_search/.test(name)) return 'Looking something up';
  if (/task|explore/.test(name)) return 'Working in the workspace';
  return part.state?.title || 'Using tools';
}

function extractFilePath(part: any): string {
  const input = part.state?.input || part.input || {};
  const meta = part.state?.metadata || {};
  return String(
    input.path || input.file_path || input.filePath || input.target_file || meta.filepath || meta.path || '',
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

function lineDiff(before: string | null, after: string | null): { add: number; del: number } {
  const oldLines = String(before || '').split('\n');
  const newLines = String(after || '').split('\n');
  if (before == null && after != null) return { add: newLines.length, del: 0 };
  if (before != null && after == null) return { add: 0, del: oldLines.length };
  const bag = new Map<string, number>();
  for (const line of oldLines) bag.set(line, (bag.get(line) || 0) + 1);
  let add = 0;
  for (const line of newLines) {
    const n = bag.get(line) || 0;
    if (n > 0) bag.set(line, n - 1);
    else add += 1;
  }
  let del = 0;
  for (const n of bag.values()) del += n;
  return { add, del };
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
};

export class OlkilSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'olkil.sidebar';
  private view?: vscode.WebviewView;
  private session: OlkilSession | null = null;
  private quota: OlkilQuota | null = null;
  private engine = new OlkilEngine();
  private liveText = '';
  private engineReady = false;
  private userMessageIds = new Set<string>();
  private turnUsage: ReturnType<typeof parseUsageBlob> = null;
  private turnGenIds = new Set<string>();
  private turnCharged = false;
  private charging = false;
  private modelId = DEFAULT_MODEL_ID;
  private turnFiles = new Map<string, FileChangeRow>();
  private customs: CustomEndpoint[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly context?: vscode.ExtensionContext,
  ) {
    this.engine.onEvent((event) => this.onEngineEvent(event));
    this.modelId = String(this.context?.globalState.get('olkil.modelId') || DEFAULT_MODEL_ID);
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
    void this.view?.webview.postMessage(msg);
  }

  async boot() {
    this.session = await ensureSession();
    if (this.session) {
      try {
        this.quota = await fetchQuota(this.session);
      } catch {
        this.quota = null;
      }
    }
    this.pushAuth();
    void this.loadModelCatalog();
    if (this.session && (canUseVscodeAgent(this.quota) || this.canRunCustom())) {
      void this.ensureEngine().catch((err) => {
        this.post({ type: 'error', text: err instanceof Error ? err.message : String(err) });
      });
    }
  }

  private canRunCustom() {
    return Boolean(this.activeCustom() && customEndpointReady(this.activeCustom()));
  }

  private canRunCloud() {
    return canUseVscodeAgent(this.quota);
  }

  private canRunAgent() {
    return this.canRunCustom() || this.canRunCloud();
  }

  private pushAuth() {
    void vscode.commands.executeCommand('setContext', 'olkil.signedIn', Boolean(this.session));
    this.post({
      type: 'auth',
      signedIn: Boolean(this.session),
      user: this.session?.user || null,
      quota: this.quota,
      engineReady: this.engineReady,
      paid: this.canRunCloud(),
      chatOpen: Boolean(this.session),
      plans: PAID_PLANS,
      models: pickerModels(this.customs),
      modelId: this.modelId,
      customs: this.customs.map((c) => ({
        id: c.id,
        model: c.model,
        baseUrl: c.baseUrl,
        hasKey: Boolean(c.apiKey),
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
    try {
      this.quota = await fetchQuota(this.session);
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
    this.pushAuth();
    void this.loadModelCatalog();
    if (this.canRunAgent()) {
      await this.ensureEngine();
    }
  }

  signOut() {
    clearSession();
    this.session = null;
    this.quota = null;
    this.engine.dispose();
    this.engine = new OlkilEngine();
    this.engine.onEvent((event) => this.onEngineEvent(event));
    this.engineReady = false;
    this.pushAuth();
  }

  async newChat() {
    if (!this.session) return;
    if (this.canRunAgent()) {
      await this.ensureEngine();
      await this.engine.newSession();
    }
    this.liveText = '';
    this.userMessageIds.clear();
    this.turnUsage = null;
    this.turnGenIds.clear();
    this.turnCharged = false;
    this.charging = false;
    this.turnFiles.clear();
    this.post({ type: 'reset' });
  }

  async ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!this.session) {
      await this.signIn();
      if (!this.session) return;
    }
    try {
      this.quota = await fetchQuota(this.session);
    } catch {
      /* keep last quota */
    }
    if (isAddCustomModel(this.modelId) || (isCustomModel(this.modelId) && !this.canRunCustom())) {
      this.post({ type: 'user', text: trimmed });
      this.post({
        type: 'error',
        text: 'Add model id, base URL, and API key in Custom at the top, then send again.',
      });
      return;
    }
    if (!this.canRunAgent()) {
      this.post({ type: 'user', text: trimmed });
      this.pushAuth();
      this.post({ type: 'upgrade' });
      return;
    }
    this.post({ type: 'user', text: trimmed });
    this.liveText = '';
    this.userMessageIds.clear();
    this.turnUsage = null;
    this.turnGenIds.clear();
    this.turnCharged = false;
    this.charging = false;
    this.turnFiles.clear();
    this.post({ type: 'activity', id: 'working', label: 'Working…', done: false });
    try {
      await this.ensureEngine();
      await this.engine.sendPrompt(this.withEditorContext(trimmed), this.modelId);
    } catch (err) {
      this.post({ type: 'error', text: err instanceof Error ? err.message : String(err) });
      this.post({ type: 'idle' });
    }
  }

  async abort() {
    await this.engine.abort();
    this.post({ type: 'idle' });
  }

  private withEditorContext(text: string): string {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return text;
    const file = vscode.workspace.asRelativePath(editor.document.uri);
    const selected = editor.selection.isEmpty ? '' : editor.document.getText(editor.selection);
    const bits = [text, 'Active file: ' + file];
    if (selected.trim()) {
      bits.push('Selected code from ' + file + ':\n```\n' + selected.slice(0, 12000) + '\n```');
    }
    return bits.join('\n\n');
  }

  private async ensureEngine() {
    if (!this.session) throw new Error('Sign in first.');
    await this.engine.ensureStarted(
      this.session,
      workspaceFolder(),
      this.readyCustoms(),
      this.canRunCloud(),
    );
    this.engineReady = true;
    this.pushAuth();
  }

  private onEngineEvent(raw: Record<string, unknown>) {
    const event = unwrapEvent(raw);
    const type = String(event.type || '');
    const props = (event.properties || {}) as Record<string, any>;
    if (type === 'permission.asked' || type === 'permission.updated') {
      const id = permissionId(event);
      if (id) void this.engine.replyPermission(id, 'always');
      return;
    }
    if (type === 'question.asked') {
      return;
    }
    if (type === 'todo.updated') {
      const todos = props.todos || [];
      const active = todos.find((t: any) => t.status === 'in_progress') || todos[0];
      if (active?.content) {
        this.post({
          type: 'activity',
          id: 'todo',
          label: String(active.content).slice(0, 120),
          done: active.status === 'completed',
        });
      }
      return;
    }
    if (type === 'file.edited') {
      const filePath = String(props.file || '');
      if (filePath) {
        this.noteFile(filePath, 0, 0);
        this.post({ type: 'activity', id: 'edit-' + filePath, label: 'Editing ' + filePath.split(/[\\/]/).pop(), done: false });
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
        this.post({ type: 'activity', id: 'thinking', label: 'Working…', done: false });
        return;
      }
      if (part.type === 'tool') {
        const path = extractFilePath(part);
        const done = part.state?.status === 'completed' || part.state?.status === 'error';
        this.post({
          type: 'activity',
          id: String(part.callID || part.id || toolLabel(part)),
          label: toolLabel(part),
          done,
        });
        if (path && /edit|write|patch|apply/i.test(String(part.tool || ''))) {
          this.noteFile(path, 0, 0, part.state?.status === 'pending' || part.state?.status === 'running');
        }
        return;
      }
      if (part.type === 'patch' && Array.isArray(part.files)) {
        for (const file of part.files) this.noteFile(String(file), 0, 0);
        return;
      }
      const text = eventText(event);
      if (!text || isUserEcho(text)) return;
      if (/insufficient balance/i.test(text)) {
        this.post({ type: 'error', text: friendlyEngineError(text) });
        return;
      }
      this.post({ type: 'activity', id: 'thinking', label: 'Thought', done: true });
      this.post({ type: 'activity', id: 'working', label: 'Writing', done: false });
      const isDelta =
        type === 'message.part.delta' || (typeof props.delta === 'string' && !part.text);
      this.liveText = isDelta ? this.liveText + text : text;
      const cleaned = cleanAssistantText(this.liveText);
      if (!cleaned) return;
      this.liveText = cleaned;
      this.post({ type: 'assistant', text: this.liveText, live: true });
      return;
    }
    if (type === 'session.error') {
      const err = props.error;
      const msg =
        (err && (err.data?.message || err.message || err.name)) ||
        (typeof err === 'string' ? err : 'The coding engine hit an error.');
      this.post({ type: 'error', text: friendlyEngineError(String(msg)) });
      this.post({ type: 'idle' });
      return;
    }
    if (type === 'session.idle') {
      const cleaned = cleanAssistantText(this.liveText);
      if (cleaned && !isUserEcho(cleaned) && !/insufficient balance/i.test(cleaned)) {
        this.liveText = cleaned;
        this.post({ type: 'assistant', text: this.liveText, live: false });
      }
      this.post({ type: 'idle' });
      void this.finishTurn();
    }
  }

  private noteFile(filePath: string, additions: number, deletions: number, snapshotOnly = false) {
    const rel = String(filePath || '').trim();
    if (!rel) return;
    const abs = resolveAbs(rel);
    const prev = this.turnFiles.get(abs) || this.turnFiles.get(rel);
    const before = prev?.before !== undefined ? prev.before : readFileSafe(abs);
    if (snapshotOnly && !prev) {
      this.turnFiles.set(abs, {
        path: rel,
        abs,
        additions: 0,
        deletions: 0,
        status: 'pending',
        before,
      });
      this.pushFiles();
      return;
    }
    const after = readFileSafe(abs);
    const counted =
      additions || deletions
        ? { add: additions, del: deletions }
        : lineDiff(prev?.before ?? before, after);
    this.turnFiles.set(abs, {
      path: rel,
      abs,
      additions: Math.max(counted.add, prev?.additions || 0),
      deletions: Math.max(counted.del, prev?.deletions || 0),
      status: prev?.status === 'accepted' || prev?.status === 'reverted' ? prev.status : 'pending',
      before: prev?.before ?? before,
    });
    this.pushFiles();
  }

  private applyDiffs(raw: unknown) {
    const list = Array.isArray(raw) ? raw : (raw as any)?.diff;
    if (!Array.isArray(list)) return;
    for (const d of list) {
      const path = String(d.file || d.path || d.filename || '');
      if (!path) continue;
      let add = Number(d.additions || d.added || 0);
      let del = Number(d.deletions || d.removed || 0);
      if ((!add && !del) && (d.patch || d.diff)) {
        const c = countLines(String(d.patch || d.diff));
        add = c.add;
        del = c.del;
      }
      this.noteFile(path, add, del);
    }
  }

  private pushFiles() {
    const files = [...this.turnFiles.values()].map((f) => ({
      path: f.abs || f.path,
      name: (f.abs || f.path).replace(/\\/g, '/').split('/').pop() || f.path,
      additions: f.additions,
      deletions: f.deletions,
      status: f.status,
    }));
    if (files.length) this.post({ type: 'files', files });
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
    await this.chargeTurn();
    await this.refreshQuotaAfterTurn();
    if (this.quota && !this.canRunAgent()) {
      this.pushAuth();
      this.post({ type: 'upgrade' });
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
      const c = lineDiff(row.before, after);
      row.additions = Math.max(row.additions, c.add);
      row.deletions = Math.max(row.deletions, c.del);
    }
    this.pushFiles();
  }

  private async chargeTurn() {
    if (this.turnCharged || this.charging || !this.session) return;
    if (this.canRunCustom() && !this.canRunCloud()) {
      this.turnCharged = true;
      return;
    }
    if (isCustomModel(this.modelId)) {
      this.turnCharged = true;
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
        await this.ask(String(msg.text || ''));
        break;
      case 'abort':
        await this.abort();
        break;
      case 'newChat':
        await this.newChat();
        break;
      case 'setModel':
        this.modelId = String(msg.modelId || DEFAULT_MODEL_ID);
        void this.context?.globalState.update('olkil.modelId', this.modelId);
        this.pushAuth();
        break;
      case 'saveCustom': {
        const model = String(msg.model || '').trim();
        const baseUrl = String(msg.baseUrl || '').trim();
        const incomingKey = typeof msg.apiKey === 'string' ? msg.apiKey.trim() : '';
        let id = String(msg.id || customIdFromModelId(this.modelId) || '').trim();
        const existing = id ? this.customs.find((c) => c.id === id) : undefined;
        if (!existing) id = newCustomId();
        const apiKey = incomingKey || existing?.apiKey || '';
        const row: CustomEndpoint = { id, model, baseUrl, apiKey };
        if (!customEndpointReady(row)) {
          this.post({ type: 'error', text: 'Add model id, base URL, and API key, then save.' });
          break;
        }
        this.customs = existing
          ? this.customs.map((c) => (c.id === id ? row : c))
          : this.customs.concat(row);
        await this.persistCustoms();
        this.modelId = customPickerId(id);
        void this.context?.globalState.update('olkil.modelId', this.modelId);
        this.pushAuth();
        break;
      }
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
      default:
        break;
    }
  }

  private html(webview: vscode.Webview): string {
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'webview', 'sidebar.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'webview', 'sidebar.js'));
    const icon = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png'));
    const nonce = String(Date.now());
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <link rel="stylesheet" href="${css}" />
</head>
<body>
  <div id="app" data-icon="${icon}"></div>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  dispose() {
    this.engine.dispose();
  }
}
