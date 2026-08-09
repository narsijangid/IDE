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

interface PendingFlow {
  state: string;
  server: http.Server;
  port: number;
  resolve: (payload: OlkilAuthCallbackPayload) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  settled: boolean;
}

@Injectable()
export class OlkilAuthNodeService implements IOlkilAuthNodeService {
  private pending: PendingFlow | null = null;

  private dataDir(): string {
    const folder = process.env.DATA_FOLDER || '.olkil';
    return join(homedir(), folder);
  }

  private sessionPath(): string {
    return join(this.dataDir(), SESSION_FILE);
  }

  async beginLoginFlow(state: string, timeoutMs = LOGIN_TIMEOUT_MS): Promise<OlkilAuthLoopbackResult> {
    await this.cancelLoginFlow();

    const server = http.createServer();
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
    const waitPromise = new Promise<OlkilAuthCallbackPayload>((resolve, reject) => {
      resolveCb = resolve;
      rejectCb = reject;
    });

    const pending: PendingFlow = {
      state,
      server,
      port: listenPort,
      resolve: resolveCb,
      reject: rejectCb,
      settled: false,
      timer: setTimeout(() => {
        void this.failPending(new Error('Login timed out. Try again from OLKIL.'));
      }, timeoutMs),
    };
    this.pending = pending;

    // Attach waiter so waitForCallback can return the same promise
    (pending as any)._wait = waitPromise;

    server.on('request', (req, res) => {
      void this.handleLoopbackRequest(req, res);
    });

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
    return (pending as any)._wait as Promise<OlkilAuthCallbackPayload>;
  }

  async cancelLoginFlow(): Promise<void> {
    if (!this.pending) {
      return;
    }
    await this.failPending(new Error('Login cancelled'), false);
  }

  private async failPending(error: Error, reject = true): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.settled) {
      return;
    }
    pending.settled = true;
    clearTimeout(pending.timer);
    this.pending = null;
    await new Promise<void>((resolve) => {
      pending.server.close(() => resolve());
    });
    if (reject) {
      pending.reject(error);
    }
  }

  private async handleLoopbackRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    const pending = this.pending;
    if (!pending) {
      res.writeHead(410, { ...cors, 'Content-Type': 'text/plain' });
      res.end('Login session expired');
      return;
    }

    try {
      const host = req.headers.host || `127.0.0.1:${pending.port}`;
      const url = new URL(req.url || '/', `http://${host}`);

      if (url.pathname !== '/callback') {
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
        res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid_state' }));
        return;
      }
      if (!idToken || !refreshToken) {
        res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'missing_tokens' }));
        return;
      }

      const payload: OlkilAuthCallbackPayload = { state, idToken, refreshToken };
      pending.settled = true;
      clearTimeout(pending.timer);
      this.pending = null;

      // JSON for fetch(); HTML for accidental browser navigation
      const wantsHtml = (req.headers.accept || '').includes('text/html') && req.method === 'GET';
      if (wantsHtml) {
        res.writeHead(200, { ...cors, 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          htmlPage(
            'Signed in to OLKIL',
            'You can close this tab and return to the OLKIL app.',
            true,
          ),
        );
      } else {
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }

      pending.server.close();
      pending.resolve(payload);
    } catch (err: any) {
      res.writeHead(500, { ...cors, 'Content-Type': 'text/plain' });
      res.end('Internal error');
      await this.failPending(err instanceof Error ? err : new Error(String(err)));
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

function htmlPage(title: string, message: string, success = false): string {
  const color = success ? '#22c55e' : '#ef4444';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#050506;color:#f4f4f5;
  font-family:Segoe UI,system-ui,sans-serif}
  .card{max-width:420px;padding:2rem;border:1px solid rgba(255,255,255,.08);border-radius:16px;background:#111114;text-align:center}
  h1{font-size:1.25rem;margin:0 0 .75rem;color:${color}}
  p{margin:0;color:#a1a1aa;line-height:1.5}
</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div>
<script>try{window.close()}catch(e){}</script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  );
}
