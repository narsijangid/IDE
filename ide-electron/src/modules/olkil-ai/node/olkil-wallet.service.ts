/**
 * OLKIL token meter — per signed-in user, not the shared provider API pack.
 *
 * Company DeepSeek/Poolside keys may have billions of tokens for everyone.
 * This module only subtracts from the user's Lite/Pro/Ultra wallet on olkil.com.
 */
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { homedir } from 'os';
import { pathExists, readJson, writeJson } from 'fs-extra';
import fetch from 'node-fetch';
import type { AiProviderId } from '../common/models';
import { OLKIL_FIREBASE_CONFIG, type OlkilAuthSession } from '../../olkil-auth/common';

const BILLING_ORIGIN = (process.env.OLKIL_BILLING_URL || 'https://olkil.com').replace(/\/$/, '');
const QUOTA_URL = `${BILLING_ORIGIN}/wp-json/olkil-payu/v1/quota`;
const USAGE_URL = `${BILLING_ORIGIN}/wp-json/olkil-payu/v1/usage`;

export class OlkilWalletError extends Error {
  readonly code: string;
  readonly upgradeUrl?: string;
  constructor(message: string, code = 'quota', upgradeUrl?: string) {
    super(message);
    this.name = 'OlkilWalletError';
    this.code = code;
    this.upgradeUrl = upgradeUrl;
  }
}

/** Local Ollama runs on the user's machine — never billed. */
export function isLocalProvider(provider: AiProviderId): boolean {
  return provider === 'ollama';
}

/**
 * Cloud inference that spends the user's OLKIL plan tokens.
 * Dazzlone (Poolside) and local Ollama are always free — even for paid users.
 * Only billed cloud models (DeepSeek) debit the plan wallet.
 */
export function isMeteredProvider(provider: AiProviderId, _isPaid = false): boolean {
  return provider === 'deepseek';
}

export interface OlkilApiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  reasoningTokens: number;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Parse DeepSeek / OpenAI-compatible `usage` (and OpenCode step token objects).
 * Never estimates from text. Reasoning is not added on top of completion —
 * DeepSeek already includes it in `completion_tokens`.
 */
export function parseProviderUsage(raw: unknown): OlkilApiUsage | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const u = raw as Record<string, any>;
  const details = u.completion_tokens_details && typeof u.completion_tokens_details === 'object'
    ? u.completion_tokens_details
    : {};
  const cache = u.cache && typeof u.cache === 'object' ? u.cache : {};

  let promptTokens = num(
    u.prompt_tokens ?? u.promptTokens ?? u.input,
  );
  const completionTokens = num(
    u.completion_tokens ?? u.completionTokens ?? u.output,
  );
  const cacheHitTokens = num(
    u.prompt_cache_hit_tokens ??
      u.prompt_tokens_details?.cached_tokens ??
      cache.read,
  );
  let cacheMissTokens = num(u.prompt_cache_miss_tokens);
  const reasoningTokens = num(
    details.reasoning_tokens ?? u.reasoning_tokens ?? u.reasoning,
  );

  // OpenCode often stores uncached input separately from cache.read.
  if (cacheHitTokens > 0 && promptTokens > 0 && promptTokens < cacheHitTokens) {
    promptTokens += cacheHitTokens;
  }
  if (cacheMissTokens < 1 && cacheHitTokens > 0 && promptTokens >= cacheHitTokens) {
    cacheMissTokens = promptTokens - cacheHitTokens;
  } else if (cacheMissTokens < 1 && cacheHitTokens < 1) {
    cacheMissTokens = promptTokens;
  }

  const reportedTotal = num(u.total_tokens ?? u.total);
  const summed = promptTokens + completionTokens;
  const totalTokens = summed > 0 ? summed : reportedTotal;
  if (totalTokens < 1) {
    return null;
  }
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheHitTokens,
    cacheMissTokens,
    reasoningTokens,
  };
}

