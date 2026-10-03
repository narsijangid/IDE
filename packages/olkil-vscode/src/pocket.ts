import * as os from 'os';
import * as vscode from 'vscode';
import { ensureSession, type OlkilSession } from './auth';

const PROJECT = 'olkil-2c8ac';
const API = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents';

type Step = { id: string; label: string; done: boolean };
type DiffLine = { type: string; text: string };
type FileStat = { path: string; additions: number; deletions: number; preview: DiffLine[] };

type PocketHost = {
  session: OlkilSession | null;
  agentBusy: () => boolean;
  ask(text: string, opts?: { mode?: string; pocket?: boolean; skipUserEcho?: boolean; hasImages?: boolean }): Promise<void>;
  abort(): Promise<void>;
  acceptAll(): Promise<void>;
  revertAll(): Promise<void>;
  saveCustom(model: string, baseUrl: string, apiKey: string): Promise<boolean>;
  setModel(modelId: string): void;
  getModel(): string;
  listModels(): Array<{ id: string; label: string }>;
};

export class PocketBridge {
  activeTaskId = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private deviceId = '';
  private savedModel = '';
  private steps: Step[] = [];
  private files: FileStat[] = [];
  private phase = '';
  private reply = '';
  private imagePaths: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private status: vscode.StatusBarItem;
  private warned = false;
  lastError = '';
  private linkSecret = '';

  setSecret(secret: string) {
    this.linkSecret = String(secret || '');
  }

  link(): string {
    return this.linkSecret;
  }

  code() {
    return '';
  }

  constructor(
    private host: PocketHost,
    private onChange?: () => void,
  ) {
    this.deviceId = String(vscode.env.machineId || 'olkil-pc').replace(/[^\w-]/g, '').slice(0, 80) || 'olkil-pc';
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    this.status.command = 'olkil.pocket.toggle';
  }

  dispose() {
    this.stop();
    this.status.dispose();
  }

  isOn() {
    return !!this.timer;
  }

  async start() {
    if (this.timer) return;
    const session = await ensureSession();
    if (!session?.user?.uid) {
      void vscode.window.showWarningMessage('Sign in to OLKIL before turning Remote on.');
      return;
    }
    if (!this.linkSecret) return;
    this.host.session = session;
    const ok = await this.writeDevice(true);
    if (!ok) {
      this.lastError = 'Pocket could not reach Firebase. Deploy the Pocket rules, then try again.';
      this.onChange?.();
      return;
    }
    this.lastError = '';
    this.status.text = '$(radio-tower) Remote';
    this.status.tooltip = 'OLKIL Remote is listening for this account.';
    this.status.show();
    this.timer = setInterval(() => void this.tick(), 1200);
    void this.tick();
    this.onChange?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.status.hide();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    void this.writeDevice(false);
    this.activeTaskId = '';
    this.lastError = '';
    this.onChange?.();
  }

