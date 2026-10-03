import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as readline from 'readline';
import * as path from 'path';
import * as vscode from 'vscode';
import { ensureSession } from './auth';

const API = 'https://firestore.googleapis.com/v1/projects/olkil-2c8ac/databases/(default)/documents';

/**
 * VS Code / Cursor side of Remote screen control.
 * A hidden helper captures the editor window. The sidebar webview sends it
 * to the phone over WebRTC. Clicks and keys come back into that window only.
 */
export class ExtensionScreen {
  private child: ChildProcessWithoutNullStreams | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private on = false;
  private ready = false;
  private session = '';
  private framePending = false;
  private seenAgain = '';
  private hadAnswer = false;

  constructor(
    private extensionPath: string,
    private post: (msg: Record<string, unknown>) => void,
    private secret: () => string,
  ) {}

  async start(): Promise<void> {
    if (this.on) return;
    if (process.platform !== 'win32') return;
    if (!this.secret()) return;
    this.on = true;
    this.session = randomId();
    this.launch();
    this.post({ type: 'screenStart', session: this.session });
    this.timer = setInterval(() => void this.pollViewer(), 500);
    this.frameTimer = setInterval(() => this.requestFrame(), 70);
  }

  stop(): void {
    this.on = false;
    if (this.timer) clearInterval(this.timer);
    if (this.frameTimer) clearInterval(this.frameTimer);
    this.timer = null;
    this.frameTimer = null;
    this.post({ type: 'screenStop' });
    this.killChild();
    const secret = this.secret();
    if (secret) {
      void this.token().then((idToken) => {
        if (!idToken) return;
        void fetch(docUrl(secret, 'box/screenHost'), { method: 'DELETE', headers: auth(idToken) });
        void fetch(docUrl(secret, 'box/screenViewer'), { method: 'DELETE', headers: auth(idToken) });
      });
    }
  }

  onOffer(msg: { session?: string; offer?: string; ice?: string }): void {
    if (!this.on) return;
    const secret = this.secret();
    if (!secret || String(msg.session || '') !== this.session) return;
    void this.token().then((idToken) => {
      if (!idToken) return;
      void patch(secret, 'box/screenHost', idToken, {
        session: this.session,
        offer: String(msg.offer || ''),
        ice: String(msg.ice || ''),
        at: new Date().toISOString(),
      });
    });
  }

  onInput(raw: string): void {
    if (!this.on || !this.child || !this.ready) return;
    let msg: { t?: string; k?: string; x?: number; y?: number; b?: number; key?: string; code?: string; dx?: number; dy?: number; ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t === 'p') {
      const x = clamp(msg.x);
      const y = clamp(msg.y);
      this.child.stdin.write(`MOUSE ${msg.k || 'move'} ${x.toFixed(4)} ${y.toFixed(4)} ${Number(msg.b) || 0}\n`);
      return;
    }
    if (msg.t === 'w') {
      const delta = Math.max(-600, Math.min(600, -Math.round(Number(msg.dy) || 0)));
      this.child.stdin.write(`WHEEL ${clamp(msg.x).toFixed(4)} ${clamp(msg.y).toFixed(4)} ${delta}\n`);
      return;
    }
    if (msg.t === 'key') {
      this.writeKey(msg);
    }
  }

