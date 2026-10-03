/**
 * Phone Remote Access for the IDE.
 * Same Firestore link the VS Code extension uses: olkil.com/pocket/#k=<secret>
 * plus a Windows keep-awake request so the screen stays on.
 */

import { IdeScreenShare } from './screen-share';

const PROJECT = 'olkil-2c8ac';
const API = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents';

type Step = { id: string; label: string; done: boolean };
type FileStat = { path: string; additions: number; deletions: number; preview: Array<{ type: string; text: string }> };

export interface IdeRemoteHost {
  getToken(): Promise<string | null>;
  getUid(): string;
  agentBusy(): boolean;
  ask(text: string, mode: 'agent' | 'ask'): Promise<void>;
  abort(): void;
  acceptAll(): Promise<void>;
  revertAll(): Promise<void>;
  setModel(modelId: string): void;
  getModel(): string;
  listModels(): Array<{ id: string; label: string }>;
  workspaceName(): string;
  setAwake(on: boolean): Promise<boolean>;
  saveCustom(model: string, baseUrl: string, apiKey: string): Promise<void>;
  watchChat(sink: (msg: Record<string, unknown>) => void): { dispose: () => void };
  onChange(): void;
}

export class IdeRemote {
  lastError = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private secret = '';
  private deviceId = '';
  private awake = false;
  private activeTaskId = '';
  private savedModel = '';
  private steps: Step[] = [];
  private files: FileStat[] = [];
  private phase = '';
  private reply = '';
  private imagePaths: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private warned = false;
  private chatWatch: { dispose: () => void } | null = null;
  private screen: IdeScreenShare | null = null;

  constructor(private host: IdeRemoteHost) {
    this.deviceId = loadDeviceId();
  }

  rebind(host: IdeRemoteHost) {
    this.host = host;
  }

  isOn() {
    return this.awake && !!this.timer;
  }

  async toggle(): Promise<boolean> {
    if (this.isOn()) {
      await this.stop();
      return false;
    }
    return this.start();
  }

