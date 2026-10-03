import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { OlkilEngine } from './engine';
import type { OlkilSession } from './auth';

export type VoAssigneeId = 'manager' | 'alex' | 'elon' | 'sophia' | 'robert' | 'jasmine';

export const VO_WORKERS: Array<{ id: Exclude<VoAssigneeId, 'manager'>; name: string; role: string }> = [
  { id: 'alex', name: 'Alex', role: 'Developer' },
  { id: 'elon', name: 'Elon', role: 'Developer' },
  { id: 'sophia', name: 'Sophia', role: 'Developer' },
  { id: 'robert', name: 'Robert', role: 'Developer' },
  { id: 'jasmine', name: 'Jasmine', role: 'QA' },
];

export const VO_ASSIGNEES: Array<{ id: VoAssigneeId; name: string; role: string }> = [
  { id: 'manager', name: 'Manager', role: 'Auto-assign' },
  ...VO_WORKERS,
];

export const MAX_VO_PARALLEL = 4;

export type VoRun = {
  workerId: string;
  workerName: string;
  workerRole: string;
  title: string;
  prompt: string;
  sessionId: string;
  status: 'running' | 'done' | 'failed';
  startedAt: number;
  log: Array<Record<string, unknown>>;
};

function titleFromPrompt(prompt: string): string {
  const t = String(prompt || '').replace(/\s+/g, ' ').trim();
  if (!t) return 'Task';
  return t.length > 56 ? t.slice(0, 53) + '…' : t;
}

/** Hi / hello / thanks — not a coding assignment (includes common typos like hellow). */
export function isSimpleChatPrompt(prompt: string): boolean {
  const raw = String(prompt || '').trim();
  if (!raw || raw.length > 120) return false;
  // Ignore appended editor context if present
  const first = raw.split(/\n+/)[0].trim().toLowerCase().replace(/[!?.,…]+$/g, '').trim();
  if (!first || first.length > 60) return false;
  if (/\b(fix|build|add|create|implement|refactor|bug|test|edit|file|code|css|html|js|ts|api|login|button|page)\b/i.test(first)) {
    return false;
  }
  return /^(hi|hii|hiii|hello|hellow|helo|hey|heyy|yo|sup|hola|namaste|thanks|thank you|thx|ty|ok|okay|bye|goodbye|good morning|good evening|good night|gm|gn|how are you|how r you|whats up|what's up|wassup)(\s+\w+){0,6}$/i.test(
    first,
  );
}

function buildWorkerPrompt(workerName: string, role: string, taskPrompt: string): string {
  const text = taskPrompt.trim();
  if (isSimpleChatPrompt(text)) {
    return [
      `You are ${workerName}, ${role} on the OLKIL Virtual Office team.`,
      'The user sent a greeting or short small-talk — NOT a coding task.',
      `Reply in 1–2 friendly sentences as ${workerName}.`,
      'CRITICAL: Do NOT use any tools. Do NOT read, list, search, glob, grep, or edit files. Do NOT explore the codebase.',
      '',
      'USER MESSAGE:',
      text.split(/\n+/)[0].trim(),
    ].join('\n');
  }

  const specialty =
    role === 'QA'
      ? 'Focus on testing, edge cases, regressions, and clear bug reports.'
      : 'You are a full-stack capable developer. Ship clean, minimal, high-quality code.';
  return [
    `You are ${workerName}, ${role} on the OLKIL Virtual Office team.`,
    specialty,
    'Work only inside the open workspace. Prefer minimal, high-quality changes.',
    'Only read files that are clearly needed for THIS task. Do not explore the whole repo for greetings or vague chat.',
    'Finish with a short summary of what you changed.',
    '',
    'ASSIGNED TASK:',
    text,
  ].join('\n');
}

/**
 * Virtual Office — cartoon floor + parallel agents on the shared OlkilEngine.
 */
export class VirtualOfficePanel {
  active = false;
  assigneeId: VoAssigneeId = 'manager';
  inspectedWorkerId: string | null = null;

