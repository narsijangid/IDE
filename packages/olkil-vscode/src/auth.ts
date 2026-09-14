import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export const OLKIL_HOME = path.join(os.homedir(), '.olkil');
export const SESSION_FILE = path.join(OLKIL_HOME, 'auth-session.json');
const FIREBASE_API_KEY = 'AIzaSyA3z0FDMJrfskddGj4Iair9D2XH3K_IS2k';

export interface OlkilUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
}

export interface OlkilSession {
  user: OlkilUser;
  idToken: string;
  refreshToken: string;
  obtainedAt: number;
  expiresAt: number;
}

function mkdirp(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown) {
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export function authOrigin(): string {
  return String(vscode.workspace.getConfiguration('olkil').get('authOrigin') || 'https://olkil.com').replace(/\/$/, '');
}

export function loadSession(): OlkilSession | null {
  const session = readJson<OlkilSession | null>(SESSION_FILE, null);
  return session && session.idToken ? session : null;
}

export function clearSession() {
  try {
    fs.unlinkSync(SESSION_FILE);
  } catch {
    /* ignore */
  }
}

export function saveSession(session: OlkilSession) {
  writeJson(SESSION_FILE, session);
}

export async function refreshSession(session: OlkilSession): Promise<OlkilSession | null> {
  if (!session.refreshToken) {
    return session;
  }
  if (session.expiresAt && Date.now() < session.expiresAt - 60 * 1000) {
    return session;
  }
  const url =
    'https://securetoken.googleapis.com/v1/token?key=' + encodeURIComponent(FIREBASE_API_KEY);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: session.refreshToken }),
  });
  const json = (await res.json().catch(() => null)) as {
    id_token?: string;
    refresh_token?: string;
    expires_in?: string;
  } | null;
  if (!json?.id_token) {
    return session;
  }
  session.idToken = json.id_token;
  session.refreshToken = json.refresh_token || session.refreshToken;
  session.expiresAt = Date.now() + Number(json.expires_in || 3600) * 1000;
  saveSession(session);
  return session;
}

export async function ensureSession(): Promise<OlkilSession | null> {
  let session = loadSession();
  if (session) {
    session = await refreshSession(session);
    if (session?.idToken) {
      return session;
    }
  }
  return null;
}

function decodeJwt(token: string): Record<string, string> | null {
  try {
    const part = token.split('.')[1];
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function loginWithBrowser(): Promise<{ idToken: string; refreshToken: string }> {
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(16).toString('hex');
    const server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const finish = (payload: { idToken: string; refreshToken: string }) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        server.close();
        resolve(payload);
      };
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (d) => chunks.push(d as Buffer));
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (body.state && body.state !== state) {
              res.writeHead(400);
              res.end('bad state');
              return;
            }
            finish({
              idToken: body.id_token || body.idToken,
              refreshToken: body.refresh_token || body.refreshToken,
            });
          } catch {
            res.writeHead(400);
            res.end('bad json');
          }
        });
        return;
      }
      finish({
        idToken: url.searchParams.get('id_token') || '',
        refreshToken: url.searchParams.get('refresh_token') || '',
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const redirectUri = 'http://127.0.0.1:' + port + '/callback';
      const auth =
        authOrigin() +
        '/auth/ide/?state=' +
        encodeURIComponent(state) +
        '&redirect_uri=' +
        encodeURIComponent(redirectUri) +
        '&client=olkil-vscode&protocol=olkil';
      void vscode.env.openExternal(vscode.Uri.parse(auth));
      setTimeout(() => {
        try {
          server.close();
        } catch {
          /* ignore */
        }
        reject(new Error('Sign-in timed out. Run OLKIL: Sign In again.'));
      }, 5 * 60 * 1000);
    });
    server.on('error', reject);
  });
}

export async function completeLogin(): Promise<OlkilSession> {
  const tokens = await loginWithBrowser();
  if (!tokens.idToken) {
    throw new Error('No tokens from browser');
  }
  const payload = decodeJwt(tokens.idToken) || {};
  const session: OlkilSession = {
    user: {
      uid: payload.user_id || payload.sub || '',
      email: payload.email || null,
      displayName: payload.name || null,
      photoURL: payload.picture || null,
    },
    idToken: tokens.idToken,
    refreshToken: tokens.refreshToken,
    obtainedAt: Date.now(),
    expiresAt: Date.now() + 3500 * 1000,
  };
  saveSession(session);
  return session;
}