  async start(): Promise<boolean> {
    const uid = this.host.getUid();
    if (!uid) {
      this.lastError = 'Sign in to OLKIL to connect your phone.';
      this.host.onChange();
      return false;
    }
    this.secret = loadSecret(uid);
    this.awake = await this.host.setAwake(true);
    if (!this.awake) {
      this.lastError = 'Remote Access could not keep this screen on.';
      this.host.onChange();
      return false;
    }
    if (this.timer) return true;
    this.lastError = '';
    this.chatWatch = this.host.watchChat((msg) => this.onChatEvent(msg));
    this.timer = setInterval(() => void this.tick(), 1200);
    void this.tick();
    this.screen = new IdeScreenShare(
      () => this.secret,
      () => this.token(),
    );
    void this.screen.start();
    this.host.onChange();
    return true;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.chatWatch) {
      this.chatWatch.dispose();
      this.chatWatch = null;
    }
    if (this.flushTimer) clearTimeout(this.flushTimer);
    const screen = this.screen;
    this.screen = null;
    void screen?.stop();
    this.awake = false;
    await this.host.setAwake(false);
    if (this.secret) void this.writeDevice(false);
    this.activeTaskId = '';
    this.host.onChange();
  }

  qrUrl() {
    return this.secret ? 'https://olkil.com/pocket/#k=' + this.secret : '';
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
      const prev = this.steps.find((step) => step.id === id);
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
      this.files = (msg.files as Array<Record<string, unknown>>).slice(0, 6).map((file) => ({
        path: String(file.name || file.path || '').split(/[/\\]/).pop() || 'file',
        additions: Number(file.additions) || 0,
        deletions: Number(file.deletions) || 0,
        preview: [],
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
      void this.finish('error', String(msg.text || 'Task failed'));
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

  private async token() {
    return this.host.getToken();
  }

  private async tick() {
    const uid = this.host.getUid();
    const idToken = await this.token();
    if (!uid || !idToken || !this.secret) return;
    await this.writeDevice(true);
    await this.consumeCommand(idToken);
    if (this.activeTaskId) {
      const cur = await this.readDoc('tasks/' + this.activeTaskId, idToken);
      if (cur && (cur.cancelRequested === true || String(cur.status || '') === 'cancelled')) {
        await this.haltActive(idToken);
      }
      return;
    }
    if (this.host.agentBusy()) return;
    const queued = await this.findQueued(idToken);
    if (!queued) return;
    await this.claim(queued.id, queued.data, idToken);
  }

  private async haltActive(idToken: string) {
    const id = this.activeTaskId;
    const paths = this.imagePaths.slice();
    this.activeTaskId = '';
    this.imagePaths = [];
    if (this.savedModel) this.host.setModel(this.savedModel);
    this.savedModel = '';
    try {
      this.host.abort();
    } catch {
      /* engine already idle */
    }
    if (id) await this.eraseTask(id, paths, idToken);
  }

  private async consumeCommand(idToken: string) {
    const data = await this.readDoc('box/command', idToken);
    if (!data) return;
    const kind = String(data.kind || '');
    try {
      if (kind === 'revert') await this.host.revertAll();
      else if (kind === 'accept') await this.host.acceptAll();
      else if (kind === 'custom') {
        await this.host.saveCustom(String(data.model || ''), String(data.baseUrl || ''), String(data.apiKey || ''));
      }
    } catch {
      /* the phone command uses the same buttons as the chat */
    }
    await this.deleteDoc('box/command', idToken);
  }

  private async claim(taskId: string, data: Record<string, unknown>, idToken: string) {
    if (data.cancelRequested === true || String(data.status || '') === 'cancelled') {
      const paths = Array.isArray(data.imagePaths) ? data.imagePaths.map((p) => String(p || '')).filter(Boolean) : [];
      await this.eraseTask(taskId, paths, idToken);
      return;
    }
    this.activeTaskId = taskId;
    this.steps = [];
    this.files = [];
    this.reply = '';
    this.imagePaths = Array.isArray(data.imagePaths) ? data.imagePaths.map((p) => String(p || '')).filter(Boolean) : [];
    this.phase = 'Planning next moves';
    this.savedModel = this.host.getModel();
    const modelId = String(data.modelId || '');
    if (modelId && modelId !== 'auto') this.host.setModel(modelId);
    await this.patch('tasks/' + taskId, idToken, {
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
      await this.host.ask(text || 'Please look at the attached image(s).', mode);
    } catch (err) {
      await this.finish('error', err instanceof Error ? err.message : String(err));
    }
  }

  private async finish(status: 'done' | 'error', error: string) {
    const id = this.activeTaskId;
    this.activeTaskId = '';
    if (this.savedModel) this.host.setModel(this.savedModel);
    this.savedModel = '';
    if (!id) return;
    const idToken = await this.token();
    if (!idToken) return;
    const paths = this.imagePaths.slice();
    this.imagePaths = [];
    await this.patch('tasks/' + id, idToken, {
      status,
      phase: '',
      reply: this.reply,
      error: error || '',
      files: this.files,
      updatedAt: new Date().toISOString(),
    });
    setTimeout(() => void this.eraseTask(id, paths, idToken), 15000);
  }

  private async eraseTask(id: string, paths: string[], idToken: string) {
    for (const storagePath of paths) {
      const url =
        'https://firebasestorage.googleapis.com/v0/b/olkil-2c8ac.firebasestorage.app/o/' +
        encodeURIComponent(storagePath);
      await fetch(url, { method: 'DELETE', headers: { Authorization: 'Bearer ' + idToken } });
    }
    await fetch(this.docUrl('tasks/' + encodeURIComponent(id)), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + idToken },
    });
  }

  private async flushProgress() {
    if (!this.activeTaskId) return;
    const idToken = await this.token();
    if (!idToken) return;
    await this.patch('tasks/' + this.activeTaskId, idToken, {
      phase: this.phase || 'Planning next moves',
      steps: this.steps.slice(-8),
      files: this.files,
      reply: this.reply,
      updatedAt: new Date().toISOString(),
    });
  }

  private async writeDevice(online: boolean): Promise<boolean> {
    const idToken = await this.token();
    if (!idToken || !this.secret) return false;
    return this.patch('', idToken, {
      deviceId: this.deviceId,
      name: 'OLKIL PC',
      workspace: this.host.workspaceName(),
      online,
      lastSeen: new Date().toISOString(),
      models: this.host.listModels().slice(0, 40),
      pairCode: '',
      pairExpiresAt: '',
      appVersion: '1.3.28',
    });
  }

  private docUrl(rel = ''): string {
    const root = API + '/links/' + this.secret;
    return rel ? root + '/' + rel : root;
  }

  private async deleteDoc(rel: string, idToken: string) {
    await fetch(this.docUrl(rel), { method: 'DELETE', headers: { Authorization: 'Bearer ' + idToken } });
  }

  private async findQueued(idToken: string): Promise<{ id: string; data: Record<string, unknown> } | null> {
    const url = API + '/links/' + this.secret + ':runQuery';
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + idToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'tasks' }],
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
      const target = String(data.deviceId || '');
      if (target && target !== this.deviceId) continue;
      const id = doc.name.split('/').pop() || '';
      if (id) return { id, data };
    }
    return null;
  }

  private async readDoc(rel: string, idToken: string): Promise<Record<string, unknown> | null> {
    const res = await fetch(this.docUrl(rel), { headers: { Authorization: 'Bearer ' + idToken } });
    if (!res.ok) return null;
    const json = (await res.json()) as { fields?: Record<string, unknown> };
    return decodeFields(json.fields || {});
  }

  private async patch(rel: string, idToken: string, data: Record<string, unknown>): Promise<boolean> {
    const mask = Object.keys(data)
      .map((field) => 'updateMask.fieldPaths=' + encodeURIComponent(field))
      .join('&');
    const res = await fetch(this.docUrl(rel) + '?' + mask, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + idToken, 'Content-Type': 'application/json' },
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
    this.lastError = /PERMISSION_DENIED|permission/i.test(detail)
      ? 'Remote cannot reach Firebase yet.'
      : 'Remote sync failed. Check that you are signed in to OLKIL.';
    this.host.onChange();
  }
}

