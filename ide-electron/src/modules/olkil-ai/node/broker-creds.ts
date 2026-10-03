import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const BILLING = (process.env.OLKIL_BILLING_URL || 'https://olkil.com').replace(/\/$/, '');

const ENGINE_URLS = [
  `${BILLING}/wp-json/olkil-payu/v1/engine`,
  'https://asia-south1-olkil-2c8ac.cloudfunctions.net/olkilPayuApi/v1/engine',
  'https://olkilpayuapi-2k3jxx4n5q-el.a.run.app/v1/engine',
];

export interface BrokerCreds {
  apiKey: string;
  baseURL: string;
  model: string;
  exp: number;
}

let cache: BrokerCreds | null = null;

/** Company pool keys must never be used, stored, or sent by the desktop app. */
export function isUpstreamProviderKey(value: string): boolean {
  const v = String(value || '').trim();
  return /^sk-or-/i.test(v) || /^sky_/i.test(v);
}

export function cachedBroker(): BrokerCreds | null {
  if (!cache || cache.exp < Date.now() + 60_000) {
    return null;
  }
  if (isUpstreamProviderKey(cache.apiKey) || !cache.apiKey.startsWith('olk1.')) {
    return null;
  }
  if (!cache.baseURL.includes('/olkil-payu/v1/broker/')) {
    return null;
  }
  return cache;
}

function sessionFiles(): string[] {
  const dirs = [path.join(os.homedir(), '.olkil'), path.join(os.homedir(), '.sumi')];
  const data = process.env.DATA_FOLDER;
  if (data) {
    dirs.unshift(path.isAbsolute(data) ? data : path.join(os.homedir(), data));
  }
  return dirs.map((dir) => path.join(dir, 'auth-session.json'));
}

async function readIdToken(): Promise<{ idToken: string; email: string } | null> {
  for (const file of sessionFiles()) {
    try {
      const session = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        idToken?: string;
        user?: { email?: string };
      };
      const idToken = String(session.idToken || '').trim();
      if (idToken) {
        return { idToken, email: String(session.user?.email || '') };
      }
    } catch {
      /* next file */
    }
  }
  return null;
}

function accept(json: Record<string, unknown> | null): BrokerCreds | null {
  if (!json) {
    return null;
  }
  const apiKey = String(json.apiKey || json.key || '').trim();
  const baseURL = String(json.baseURL || '').trim().replace(/\/+$/, '');
  if (!apiKey.startsWith('olk1.') || isUpstreamProviderKey(apiKey)) {
    return null;
  }
  if (!baseURL.includes('/olkil-payu/v1/broker/')) {
    return null;
  }
  return {
    apiKey,
    baseURL,
    model: String(json.model || 'deepseek/deepseek-v4-flash'),
    exp: Date.now() + 11 * 60 * 60 * 1000,
  };
}

/**
 * Ask OLKIL for a broker grant. A response that contains a provider key is ignored.
 */
export async function ensureOpenRouterBroker(): Promise<BrokerCreds | null> {
  const hit = cachedBroker();
  if (hit) {
    return hit;
  }
  const session = await readIdToken();
  if (!session) {
    return null;
  }
  const body = JSON.stringify({ id_token: session.idToken, email: session.email });
  for (const url of ENGINE_URLS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.idToken}`,
          'Content-Type': 'application/json',
        },
        body,
      });
      if (!res.ok) {
        continue;
      }
      const creds = accept((await res.json().catch(() => null)) as Record<string, unknown> | null);
      if (creds) {
        cache = creds;
        return creds;
      }
    } catch {
      /* try the next origin */
    }
  }
  return null;
}
