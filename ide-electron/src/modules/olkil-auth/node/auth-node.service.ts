import http from 'http';
import { URL } from 'url';
import { join } from 'path';
import { homedir } from 'os';
import { ensureDir, pathExists, readJson, writeJson, remove } from 'fs-extra';
import { Injectable } from '@opensumi/di';
import {
  IOlkilAuthNodeService,
  OlkilAuthCallbackPayload,
  OlkilAuthLoopbackResult,
  OlkilAuthSession,
  OLKIL_FIREBASE_CONFIG,
} from '../common';

const SESSION_FILE = 'auth-session.json';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** Keep loopback alive so a late browser GET still gets a success page (not ERR_CONNECTION_REFUSED). */
const HOLD_OPEN_MS = 90_000;

interface PendingFlow {
  state: string;
  server: http.Server;
  port: number;
  resolve: (payload: OlkilAuthCallbackPayload) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  settled: boolean;
  holdTimer?: NodeJS.Timeout;
  /** Shared waiter promise for waitForCallback */
  wait: Promise<OlkilAuthCallbackPayload>;
}

@Injectable()
export class OlkilAuthNodeService implements IOlkilAuthNodeService {
  private pending: PendingFlow | null = null;
  /** After success, serve success HTML for late GETs until hold expires. */
  private recentSuccess: { port: number; until: number; server: http.Server } | null = null;

  private dataDir(): string {
    const folder = process.env.DATA_FOLDER || '.olkil';
    return join(homedir(), folder);
  }

  private sessionPath(): string {
    return join(this.dataDir(), SESSION_FILE);
  }