let sharedRemote: IdeRemote | null = null;

/** One phone link for the whole IDE session, including while the chat panel is closed. */
export function sharedIdeRemote(host: IdeRemoteHost): IdeRemote {
  if (!sharedRemote) {
    sharedRemote = new IdeRemote(host);
  } else {
    sharedRemote.rebind(host);
  }
  return sharedRemote;
}

function loadDeviceId(): string {
  try {
    const existing = localStorage.getItem('olkil.deviceId') || '';
    if (existing) return existing;
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('olkil.deviceId', id);
    return id;
  } catch {
    return 'olkil-pc';
  }
}

function loadSecret(uid: string): string {
  try {
    const raw = localStorage.getItem('olkil.remoteSecrets') || '{}';
    const map = JSON.parse(raw) as Record<string, string>;
    const existing = String(map[uid] || '');
    if (/^[a-f0-9]{64}$/.test(existing)) return existing;
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const secret = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    map[uid] = secret;
    localStorage.setItem('olkil.remoteSecrets', JSON.stringify(map));
    return secret;
  } catch {
    return '';
  }
}

function encodeFields(data: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) fields[key] = encodeValue(value);
  return fields;
}

function encodeValue(value: unknown): unknown {
  if (value == null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map((item) => encodeValue(item)) } };
  if (typeof value === 'object') {
    const fields: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) fields[key] = encodeValue(nested);
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

function decodeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) out[key] = decodeValue(value);
  return out;
}

function decodeValue(value: unknown): unknown {
  const row = value as Record<string, unknown>;
  if (!row || typeof row !== 'object') return null;
  if ('stringValue' in row) return row.stringValue;
  if ('booleanValue' in row) return row.booleanValue;
  if ('integerValue' in row) return Number(row.integerValue);
  if ('doubleValue' in row) return Number(row.doubleValue);
  if ('nullValue' in row) return null;
  if ('arrayValue' in row) {
    const values = ((row.arrayValue as { values?: unknown[] })?.values || []) as unknown[];
    return values.map((item) => decodeValue(item));
  }
  if ('mapValue' in row) {
    return decodeFields(((row.mapValue as { fields?: Record<string, unknown> })?.fields || {}) as Record<string, unknown>);
  }
  return null;
}