export function addApiUsage(a: OlkilApiUsage | null, b: OlkilApiUsage | null): OlkilApiUsage | null {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cacheHitTokens: a.cacheHitTokens + b.cacheHitTokens,
    cacheMissTokens: a.cacheMissTokens + b.cacheMissTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = String(text || '')
    .replace(/^\uFEFF/, '')
    .trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function httpJson(
  url: string,
  opts?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; data: Record<string, unknown> | null }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'OLKIL-IDE',
      ...(opts?.headers || {}),
    };
    if (opts?.body) {
      headers['Content-Length'] = String(Buffer.byteLength(opts.body));
    }
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: opts?.method || 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            data: parseJsonObject(Buffer.concat(chunks).toString('utf8')),
          });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(20000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    if (opts?.body) {
      req.write(opts.body);
    }
    req.end();
  });
}

let loadedSessionFile = '';

function sessionCandidates(): string[] {
  const dirs: string[] = [];
  const dataFolder = process.env.DATA_FOLDER;
  if (dataFolder) {
    dirs.push(path.isAbsolute(dataFolder) ? dataFolder : path.join(homedir(), dataFolder));
  }
  dirs.push(path.join(homedir(), '.olkil'));
  dirs.push(path.join(homedir(), '.sumi'));
  const out: string[] = [];
  for (const dir of dirs) {
    const p = path.join(dir, 'auth-session.json');
    if (!out.includes(p)) {
      out.push(p);
    }
  }
  return out;
}

function sessionPath(): string {
  return loadedSessionFile || path.join(homedir(), '.olkil', 'auth-session.json');
}

async function loadSession(): Promise<OlkilAuthSession | null> {
  for (const file of sessionCandidates()) {
    if (!(await pathExists(file))) {
      continue;
    }
    try {
      const session = (await readJson(file)) as OlkilAuthSession;
      loadedSessionFile = file;
      return session;
    } catch {
      continue;
    }
  }
  return null;
}

async function refreshIdToken(refreshToken: string): Promise<{ idToken: string; expiresIn: number }> {
  const endpoint = `https://securetoken.googleapis.com/v1/token?key=${OLKIL_FIREBASE_CONFIG.apiKey}`;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  }).toString();
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = (await res.json()) as { id_token?: string; expires_in?: string };
  if (!res.ok || !data.id_token) {
    throw new Error('token_refresh_failed');
  }
  return { idToken: String(data.id_token), expiresIn: Number(data.expires_in || 3600) };
}

async function validIdToken(): Promise<string | null> {
  const session = await loadSession();
  if (!session?.refreshToken) {
    return null;
  }
  const skew = 60_000;
  if (session.idToken && session.expiresAt && Date.now() < session.expiresAt - skew) {
    return session.idToken;
  }
  try {
    const next = await refreshIdToken(session.refreshToken);
    const updated: OlkilAuthSession = {
      ...session,
      idToken: next.idToken,
      obtainedAt: Date.now(),
      expiresAt: Date.now() + next.expiresIn * 1000,
    };
    await writeJson(sessionPath(), updated, { spaces: 2 }).catch(() => undefined);
    return next.idToken;
  } catch {
    return session.idToken || null;
  }
}

type QuotaPayload = {
  allowed?: boolean;
  cloud_allowed?: boolean;
  reason?: string;
  message?: string;
  upgrade_url?: string;
  subscription?: {
    is_paid?: boolean;
    tokens_left?: number;
    tokens_used?: number;
    spendable_left?: number;
    quota_reason?: string;
  };
};

type QuotaDecision = {
  at: number;
  allowed: boolean;
  isPaid: boolean;
  message: string;
  reason: string;
  upgradeUrl?: string;
};

let quotaCache: QuotaDecision | null = null;

function signInMessage(): string {
  return 'Sign in to OLKIL to use cloud models. Dazzlone (free) and local Ollama still work.';
}

function usedUpMessage(): string {
  return 'Your OLKIL token allowance is used up. Buy the same plan again for a fresh 30 days, or upgrade.';
}

function applyCache(next: QuotaDecision): QuotaDecision {
  quotaCache = next;
  return next;
}