  async beginLoginFlow(state: string, timeoutMs = LOGIN_TIMEOUT_MS): Promise<OlkilAuthLoopbackResult> {
    // Always tear down any previous incomplete login (fixes "Opening browser…" stuck)
    await this.cancelLoginFlow();
    await this.closeRecentSuccess();

    const server = http.createServer((req, res) => {
      void this.handleLoopbackRequest(req, res);
    });

    const listenPort = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          resolve(addr.port);
        } else {
          reject(new Error('Failed to bind auth loopback port'));
        }
      });
    });

    let resolveCb!: (payload: OlkilAuthCallbackPayload) => void;
    let rejectCb!: (err: Error) => void;
    const wait = new Promise<OlkilAuthCallbackPayload>((resolve, reject) => {
      resolveCb = resolve;
      rejectCb = reject;
    });

    const pending: PendingFlow = {
      state,
      server,
      port: listenPort,
      resolve: resolveCb,
      reject: rejectCb,
      wait,
      settled: false,
      timer: setTimeout(() => {
        void this.failPending(new Error('Login timed out. Try again from OLKIL.'), true);
      }, timeoutMs),
    };
    this.pending = pending;

    return {
      port: listenPort,
      redirectUri: `http://127.0.0.1:${listenPort}/callback`,
    };
  }

  async waitForCallback(state: string): Promise<OlkilAuthCallbackPayload> {
    const pending = this.pending;
    if (!pending || pending.state !== state) {
      throw new Error('No login flow in progress');
    }
    return pending.wait;
  }

  async cancelLoginFlow(): Promise<void> {
    // Always reject the waiter so browser-side signInFlight can settle
    await this.failPending(new Error('Login cancelled'), true);
  }

  private async closeRecentSuccess(): Promise<void> {
    const recent = this.recentSuccess;
    if (!recent) {
      return;
    }
    this.recentSuccess = null;
    await new Promise<void>((resolve) => {
      recent.server.close(() => resolve());
    });
  }

  private async failPending(error: Error, rejectWaiter: boolean): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.settled) {
      return;
    }
    pending.settled = true;
    clearTimeout(pending.timer);
    if (pending.holdTimer) {
      clearTimeout(pending.holdTimer);
    }
    this.pending = null;
    await new Promise<void>((resolve) => {
      pending.server.close(() => resolve());
    });
    if (rejectWaiter) {
      pending.reject(error);
    }
  }

  private settleSuccess(pending: PendingFlow, payload: OlkilAuthCallbackPayload): void {
    if (pending.settled) {
      return;
    }
    pending.settled = true;
    clearTimeout(pending.timer);
    this.pending = null;
    this.recentSuccess = {
      port: pending.port,
      until: Date.now() + HOLD_OPEN_MS,
      server: pending.server,
    };
    pending.holdTimer = setTimeout(() => {
      void this.closeRecentSuccess();
    }, HOLD_OPEN_MS);
    pending.resolve(payload);
  }

  private corsHeaders() {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Private-Network': 'true',
    };
  }

  private writeSuccessHtml(res: http.ServerResponse): void {
    res.writeHead(200, { ...this.corsHeaders(), 'Content-Type': 'text/html; charset=utf-8' });
    res.end(successHtmlPage());
  }

  private writeSuccessJson(res: http.ServerResponse): void {
    res.writeHead(200, { ...this.corsHeaders(), 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  private async handleLoopbackRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const cors = this.corsHeaders();

    // Chrome Private Network Access preflight from https://olkil.com → http://127.0.0.1
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...cors,
        'Access-Control-Allow-Private-Network': 'true',
      });
      res.end();
      return;
    }

    const pending = this.pending;
    const recent = this.recentSuccess;
    const host = req.headers.host || `127.0.0.1:${pending?.port || recent?.port || 0}`;
    let url: URL;
    try {
      url = new URL(req.url || '/', `http://${host}`);
    } catch {
      res.writeHead(400, { ...cors, 'Content-Type': 'text/plain' });
      res.end('Bad request');
      return;
    }

    const wantsHtml =
      req.method === 'GET' &&
      ((req.headers.accept || '').includes('text/html') ||
        !(req.headers.accept || '').includes('application/json'));

    // Late request after tokens already accepted — still show success (Cursor-style)
    if ((!pending || pending.settled) && recent && Date.now() < recent.until) {
      if (url.pathname !== '/callback' && url.pathname !== '/') {
        res.writeHead(404, { ...cors, 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      if (wantsHtml) {
        this.writeSuccessHtml(res);
      } else {
        this.writeSuccessJson(res);
      }
      return;
    }

    if (!pending) {
      if (wantsHtml) {
        res.writeHead(410, { ...cors, 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          htmlPage(
            'Login session ended',
            'This sign-in link is no longer active. Return to OLKIL and try Sign in again.',
            false,
          ),
        );
      } else {
        res.writeHead(410, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'expired' }));
      }
      return;
    }

    try {
      if (url.pathname !== '/callback' && url.pathname !== '/') {
        res.writeHead(404, { ...cors, 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }

      let state = url.searchParams.get('state') || '';
      let idToken = url.searchParams.get('id_token') || url.searchParams.get('idToken') || '';
      let refreshToken =
        url.searchParams.get('refresh_token') || url.searchParams.get('refreshToken') || '';

      if (req.method === 'POST') {
        const body = await readBody(req);
        try {
          const json = JSON.parse(body);
          state = String(json.state || state);
          idToken = String(json.id_token || json.idToken || idToken);
          refreshToken = String(json.refresh_token || json.refreshToken || refreshToken);
        } catch {
          // ignore
        }
      }

      if (!state || state !== pending.state) {
        if (wantsHtml) {
          res.writeHead(400, { ...cors, 'Content-Type': 'text/html; charset=utf-8' });
          res.end(htmlPage('Sign-in failed', 'Invalid or mismatched login state. Try again from OLKIL.', false));
        } else {
          res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid_state' }));
        }
        return;
      }
      if (!idToken || !refreshToken) {
        if (wantsHtml) {
          res.writeHead(400, { ...cors, 'Content-Type': 'text/html; charset=utf-8' });
          res.end(htmlPage('Sign-in failed', 'Missing account tokens. Try again from OLKIL.', false));
        } else {
          res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'missing_tokens' }));
        }
        return;
      }

      const payload: OlkilAuthCallbackPayload = { state, idToken, refreshToken };

      // Respond BEFORE settling so the browser always gets a page/JSON
      if (wantsHtml) {
        this.writeSuccessHtml(res);
      } else {
        this.writeSuccessJson(res);
      }

      this.settleSuccess(pending, payload);
    } catch (err: any) {
      if (!res.headersSent) {
        if (wantsHtml) {
          res.writeHead(500, { ...cors, 'Content-Type': 'text/html; charset=utf-8' });
          res.end(htmlPage('Sign-in error', 'Something went wrong. Return to OLKIL and try again.', false));
        } else {
          res.writeHead(500, { ...cors, 'Content-Type': 'text/plain' });
          res.end('Internal error');
        }
      }
      await this.failPending(err instanceof Error ? err : new Error(String(err)), true);
    }
  }

  async saveSession(session: OlkilAuthSession): Promise<void> {
    await ensureDir(this.dataDir());
    await writeJson(this.sessionPath(), session, { spaces: 2 });
  }

  async loadSession(): Promise<OlkilAuthSession | null> {
    const path = this.sessionPath();
    if (!(await pathExists(path))) {
      return null;
    }
    try {
      return (await readJson(path)) as OlkilAuthSession;
    } catch {
      return null;
    }
  }

  async clearSession(): Promise<void> {
    const path = this.sessionPath();
    if (await pathExists(path)) {
      await remove(path);
    }
  }

  async refreshIdToken(refreshToken: string): Promise<{ idToken: string; expiresIn: number }> {
    const endpoint = `https://securetoken.googleapis.com/v1/token?key=${OLKIL_FIREBASE_CONFIG.apiKey}`;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString();

    const data = await postFormJson(endpoint, body);
    if (!data.id_token) {
      throw new Error('Token refresh response missing id_token');
    }
    return {
      idToken: String(data.id_token),
      expiresIn: Number(data.expires_in || 3600),
    };
  }
}