  onChatEvent(msg: Record<string, unknown>) {
    if (!this.activeTaskId) return;
    const type = String(msg.type || '');
    if (type === 'phase') {
      const label = String(msg.label || '').trim();
      if (label) this.phase = label;
      this.scheduleFlush();
      return;
    }
    if (type === 'activity') {
      const label = String(msg.label || msg.text || '').trim();
      if (!label) return;
      const id = String(msg.id || label);
      const done = !!msg.done;
      const prev = this.steps.find((s) => s.id === id);
      if (prev) {
        prev.label = label;
        prev.done = done;
      } else {
        this.steps.push({ id, label, done });
      }
      if (this.steps.length > 40) this.steps = this.steps.slice(-40);
      this.scheduleFlush();
      return;
    }
    if (type === 'files' && Array.isArray(msg.files)) {
      this.files = (msg.files as Array<Record<string, unknown>>).slice(0, 6).map((f) => ({
        path: String(f.name || f.path || '').split(/[/\\]/).pop() || 'file',
        additions: Number(f.additions) || 0,
        deletions: Number(f.deletions) || 0,
        preview: (Array.isArray(f.preview) ? f.preview : []).slice(0, 10).map((line) => {
          const row = line as Record<string, unknown>;
          return { type: String(row.type || 'same'), text: String(row.text || '').slice(0, 160) };
        }),
      }));
      this.scheduleFlush();
      return;
    }
    if (type === 'assistant') {
      const text = String(msg.text || '').trim();
      if (text) this.reply = text.slice(0, 6000);
      this.scheduleFlush();
      return;
    }
    if (type === 'error') {
      const text = String(msg.text || 'Task failed');
      void this.finish('error', text);
      return;
    }
    if (type === 'upgrade') {
      void this.finish('upgrade', '');
      return;
    }
    if (type === 'idle') {
      void this.finish('done', '');
    }
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushProgress();
    }, 1200);
  }

  private async tick() {
    const session = await ensureSession();
    if (!session?.user?.uid || !this.linkSecret) return;
    this.host.session = session;
    await this.writeDevice(true);
    await this.consumeCommand(session);
    if (this.activeTaskId) {
      const cur = await this.readDoc('tasks/' + this.activeTaskId, session);
      if (cur && (cur.cancelRequested === true || String(cur.status || '') === 'cancelled')) {
        await this.haltActive(session);
      }
      return;
    }
    if (this.host.agentBusy()) return;
    const queued = await this.findQueued(session);
    if (!queued) return;
    await this.claim(queued.id, queued.data, session);
  }

  private async haltActive(session: OlkilSession) {
    const id = this.activeTaskId;
    const paths = this.imagePaths.slice();
    this.activeTaskId = '';
    this.imagePaths = [];
    if (this.savedModel) this.host.setModel(this.savedModel);
    this.savedModel = '';
    try {
      await this.host.abort();
    } catch {
      /* engine already idle */
    }
    if (id) await this.eraseTask(id, paths);
    void session;
  }

  private async consumeCommand(session: OlkilSession) {
    const data = await this.readDoc('box/command', session);
    if (!data) return;
    const kind = String(data.kind || '');
    try {
      if (kind === 'revert') await this.host.revertAll();
      else if (kind === 'accept') await this.host.acceptAll();
      else if (kind === 'custom') {
        await this.host.saveCustom(String(data.model || ''), String(data.baseUrl || ''), String(data.apiKey || ''));
      }
    } catch {
      /* same buttons the sidebar uses — a failed revert stays pending */
    }
    await this.deleteDoc('box/command', session);
  }

  private async claim(taskId: string, data: Record<string, unknown>, session: OlkilSession) {
    if (data.cancelRequested === true || String(data.status || '') === 'cancelled') {
      const paths = Array.isArray(data.imagePaths) ? data.imagePaths.map((p) => String(p || '')).filter(Boolean) : [];
      await this.eraseTask(taskId, paths);
      return;
    }
    this.activeTaskId = taskId;
    this.steps = [];
    this.files = [];
    this.reply = '';
    this.imagePaths = Array.isArray(data.imagePaths) ? data.imagePaths.map((p) => String(p || '')).filter(Boolean) : [];
    this.phase = 'Planning next moves';
    this.savedModel = this.host.getModel();
    const modelId = String(data.modelId || 'auto');
    if (modelId) this.host.setModel(modelId);
    await this.patch('tasks/' + taskId, session, {
      status: 'running',
      phase: 'Planning next moves',
      updatedAt: new Date().toISOString(),
    });
    let text = String(data.text || '').trim();
    const images = Array.isArray(data.imageUrls) ? data.imageUrls.map((u) => String(u)).filter(Boolean) : [];
    if (images.length) {
      text = (text ? text + '\n\n' : '') + 'Attached images:\n' + images.join('\n');
    }
    const mode = String(data.mode || 'agent') === 'ask' ? 'ask' : 'agent';
    try {
      await this.host.ask(text || 'Please look at the attached image(s).', {
        mode,
        pocket: true,
        skipUserEcho: false,
        hasImages: images.length > 0,
      });
    } catch (err) {
      await this.finish('error', err instanceof Error ? err.message : String(err));
    }
  }

  private async finish(status: 'done' | 'error' | 'upgrade', error: string) {
    const id = this.activeTaskId;
    this.activeTaskId = '';
    if (this.savedModel) this.host.setModel(this.savedModel);
    this.savedModel = '';
    if (!id) return;
    const session = await ensureSession();
    if (!session) return;
    const paths = this.imagePaths.slice();
    this.imagePaths = [];
    await this.patch('tasks/' + id, session, {
      status,
      phase: '',
      reply: this.reply,
      error: error || '',
      files: this.files,
      updatedAt: new Date().toISOString(),
    });
    setTimeout(() => void this.eraseTask(id, paths), 15000);
  }

  private async eraseTask(id: string, paths: string[]) {
    const session = await ensureSession();
    if (!session?.user?.uid) return;
    for (const path of paths) await this.deleteStorage(path, session);
    const url = this.docUrl('tasks/' + encodeURIComponent(id));
    await fetch(url, { method: 'DELETE', headers: { Authorization: 'Bearer ' + session.idToken } });
  }

  private async deleteStorage(path: string, session: OlkilSession) {
    const url =
      'https://firebasestorage.googleapis.com/v0/b/olkil-2c8ac.firebasestorage.app/o/' + encodeURIComponent(path);
    await fetch(url, { method: 'DELETE', headers: { Authorization: 'Bearer ' + session.idToken } });
  }

  private async flushProgress() {
    if (!this.activeTaskId) return;
    const session = await ensureSession();
    if (!session) return;
    await this.patch('tasks/' + this.activeTaskId, session, {
      phase: this.phase || 'Planning next moves',
      steps: this.steps.slice(-8),
      files: this.files,
      reply: this.reply,
      updatedAt: new Date().toISOString(),
    });
  }

  private async writeDevice(online: boolean): Promise<boolean> {
    const session = this.host.session || (await ensureSession());
    if (!session?.user?.uid || !this.linkSecret) return false;
    const folder = vscode.workspace.workspaceFolders?.[0];
    let models: Array<{ id: string; label: string }> = [];
    try {
      models = this.host.listModels();
    } catch {
      models = [];
    }
    const ok = await this.patch('', session, {
      deviceId: this.deviceId,
      name: os.hostname() || 'OLKIL PC',
      workspace: folder?.name || '',
      online,
      lastSeen: new Date().toISOString(),
      models,
      pairCode: '',
      pairExpiresAt: '',
      appVersion: '1.0.81',
    });
    return ok;
  }

  private docUrl(rel = ''): string {
    const root = API + '/links/' + this.linkSecret;
    return rel ? root + '/' + rel : root;
  }

  private async deleteDoc(rel: string, session: OlkilSession) {
    const url = this.docUrl(rel);
    await fetch(url, { method: 'DELETE', headers: { Authorization: 'Bearer ' + session.idToken } });
  }

  private async findQueuedIn(collectionId: string, session: OlkilSession): Promise<{ id: string; data: Record<string, unknown> } | null> {
    const url = API + '/links/' + this.linkSecret + ':runQuery';
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + session.idToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'status' },
              op: 'EQUAL',
              value: { stringValue: 'queued' },
            },
          },
          limit: 5,
        },
      }),
    });
    if (!res.ok) {
      this.warnOnce(await res.text());
      return null;
    }
    const rows = (await res.json()) as Array<{ document?: { name?: string; fields?: Record<string, unknown> } }>;
    for (const row of rows || []) {
      const doc = row.document;
      if (!doc?.name) continue;
      const data = decodeFields(doc.fields || {});
      if (collectionId === 'tasks') {
        const target = String(data.deviceId || '');
        if (target && target !== this.deviceId) continue;
      }
      const id = doc.name.split('/').pop() || '';
      if (id) return { id, data };
    }
    return null;
  }

  private async findQueued(session: OlkilSession): Promise<{ id: string; data: Record<string, unknown> } | null> {
    return this.findQueuedIn('tasks', session);
  }

  private async readDoc(rel: string, session: OlkilSession): Promise<Record<string, unknown> | null> {
    const url = this.docUrl(rel);
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + session.idToken } });
    if (!res.ok) return null;
    const json = (await res.json()) as { fields?: Record<string, unknown> };
    return decodeFields(json.fields || {});
  }

  private async patch(rel: string, session: OlkilSession, data: Record<string, unknown>): Promise<boolean> {
    const paths = Object.keys(data);
    const mask = paths.map((p) => 'updateMask.fieldPaths=' + encodeURIComponent(p)).join('&');
    const url = this.docUrl(rel) + '?' + mask;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + session.idToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: encodeFields(data) }),
    });
    if (!res.ok) {
      this.warnOnce(await res.text());
      return false;
    }
    this.warned = false;
    return true;
  }

  private warnOnce(detail: string) {
    if (this.warned) return;
    this.warned = true;
    const short = /PERMISSION_DENIED|permission/i.test(detail)
      ? 'Remote cannot reach Firebase yet. Deploy the Remote Firestore rules for olkil-2c8ac.'
      : 'Remote sync failed. Check that you are signed in to OLKIL.';
    void vscode.window.showWarningMessage(short);
  }
}

function encodeFields(data: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) fields[k] = encodeValue(v);
  return fields;
}

function encodeValue(v: unknown): unknown {
  if (v == null) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map((item) => encodeValue(item)) } };
  if (typeof v === 'object') {
    const fields: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) fields[k] = encodeValue(val);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function decodeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = decodeValue(v);
  return out;
}

function decodeValue(v: unknown): unknown {
  const o = v as Record<string, unknown>;
  if (!o || typeof o !== 'object') return null;
  if ('stringValue' in o) return o.stringValue;
  if ('booleanValue' in o) return o.booleanValue;
  if ('integerValue' in o) return Number(o.integerValue);
  if ('doubleValue' in o) return Number(o.doubleValue);
  if ('timestampValue' in o) return o.timestampValue;
  if ('nullValue' in o) return null;
  if ('arrayValue' in o) {
    const values = ((o.arrayValue as { values?: unknown[] })?.values || []) as unknown[];
    return values.map((item) => decodeValue(item));
  }
  if ('mapValue' in o) return decodeFields(((o.mapValue as { fields?: Record<string, unknown> })?.fields || {}) as Record<string, unknown>);
  return null;
}