  private panel: vscode.WebviewPanel | undefined;
  private frameReady = false;
  private pending: Array<Record<string, unknown>> = [];
  private runs = new Map<string, VoRun>();
  /** Sessions the user Stopped — drop late SSE / tool events. */
  private abortedSessions = new Set<string>();
  private onState?: () => void;
  private onWorkerClick?: (workerId: string) => void;
  private onTaskError?: (workerId: string, message: string) => void;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getSession: () => OlkilSession | null,
    private readonly getModelId: () => string,
    /** Shared sidebar engine — same opencode serve as normal chat (avoids stuck second process). */
    private readonly getEngine: () => OlkilEngine,
    private readonly ensureEngine: () => Promise<void>,
  ) {}

  onDidChange(fn: () => void) {
    this.onState = fn;
  }

  onCabinClick(fn: (workerId: string) => void) {
    this.onWorkerClick = fn;
  }

  onError(fn: (workerId: string, message: string) => void) {
    this.onTaskError = fn;
  }

  private fire() {
    this.onState?.();
  }

  getRun(workerId: string) {
    return this.runs.get(workerId);
  }

  getInspectedRun() {
    return this.inspectedWorkerId ? this.runs.get(this.inspectedWorkerId) : undefined;
  }

  listRuns() {
    return [...this.runs.values()];
  }

  runningCount() {
    return [...this.runs.values()].filter((r) => r.status === 'running').length;
  }

  isOpen() {
    return Boolean(this.panel);
  }

  async toggle() {
    if (this.panel) {
      this.disposePanel();
      return;
    }
    await this.open();
  }

  async open() {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'olkil.virtualOffice',
      'Vertual Office',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
      },
    );
    this.panel = panel;
    this.active = true;
    this.frameReady = false;
    this.pending = [];
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, 'media', 'vo-tab-icon.png'),
      dark: vscode.Uri.joinPath(this.extensionUri, 'media', 'vo-tab-icon.png'),
    };
    panel.webview.html = this.hostHtml(panel.webview);
    panel.webview.onDidReceiveMessage((msg) => this.onFrameMessage(msg));
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.active = false;
      this.frameReady = false;
      this.fire();
    });
    this.fire();
  }

  setAssignee(id: VoAssigneeId) {
    this.assigneeId = id;
    this.fire();
  }

  inspectWorker(workerId: string) {
    if (!VO_WORKERS.some((w) => w.id === workerId) && !this.runs.has(workerId)) return;
    const switched = this.inspectedWorkerId !== workerId;
    this.inspectedWorkerId = workerId;
    // Silent select in the office — never echo worker-click (that caused Assigned blink loop)
    this.postToOffice({ type: 'select', workerId });
    if (switched) this.fire();
    this.onWorkerClick?.(workerId);
  }

  /**
   * Start a VO task in the background (does not await agent finish).
   * Returns immediately so chat can show live engine events.
   */
  async startTask(prompt: string): Promise<VoRun> {
    const text = prompt.trim();
    if (!text) throw new Error('Empty task');
    if (!this.active || !this.panel) await this.open();

    if (this.runningCount() >= MAX_VO_PARALLEL) {
      throw new Error(`Virtual Office is at capacity (${MAX_VO_PARALLEL} parallel agents).`);
    }

    const worker = this.pickWorker(text);
    if (!worker) {
      throw new Error(
        this.assigneeId !== 'manager'
          ? `${this.assigneeId} is already working — pick someone else or Manager.`
          : 'All teammates are busy — wait for someone to finish.',
      );
    }

    const session = this.getSession();
    if (!session) throw new Error('Sign in first.');

    await this.ensureEngine();
    const engine = this.getEngine();

    const title = titleFromPrompt(text);
    const sessionId = await engine.createSession(`VO ${worker.name}`);
    const run: VoRun = {
      workerId: worker.id,
      workerName: worker.name,
      workerRole: worker.role,
      title,
      prompt: text,
      sessionId,
      status: 'running',
      startedAt: Date.now(),
      log: [],
    };
    this.runs.set(worker.id, run);
    this.inspectedWorkerId = worker.id;
    this.postToOffice({ type: 'assign', workerId: worker.id, task: title });
    this.postToOffice({ type: 'select', workerId: worker.id });
    this.fire();

    void engine
      .sendPromptTo(sessionId, buildWorkerPrompt(worker.name, worker.role, text), this.getModelId(), 1)
      .catch((err) => {
        run.status = 'failed';
        this.postToOffice({ type: 'complete', workerId: worker.id });
        this.fire();
        this.onTaskError?.(worker.id, err instanceof Error ? err.message : String(err));
      });

    return run;
  }

  /** Mark a worker done when session.idle arrives for their session. */
  completeIfSession(sessionId: string) {
    for (const run of this.runs.values()) {
      if (run.sessionId === sessionId && run.status === 'running') {
        run.status = 'done';
        this.postToOffice({ type: 'complete', workerId: run.workerId });
        this.fire();
        return run;
      }
    }
    return null;
  }

  failIfSession(sessionId: string) {
    for (const run of this.runs.values()) {
      if (run.sessionId === sessionId && run.status === 'running') {
        run.status = 'failed';
        this.postToOffice({ type: 'complete', workerId: run.workerId });
        this.fire();
        return run;
      }
    }
    return null;
  }

  sessionToWorker(sessionId: string): VoRun | undefined {
    for (const run of this.runs.values()) {
      if (run.sessionId === sessionId) return run;
    }
    return undefined;
  }

  /** True after user Stop (or failed) — host should ignore further work events. */
  isSessionStopped(sessionId: string): boolean {
    if (!sessionId) return false;
    if (this.abortedSessions.has(sessionId)) return true;
    const run = this.sessionToWorker(sessionId);
    return Boolean(run && run.status !== 'running');
  }

  appendLog(workerId: string, msg: Record<string, unknown>) {
    const run = this.runs.get(workerId);
    if (!run) return;
    // Don't record chatter after Stop
    if (run.status !== 'running') return;
    run.log.push(msg);
    if (run.log.length > 400) run.log.splice(0, run.log.length - 400);
  }

  async continueRun(workerId: string, prompt: string) {
    const run = this.runs.get(workerId);
    if (!run || run.status !== 'running') return;
    if (this.abortedSessions.has(run.sessionId)) return;
    await this.getEngine().sendPromptTo(run.sessionId, prompt, this.getModelId(), 2);
  }

  /**
   * Abort one teammate. Marks stopped immediately so late engine events are ignored,
   * then double-fires session abort (engine cancel can be flaky mid-tool).
   */
  async stopWorker(workerId: string): Promise<VoRun | null> {
    const run = this.runs.get(workerId);
    if (!run || run.status !== 'running') return null;
    const sid = run.sessionId;
    run.status = 'failed';
    this.abortedSessions.add(sid);
    this.postToOffice({ type: 'complete', workerId: run.workerId });
    this.fire();

    const engine = this.getEngine();
    try {
      await engine.abortSession(sid);
    } catch {
      /* ignore */
    }
    // Second abort after a beat — kills straggling tool turns
    setTimeout(() => {
      void engine.abortSession(sid);
    }, 150);

    return run;
  }

  private pickWorker(taskLabel: string) {
    const busy = new Set(
      [...this.runs.values()].filter((r) => r.status === 'running').map((r) => r.workerId),
    );
    if (this.assigneeId !== 'manager') {
      if (busy.has(this.assigneeId)) return null;
      return VO_WORKERS.find((w) => w.id === this.assigneeId) || null;
    }
    const idle = VO_WORKERS.filter((w) => !busy.has(w.id));
    if (!idle.length) return null;
    const lower = taskLabel.toLowerCase();
    const keywords: Record<string, string[]> = {
      alex: ['ui', 'frontend', 'react', 'css', 'page', 'component', 'html'],
      elon: ['api', 'backend', 'server', 'auth', 'database'],
      sophia: ['design', 'layout', 'style', 'animation'],
      robert: ['refactor', 'bug', 'fix', 'logic', 'typescript'],
      jasmine: ['test', 'qa', 'bug', 'edge'],
    };
    for (const w of idle) {
      const keys = keywords[w.id] || [];
      if (keys.some((k) => lower.includes(k))) return w;
    }
    return idle[Math.floor(Math.random() * idle.length)];
  }

  private onFrameMessage(msg: any) {
    if (!msg || msg.source !== 'officeai') return;
    if (msg.type === 'ready') {
      this.frameReady = true;
      this.flushPending();
      return;
    }
    if (msg.type === 'worker-click') {
      const workerId = String(msg.detail?.workerId || msg.workerId || '');
      if (workerId) this.inspectWorker(workerId);
    }
  }

  private postToOffice(payload: Record<string, unknown>) {
    const msg = { source: 'olkil-virtual-office', ...payload };
    if (!this.frameReady || !this.panel) {
      this.pending.push(msg);
      return;
    }
    void this.panel.webview.postMessage(msg);
  }

  private flushPending() {
    if (!this.panel) return;
    for (const msg of this.pending) void this.panel.webview.postMessage(msg);
    this.pending = [];
  }

  private hostHtml(webview: vscode.Webview): string {
    const abs = path.join(this.extensionUri.fsPath, 'media', 'vertualoffice.html');
    let html = fs.readFileSync(abs, 'utf8');
    const nonce = String(Date.now()) + Math.random().toString(36).slice(2);

    html = html.replace(/<html([^>]*)>/i, '<html$1 class="oa-vscode">');
    html = html.replace(/<body([^>]*)>/i, '<body$1 class="oa-vscode">');
    html = html.replace(/<script(\s[^>]*)?>/gi, (_m, attrs) => {
      const a = String(attrs || '');
      if (/\bnonce\s*=/.test(a)) return `<script${a}>`;
      return `<script nonce="${nonce}"${a}>`;
    });

    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: https:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource} data:;" />`;
    if (/<meta[^>]+charset/i.test(html)) {
      html = html.replace(/(<meta[^>]+charset[^>]*>)/i, `$1\n    ${csp}`);
    } else {
      html = html.replace(/<head([^>]*)>/i, `<head$1>\n    ${csp}`);
    }

    const fitCss = `
<style>
  html.oa-vscode, body.oa-vscode {
    margin: 0 !important; height: 100% !important; width: 100% !important;
    overflow: hidden !important; padding: 0 !important; display: block !important;
    background: #0f1218 !important;
  }
  body.oa-vscode #oa-vscode-host {
    position: absolute; inset: 0; overflow: hidden; background: #0f1218;
    padding: 10px 8px 8px 12px;
  }
  body.oa-vscode #oa-vscode-stage {
    width: 900px; height: 540px; transform-origin: top left; will-change: transform;
  }
  body.oa-vscode .officeai {
    max-width: none !important; width: 900px !important; margin: 0 !important;
    overflow: visible !important; background: transparent !important;
  }
  body.oa-vscode .oa-cabins { display: flex !important; flex-wrap: nowrap !important; gap: 8px !important; }
  body.oa-vscode .oa-cabin { flex: 1 1 0 !important; min-width: 0 !important; display: block !important; }
  #oa-demo { display: none !important; }
</style>`;
    html = html.replace(/<\/head>/i, fitCss + '\n</head>');

    const bridge = `
<script nonce="${nonce}">
(function () {
  var vscodeApi = acquireVsCodeApi();
  var demo = document.getElementById('oa-demo');
  if (demo) demo.style.display = 'none';

  var root = document.getElementById('officeai-root');
  if (root && !document.getElementById('oa-vscode-stage')) {
    var host = document.createElement('div');
    host.id = 'oa-vscode-host';
    var stage = document.createElement('div');
    stage.id = 'oa-vscode-stage';
    root.parentNode.insertBefore(host, root);
    host.appendChild(stage);
    stage.appendChild(root);
  }

  var DESIGN_W = 900, DESIGN_H = 540, PAD = 16, MAX = 0.92;
  function fit() {
    var h = document.getElementById('oa-vscode-host');
    var s = document.getElementById('oa-vscode-stage');
    if (!h || !s) return;
    var scale = Math.min((h.clientWidth - PAD) / DESIGN_W, (h.clientHeight - PAD) / DESIGN_H, MAX);
    s.style.transform = 'scale(' + Math.max(scale, 0.35) + ')';
  }
  fit();
  window.addEventListener('resize', fit);
  if (typeof ResizeObserver !== 'undefined') {
    var h2 = document.getElementById('oa-vscode-host');
    if (h2) new ResizeObserver(fit).observe(h2);
  }

  function forward(type, detail) {
    try { vscodeApi.postMessage({ source: 'officeai', type: type, detail: detail || {} }); } catch (e) {}
  }
  document.addEventListener('officeai:assigned', function (e) { forward('assigned', e.detail); });
  document.addEventListener('officeai:completed', function (e) { forward('completed', e.detail); });
  document.addEventListener('officeai:allidle', function (e) { forward('allidle', e.detail); });
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (d && d.source === 'officeai') forward(d.type, d.detail);
  });

  // Re-place travelers after scale settles (correct cabin seats)
  function rehome() {
    try {
      if (window.OfficeAI && typeof window.OfficeAI.reset !== 'function') return;
      var scene = document.getElementById('oa-scene');
      if (!scene) return;
      // nudge layout then ask OfficeAI to re-measure via ping+assign noop — use place via reset of idle only
      fit();
    } catch (e) {}
  }

  function signalReady() {
    var workers = (window.OfficeAI && window.OfficeAI.workers) || [];
    forward('ready', { workers: workers });
    fit();
    rehome();
  }
  if (window.OfficeAI) signalReady();
  else setTimeout(signalReady, 80);
  setTimeout(signalReady, 400);
  setTimeout(fit, 50);
  setTimeout(fit, 300);
})();
</script>`;

    if (/<\/body>/i.test(html)) {
      html = html.replace(/<\/body>/i, bridge + '\n</body>');
    } else {
      html += bridge;
    }
    return html;
  }

  private disposePanel() {
    this.panel?.dispose();
    this.panel = undefined;
    this.active = false;
    this.frameReady = false;
    this.fire();
  }

  dispose() {
    this.disposePanel();
    this.runs.clear();
    this.abortedSessions.clear();
  }
}