function postFormJson(url: string, body: string): Promise<Record<string, any>> {
  const https = require('https') as typeof import('https');
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode || 500) >= 400) {
            reject(new Error(`Token refresh failed (${res.statusCode}): ${text}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function successHtmlPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Signed in · OLKIL</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      background: radial-gradient(1200px 600px at 50% -10%, rgba(254,1,154,.22), transparent 55%), #050506;
      color: #f4f4f5; font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
    }
    .card {
      width: min(100% - 2rem, 440px); padding: 2.25rem 1.75rem 1.75rem;
      border: 1px solid rgba(255,255,255,.08); border-radius: 18px;
      background: rgba(17,17,20,.92); text-align: center;
      box-shadow: 0 24px 80px rgba(0,0,0,.45);
    }
    .mark {
      width: 56px; height: 56px; margin: 0 auto 1.1rem; border-radius: 50%;
      display: grid; place-items: center; background: rgba(34,197,94,.14);
      border: 1px solid rgba(34,197,94,.35); color: #4ade80; font-size: 1.6rem;
    }
    h1 { margin: 0 0 .55rem; font-size: 1.35rem; font-weight: 650; letter-spacing: -.02em; }
    p { margin: 0 0 1.35rem; color: #a1a1aa; line-height: 1.55; font-size: .95rem; }
    .actions { display: grid; gap: .7rem; }
    a.btn, button.btn {
      appearance: none; display: inline-flex; align-items: center; justify-content: center;
      width: 100%; min-height: 44px; border-radius: 10px; font-size: .95rem; font-weight: 600;
      text-decoration: none; cursor: pointer; border: none;
    }
    .btn-primary { background: #fe019a; color: #fff; }
    .btn-primary:hover { background: #ff4db8; }
    .btn-ghost { background: transparent; color: #e4e4e7; border: 1px solid rgba(255,255,255,.14); }
    .btn-ghost:hover { background: rgba(255,255,255,.05); }
    .hint { margin: 1rem 0 0; font-size: .78rem; color: #71717a; }
  </style>
</head>
<body>
  <div class="card">
    <div class="mark" aria-hidden="true">✓</div>
    <h1>You're signed in</h1>
    <p>OLKIL received your account. You can return to the app now — this tab can be closed.</p>
    <div class="actions">
      <a class="btn btn-primary" href="olkil://auth/done">Open OLKIL</a>
      <button type="button" class="btn btn-ghost" id="closeBtn">Close this tab</button>
    </div>
    <p class="hint">If the app doesn't focus automatically, switch back to OLKIL manually.</p>
  </div>
  <script>
    (function () {
      var btn = document.getElementById('closeBtn');
      if (btn) btn.addEventListener('click', function () {
        try { window.close(); } catch (e) {}
        document.body.innerHTML = '<div class="card"><h1>You can close this tab</h1><p>Return to the OLKIL app.</p></div>';
      });
    })();
  </script>
</body>
</html>`;
}

function htmlPage(title: string, message: string, success = false): string {
  const color = success ? '#4ade80' : '#f87171';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#050506;color:#f4f4f5;
  font-family:Segoe UI,system-ui,sans-serif}
  .card{max-width:420px;padding:2rem;border:1px solid rgba(255,255,255,.08);border-radius:16px;background:#111114;text-align:center}
  h1{font-size:1.25rem;margin:0 0 .75rem;color:${color}}
  p{margin:0 0 1.25rem;color:#a1a1aa;line-height:1.5}
  a{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:0 1.1rem;border-radius:10px;
    background:#fe019a;color:#fff;text-decoration:none;font-weight:600}
</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>
<a href="olkil://auth/done">Open OLKIL</a></div>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  );
}