function decisionFromSubscription(sub: {
  is_paid?: boolean;
  tokens_left?: number;
  spendable_left?: number;
  quota_reason?: string;
  upgrade_url?: string;
} | null): QuotaDecision | null {
  if (!sub) {
    return null;
  }
  const spendable = Number(sub.spendable_left ?? sub.tokens_left ?? 0);
  const isPaid = Boolean(sub.is_paid) || spendable > 0 || sub.quota_reason === 'ok';
  const allowed = sub.quota_reason === 'ok' || (isPaid && spendable > 0);
  const reason = String(sub.quota_reason || (allowed ? 'ok' : isPaid ? 'quota_exceeded' : 'plan_required'));
  return {
    at: Date.now(),
    allowed,
    isPaid,
    message: allowed ? '' : usedUpMessage(),
    reason,
    upgradeUrl: sub.upgrade_url,
  };
}

async function quotaFromEmailFallback(): Promise<QuotaDecision | null> {
  const session = await loadSession();
  const email = session?.user?.email;
  if (!email) {
    return null;
  }
  try {
    const url = `${BILLING_ORIGIN}/wp-json/olkil-payu/v1/subscription?email=${encodeURIComponent(email)}`;
    const { status, data } = await httpJson(url);
    if (status < 200 || status >= 300 || !data) {
      return null;
    }
    return decisionFromSubscription(data as Parameters<typeof decisionFromSubscription>[0]);
  } catch {
    return null;
  }
}

async function fetchQuotaDecision(idToken: string): Promise<QuotaDecision> {
  const session = await loadSession();
  const email = session?.user?.email || '';
  const body = JSON.stringify({ id_token: idToken, email });
  const { status, data } = await httpJson(QUOTA_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body,
  });

  if (status === 401 || status === 403) {
    const fallback = await quotaFromEmailFallback();
    if (fallback) {
      return fallback;
    }
    return {
      at: Date.now(),
      allowed: false,
      isPaid: false,
      message: signInMessage(),
      reason: 'auth_required',
    };
  }

  if (status < 200 || status >= 300 || !data) {
    const fallback = await quotaFromEmailFallback();
    if (fallback) {
      return fallback;
    }
    return {
      at: Date.now(),
      allowed: false,
      isPaid: false,
      message: 'Could not verify your OLKIL plan. Check the network, then retry. Dazzlone and local Ollama still work.',
      reason: 'quota_unavailable',
    };
  }

  const sub = (data.subscription && typeof data.subscription === 'object'
    ? (data.subscription as Record<string, unknown>)
    : data) as QuotaPayload['subscription'] & Record<string, unknown>;
  const spendable = Number(sub?.spendable_left ?? sub?.tokens_left ?? 0);
  const allowed =
    data.allowed === true ||
    data.cloud_allowed === true ||
    data.reason === 'ok' ||
    spendable > 0;
  const isPaid = Boolean(sub?.is_paid) || spendable > 0;
  const reason = String(data.reason || (allowed ? 'ok' : 'quota_exceeded'));
  const fromApi = typeof data.message === 'string' ? String(data.message).trim() : '';
  return {
    at: Date.now(),
    allowed,
    isPaid,
    message: allowed
      ? ''
      : fromApi || (reason === 'quota_exceeded' ? usedUpMessage() : signInMessage()),
    reason,
    upgradeUrl: typeof data.upgrade_url === 'string' ? data.upgrade_url : undefined,
  };
}