  private launch(): void {
    this.killChild();
    const script = path.join(this.extensionPath, 'media', 'screen-host.ps1');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, processName()],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.child = child;
    this.ready = false;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (line === 'READY') {
        this.ready = true;
        return;
      }
      if (line === 'MISS') {
        this.framePending = false;
        return;
      }
      if (line.startsWith('F ')) {
        this.framePending = false;
        if (this.on) this.post({ type: 'screenFrame', jpeg: line.slice(2) });
      }
    });
    child.on('exit', () => {
      if (this.child === child) {
        this.child = null;
        this.ready = false;
      }
    });
  }

  private requestFrame(): void {
    if (!this.on || !this.ready || !this.child || this.framePending) return;
    this.framePending = true;
    try {
      this.child.stdin.write('FRAME\n');
    } catch {
      this.framePending = false;
    }
  }

  private writeKey(msg: { k?: string; key?: string; code?: string; ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }): void {
    if (!this.child) return;
    const kind = msg.k === 'up' ? 'up' : 'down';
    const mods: Array<[boolean | undefined, number]> = [
      [msg.ctrl, 0x11],
      [msg.shift, 0x10],
      [msg.alt, 0x12],
      [msg.meta, 0x5b],
    ];
    if (kind === 'down') {
      for (const [on, vk] of mods) if (on) this.child.stdin.write(`KEY down ${vk}\n`);
    }
    const vk = virtualKey(String(msg.key || ''), String(msg.code || ''));
    if (vk) this.child.stdin.write(`KEY ${kind} ${vk}\n`);
    if (kind === 'up') {
      for (const [on, code] of mods) if (on) this.child.stdin.write(`KEY up ${code}\n`);
    }
  }

  private async pollViewer(): Promise<void> {
    if (!this.on) return;
    const secret = this.secret();
    const idToken = await this.token();
    if (!secret || !idToken) return;
    const res = await fetch(docUrl(secret, 'box/screenViewer'), { headers: auth(idToken) });
    if (!res.ok) return;
    const json = (await res.json()) as { fields?: Record<string, { stringValue?: string }> };
    const fields = json.fields || {};
    const again = fields.again?.stringValue || '';
    if (again && again !== this.seenAgain) {
      this.seenAgain = again;
      if (this.hadAnswer) {
        this.hadAnswer = false;
        this.session = randomId();
        this.post({ type: 'screenStart', session: this.session });
        return;
      }
    }
    const session = fields.session?.stringValue || '';
    if (session !== this.session) return;
    if (fields.answer?.stringValue) this.hadAnswer = true;
    this.post({
      type: 'screenSignal',
      session,
      answer: fields.answer?.stringValue || '',
      ice: fields.ice?.stringValue || '',
    });
  }

  private async token(): Promise<string | null> {
    const session = await ensureSession();
    return session?.idToken || null;
  }

  private killChild(): void {
    const child = this.child;
    this.child = null;
    this.ready = false;
    if (!child) return;
    try {
      child.stdin.write('QUIT\n');
    } catch {
      /* already closed */
    }
    setTimeout(() => {
      if (!child.killed) child.kill();
    }, 400);
  }
}

function processName(): string {
  const name = vscode.env.appName || '';
  if (/cursor/i.test(name)) return 'Cursor';
  if (/insiders/i.test(name)) return 'Code - Insiders';
  return 'Code';
}

function virtualKey(key: string, code: string): number {
  const named: Record<string, number> = {
    Enter: 0x0d,
    Backspace: 0x08,
    Tab: 0x09,
    Escape: 0x1b,
    ArrowLeft: 0x25,
    ArrowUp: 0x26,
    ArrowRight: 0x27,
    ArrowDown: 0x28,
    Delete: 0x2e,
    Home: 0x24,
    End: 0x23,
    PageUp: 0x21,
    PageDown: 0x22,
    ' ': 0x20,
  };
  if (named[key]) return named[key];
  if (key.length === 1) return key.toUpperCase().charCodeAt(0);
  if (code.startsWith('Key') && code.length === 4) return code.charCodeAt(3);
  if (code.startsWith('Digit') && code.length === 6) return code.charCodeAt(5);
  return 0;
}

function clamp(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function randomId(): string {
  return Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10);
}

function docUrl(secret: string, rel: string): string {
  return API + '/links/' + secret + '/' + rel;
}

function auth(idToken: string): Record<string, string> {
  return { Authorization: 'Bearer ' + idToken };
}

async function patch(secret: string, rel: string, idToken: string, data: Record<string, string>): Promise<void> {
  const fields: Record<string, { stringValue: string }> = {};
  for (const [key, value] of Object.entries(data)) fields[key] = { stringValue: value };
  const mask = Object.keys(data)
    .map((field) => 'updateMask.fieldPaths=' + encodeURIComponent(field))
    .join('&');
  await fetch(docUrl(secret, rel) + '?' + mask, {
    method: 'PATCH',
    headers: { ...auth(idToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
}