export async function assertOlkilWallet(provider: AiProviderId): Promise<void> {
  if (isLocalProvider(provider) || provider === 'poolside') {
    return;
  }

  if (quotaCache?.allowed && Date.now() - quotaCache.at < 5_000) {
    return;
  }

  // Same API the website dashboard uses — this is the source of truth.
  const fromEmail = await quotaFromEmailFallback();
  if (fromEmail?.allowed) {
    applyCache(fromEmail);
    return;
  }

  const token = await validIdToken();
  if (token) {
    try {
      const decision = applyCache(await fetchQuotaDecision(token));
      if (decision.allowed) {
        return;
      }
      if (fromEmail?.allowed) {
        applyCache(fromEmail);
        return;
      }
      if (decision.reason === 'quota_exceeded' && isMeteredProvider(provider, decision.isPaid)) {
        throw new OlkilWalletError(decision.message || usedUpMessage(), decision.reason, decision.upgradeUrl);
      }
      if (decision.reason === 'auth_required') {
        throw new OlkilWalletError(signInMessage(), 'auth_required');
      }
      // Network/parse uncertainty: do not fake "tokens used up" for a paying user.
      return;
    } catch (err) {
      if (err instanceof OlkilWalletError) {
        throw err;
      }
      if (fromEmail?.allowed) {
        applyCache(fromEmail);
        return;
      }
      return;
    }
  }

  if (!fromEmail) {
    throw new OlkilWalletError(signInMessage(), 'auth_required');
  }
  if (!fromEmail.allowed && isMeteredProvider(provider, fromEmail.isPaid)) {
    throw new OlkilWalletError(fromEmail.message, fromEmail.reason, fromEmail.upgradeUrl);
  }
}

export async function chargeOlkilWallet(opts: {
  provider: AiProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  requestId: string;
  usage?: OlkilApiUsage | null;
}): Promise<boolean> {
  const usage = opts.usage && opts.usage.totalTokens > 0 ? opts.usage : null;
  const inputTokens = usage ? usage.promptTokens : Math.max(0, Math.floor(opts.inputTokens));
  const outputTokens = usage ? usage.completionTokens : Math.max(0, Math.floor(opts.outputTokens));
  const tokens = usage ? usage.totalTokens : inputTokens + outputTokens;
  if (tokens < 1 || !isMeteredProvider(opts.provider)) {
    console.warn('[olkil-wallet] skip charge', {
      provider: opts.provider,
      tokens,
      metered: isMeteredProvider(opts.provider),
      source: usage ? 'api' : 'none',
    });
    return false;
  }

  const token = await validIdToken();
  if (!token) {
    console.warn('[olkil-wallet] skip charge: no id token');
    return false;
  }
  const session = await loadSession();
  try {
    const body = JSON.stringify({
      tokens,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      prompt_cache_hit_tokens: usage?.cacheHitTokens || 0,
      prompt_cache_miss_tokens: usage?.cacheMissTokens || 0,
      reasoning_tokens: usage?.reasoningTokens || 0,
      model: opts.model,
      provider: opts.provider,
      request_id: opts.requestId,
      id_token: token,
      email: session?.user?.email || '',
    });
    const { status, data } = await httpJson(USAGE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body,
    });
    if (status < 200 || status >= 300 || !data) {
      console.warn('[olkil-wallet] charge http failed', { status, hasData: Boolean(data) });
      return false;
    }
    const ok = data.ok === true || data.deduped === true;
    if (!ok) {
      console.warn('[olkil-wallet] charge rejected', { status, reason: data.reason });
      return false;
    }
    const sub = (data.subscription && typeof data.subscription === 'object'
      ? (data.subscription as Record<string, unknown>)
      : {}) as QuotaPayload['subscription'] & Record<string, unknown>;
    const spendable = Number(sub?.spendable_left ?? sub?.tokens_left ?? 0);
    quotaCache = {
      at: Date.now(),
      allowed: data.allowed === true || data.cloud_allowed === true || data.ok === true || spendable > 0,
      isPaid: Boolean(sub?.is_paid ?? quotaCache?.isPaid) || spendable > 0,
      message: String(data.message || ''),
      reason: String(data.reason || 'ok'),
      upgradeUrl: typeof data.upgrade_url === 'string' ? data.upgrade_url : undefined,
    };
    console.warn('[olkil-wallet] charged', {
      tokens,
      input: inputTokens,
      output: outputTokens,
      cacheHit: usage?.cacheHitTokens || 0,
      cacheMiss: usage?.cacheMissTokens || 0,
      reasoning: usage?.reasoningTokens || 0,
      used: sub?.tokens_used,
      left: sub?.tokens_left,
    });
    return true;
  } catch (err) {
    console.warn('[olkil-wallet] charge error', err instanceof Error ? err.message : err);
    return false;
  }
}
