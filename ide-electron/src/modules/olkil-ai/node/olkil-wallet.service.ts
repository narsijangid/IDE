/**
 * OLKIL usage meter — per signed-in user, not the shared provider API pack.
 *
 * Company keys may have large provider balances. This module only subtracts
 * from the user's Lite/Pro/Ultra model credit on olkil.com.
 */
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { homedir } from 'os';
import { ensureDir, pathExists, readJson, writeJson } from 'fs-extra';
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
 * Cloud inference that spends the user's OLKIL plan credit.
 * Local Ollama is always free. Only OpenRouter / DeepSeek debit the plan wallet.
 */
export function isMeteredProvider(provider: AiProviderId, _isPaid = false): boolean {
  return provider === 'deepseek' || provider === 'openrouter';
}

/** Free-plan DeepSeek allowance (not Lite/Pro/Ultra). */
export const FREE_DEEPSEEK_TOKENS = 50_000;

export interface DeepseekAccess {
  signedIn: boolean;
  isPaid: boolean;
  used: number;
  limit: number;
  remaining: number;
  locked: boolean;
  /** Paid Lite/Pro/Ultra included usage is gone. */
  cloudLocked: boolean;
  message: string;
}

function isPaidPlanName(plan?: string): boolean {
  return /\b(lite|pro|ultra)\b/i.test(String(plan || ''));
}

function freeTokenFile(): string {
  return path.join(homedir(), '.olkil', 'deepseek-free-tokens.json');
}

type FreeTokenStore = Record<string, { tokens: number; at: number }>;

async function readFreeStore(): Promise<FreeTokenStore> {
  const file = freeTokenFile();
  if (!(await pathExists(file))) {
    return {};
  }
  try {
    const raw = (await readJson(file)) as FreeTokenStore;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

async function readFreeTokens(email: string): Promise<number> {
  const key = email.trim().toLowerCase();
  if (!key) {
    return 0;
  }
  const used = Number((await readFreeStore())[key]?.tokens || 0);
  return Number.isFinite(used) && used > 0 ? Math.floor(used) : 0;
}

async function addFreeTokens(email: string, delta: number): Promise<number> {
  const key = email.trim().toLowerCase();
  if (!key || delta < 1) {
    return readFreeTokens(email);
  }
  const file = freeTokenFile();
  await ensureDir(path.dirname(file));
  const raw = await readFreeStore();
  const next = Math.floor(Number(raw[key]?.tokens || 0) + delta);
  raw[key] = { tokens: next, at: Date.now() };
  await writeJson(file, raw);
  return next;
}

function freeTokensExhaustedMessage(): string {
  return 'Your 50,000 free DeepSeek tokens are used up. Upgrade your plan to keep using DeepSeek.';
}

export interface OlkilApiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  reasoningTokens: number;
  costUsd?: number;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function costNum(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n < 500 ? n : 0;
}

type OpenRouterTokenRates = {
  prompt: number;
  completion: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
};

let openRouterRates: Map<string, OpenRouterTokenRates> | null = null;
let openRouterRatesAt = 0;
let openRouterRatesLoad: Promise<void> | null = null;
const OPENROUTER_RATES_TTL_MS = 6 * 60 * 60 * 1000;

function perTokenRate(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function loadOpenRouterRates(force = false): Promise<void> {
  if (!force && openRouterRates && Date.now() - openRouterRatesAt < OPENROUTER_RATES_TTL_MS) return;
  if (!openRouterRatesLoad) {
    openRouterRatesLoad = (async () => {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { 'HTTP-Referer': 'https://olkil.com', 'X-Title': 'OLKIL' },
      });
      if (!res.ok) return;
      const json = (await res.json()) as { data?: Array<Record<string, any>> };
      const map = new Map<string, OpenRouterTokenRates>();
      for (const row of json.data || []) {
        const id = String(row?.id || '')
          .trim()
          .toLowerCase();
        const pricing = row?.pricing;
        if (!id || !pricing || typeof pricing !== 'object') continue;
        const prompt = perTokenRate(pricing.prompt);
        const completion = perTokenRate(pricing.completion);
        if (!(prompt > 0) && !(completion > 0)) continue;
        map.set(id, {
          prompt,
          completion,
          cacheRead: perTokenRate(pricing.input_cache_read),
          cacheWrite: perTokenRate(pricing.input_cache_write),
          reasoning: perTokenRate(pricing.internal_reasoning),
        });
      }
      if (map.size) {
        openRouterRates = map;
        openRouterRatesAt = Date.now();
      }
    })().finally(() => {
      openRouterRatesLoad = null;
    });
  }
  await openRouterRatesLoad;
}

export function estimateOlkilCostUsd(model: string, usage: OlkilApiUsage | null): number {
  if (usage?.costUsd && usage.costUsd > 0) {
    return usage.costUsd;
  }
  if (!usage) return 0;
  const slug = String(model || '')
    .replace(/^openrouter:/i, '')
    .trim()
    .toLowerCase();
  const rates = openRouterRates?.get(slug);
  if (!rates) return 0;
  const input = Math.max(0, usage.promptTokens);
  const cacheRead = Math.min(Math.max(0, usage.cacheHitTokens), input);
  const room = Math.max(0, input - cacheRead);
  const output = Math.max(0, usage.completionTokens);
  const reasoning = Math.max(0, usage.reasoningTokens);
  const readRate = rates.cacheRead > 0 ? rates.cacheRead : rates.prompt;
  let outputUsd = 0;
  if (rates.reasoning > 0 && reasoning > 0 && reasoning <= output) {
    outputUsd = (output - reasoning) * rates.completion + reasoning * rates.reasoning;
  } else if (reasoning > output) {
    const reasonRate = rates.reasoning > 0 ? rates.reasoning : rates.completion;
    outputUsd = output * rates.completion + reasoning * reasonRate;
  } else {
    outputUsd = (output > 0 ? output : reasoning) * rates.completion;
  }
  const usd = fresh * rates.prompt + cacheRead * readRate + outputUsd;
  return Number.isFinite(usd) && usd > 0 && usd < 500 ? usd : 0;
}

/**
 * Parse provider / sidecar usage. Prefer native `cost` when present.
 * Reasoning-only blobs (GPT Astra etc.) still count if completion is 0.
 */
export function parseProviderUsage(raw: unknown): OlkilApiUsage | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const u = raw as Record<string, any>;
  const nested = u.usage && typeof u.usage === 'object' ? u.usage : {};
  const tokens = u.tokens && typeof u.tokens === 'object' ? u.tokens : u;
  const details =
    (nested.completion_tokens_details && typeof nested.completion_tokens_details === 'object'
      ? nested.completion_tokens_details
      : u.completion_tokens_details) || {};
  const cache = (tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : u.cache) || {};
  const costUsd = costNum(
    u.total_cost ??
      u.totalCost ??
      u.cost_usd ??
      u.cost ??
      nested.total_cost ??
      nested.cost ??
      nested.cost_usd ??
      tokens.cost,
  );

  let promptTokens = num(
    u.native_tokens_prompt ??
      u.tokens_prompt ??
      u.prompt_tokens ??
      u.promptTokens ??
      nested.prompt_tokens ??
      tokens.input ??
      tokens.prompt ??
      u.input,
  );
  const completionTokens = num(
    u.native_tokens_completion ??
      u.tokens_completion ??
      u.completion_tokens ??
      u.completionTokens ??
      nested.completion_tokens ??
      tokens.output ??
      tokens.completion ??
      u.output,
  );
  const cacheHitTokens = num(
    u.native_tokens_cached ??
      u.prompt_cache_hit_tokens ??
      nested.prompt_tokens_details?.cached_tokens ??
      cache.read,
  );
  let cacheMissTokens = num(u.prompt_cache_miss_tokens ?? cache.write);
  const reasoningTokens = num(
    details.reasoning_tokens ??
      u.native_tokens_reasoning ??
      u.reasoning_tokens ??
      tokens.reasoning ??
      nested.completion_tokens_details?.reasoning_tokens ??
      u.reasoning,
  );

  if (cacheHitTokens > 0 && promptTokens > 0 && promptTokens < cacheHitTokens) {
    promptTokens += cacheHitTokens;
  }
  if (cacheMissTokens < 1 && cacheHitTokens > 0 && promptTokens >= cacheHitTokens) {
    cacheMissTokens = promptTokens - cacheHitTokens;
  } else if (cacheMissTokens < 1 && cacheHitTokens < 1) {
    cacheMissTokens = promptTokens;
  }

  const billedOut = completionTokens > 0 ? completionTokens : reasoningTokens;
  const reportedTotal = num(u.total_tokens ?? u.native_tokens_total ?? u.total ?? nested.total_tokens ?? tokens.total);
  const totalTokens = reportedTotal || promptTokens + billedOut;
  if (totalTokens < 1 && billedOut < 1 && promptTokens < 1 && !(costUsd > 0)) {
    return null;
  }
  return {
    promptTokens,
    completionTokens,
    totalTokens: totalTokens || promptTokens + billedOut,
    cacheHitTokens,
    cacheMissTokens,
    reasoningTokens,
    costUsd: costUsd || undefined,
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
    costUsd: (a.costUsd || 0) + (b.costUsd || 0) || undefined,
  };
}

/** Same turn, different sources — keep the richer numbers. */
export function maxApiUsage(a: OlkilApiUsage | null, b: OlkilApiUsage | null): OlkilApiUsage | null {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return {
    promptTokens: Math.max(a.promptTokens, b.promptTokens),
    completionTokens: Math.max(a.completionTokens, b.completionTokens),
    totalTokens: Math.max(a.totalTokens, b.totalTokens),
    cacheHitTokens: Math.max(a.cacheHitTokens, b.cacheHitTokens),
    cacheMissTokens: Math.max(a.cacheMissTokens, b.cacheMissTokens),
    reasoningTokens: Math.max(a.reasoningTokens, b.reasoningTokens),
    costUsd: Math.max(a.costUsd || 0, b.costUsd || 0) || undefined,
  };
}

export function collectGenerationIds(raw: unknown, into = new Set<string>()): Set<string> {
  const walk = (value: unknown, depth: number) => {
    if (depth > 8 || value == null) {
      return;
    }
    if (typeof value === 'string') {
      if (/^gen[-_][a-z0-9]/i.test(value)) {
        into.add(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item, depth + 1);
      }
      return;
    }
    if (typeof value !== 'object') {
      return;
    }
    const o = value as Record<string, unknown>;
    for (const key of ['generationId', 'generationID', 'generation_id', 'id']) {
      const s = o[key];
      if (typeof s === 'string' && /^gen[-_][a-z0-9]/i.test(s)) {
        into.add(s);
      }
    }
    walk(o.providerMetadata, depth + 1);
    walk(o.metadata, depth + 1);
    walk(o.info, depth + 1);
    walk(o.tokens, depth + 1);
    walk(o.usage, depth + 1);
    walk(o.parts, depth + 1);
    walk(o.part, depth + 1);
  };
  walk(raw, 0);
  return into;
}

/** Sidecar message: `cost` on the parent, counts on `tokens`. */
export function usageFromEngineMessage(row: unknown): OlkilApiUsage | null {
  if (!row || typeof row !== 'object') {
    return null;
  }
  const rec = row as Record<string, any>;
  const info = rec.info && typeof rec.info === 'object' ? rec.info : rec;
  if (info.role && info.role !== 'assistant') {
    return null;
  }
  let found = maxApiUsage(parseProviderUsage(info), parseProviderUsage(info.tokens || info.usage));
  if (info.tokens && typeof info.tokens === 'object') {
    found = maxApiUsage(found, parseProviderUsage({ ...info.tokens, cost: info.cost, total_cost: info.cost }));
  }
  let steps: OlkilApiUsage | null = null;
  for (const part of rec.parts || info.parts || []) {
    if (!part || typeof part !== 'object') {
      continue;
    }
    const t = String(part.type || '');
    if (t !== 'step-finish' && t !== 'step_finish') {
      continue;
    }
    steps = addApiUsage(steps, parseProviderUsage(part) || parseProviderUsage(part.tokens || part.usage));
  }
  if (found && (found.totalTokens > 0 || (found.costUsd || 0) > 0)) {
    return {
      ...found,
      costUsd: Math.max(found.costUsd || 0, steps?.costUsd || 0) || found.costUsd,
    };
  }
  return steps || found;
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
    plan?: string;
    plan_name?: string;
  };
};

type QuotaDecision = {
  at: number;
  allowed: boolean;
  isPaid: boolean;
  message: string;
  reason: string;
  upgradeUrl?: string;
  plan?: string;
};

let quotaCache: QuotaDecision | null = null;

function signInMessage(): string {
  return 'Sign in to OLKIL to use cloud models. Local Ollama still works.';
}

function usedUpMessage(): string {
  return 'Your included cloud usage is used up. Buy Lite, Pro, or Ultra again, or upgrade.';
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
  plan?: string;
  plan_name?: string;
  percent_left?: number;
} | null): QuotaDecision | null {
  if (!sub) {
    return null;
  }
  const plan = String(sub.plan || sub.plan_name || '');
  const spendable = Number(sub.spendable_left ?? 0);
  const percent = Number(sub.percent_left);
  const isPaid = Boolean(sub.is_paid) || isPaidPlanName(plan) || spendable > 0;
  const allowed =
    spendable > 0 &&
    sub.quota_reason !== 'quota_exceeded' &&
    !(Number.isFinite(percent) && percent < 0.05);
  const reason = String(sub.quota_reason || (allowed ? 'ok' : isPaid ? 'quota_exceeded' : 'plan_required'));
  return {
    at: Date.now(),
    allowed,
    isPaid,
    message: allowed ? '' : usedUpMessage(),
    reason,
    upgradeUrl: sub.upgrade_url,
    plan,
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

  if (data && (status === 200 || status === 402 || status === 403)) {
    return decisionFromApiBody(data);
  }

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

  const fallback = await quotaFromEmailFallback();
  if (fallback) {
    return fallback;
  }
  return {
    at: Date.now(),
    allowed: false,
    isPaid: false,
    message: 'Could not verify your OLKIL plan. Check the network, then retry. Local Ollama still works.',
    reason: 'quota_unavailable',
  };
}

function decisionFromApiBody(data: Record<string, unknown>): QuotaDecision {
  const sub = (data.subscription && typeof data.subscription === 'object'
    ? (data.subscription as Record<string, unknown>)
    : data) as QuotaPayload['subscription'] & Record<string, unknown>;
  const spendable = Number(sub?.spendable_left ?? 0);
  const percent = Number(sub?.percent_left);
  const plan = String(sub?.plan || sub?.plan_name || data.plan || '');
  const allowed =
    spendable > 0 &&
    data.reason !== 'quota_exceeded' &&
    !(Number.isFinite(percent) && percent < 0.05);
  const isPaid = Boolean(sub?.is_paid) || isPaidPlanName(plan) || spendable > 0;
  const reason = String(
    data.reason || (allowed ? 'ok' : isPaid ? 'quota_exceeded' : 'plan_required'),
  );
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
    plan,
  };
}

export async function getDeepseekAccess(): Promise<DeepseekAccess> {
  const session = await loadSession();
  const email = session?.user?.email || '';
  const signedIn = Boolean(email);

  const used = signedIn ? await readFreeTokens(email) : 0;
  const remaining = Math.max(0, FREE_DEEPSEEK_TOKENS - used);
  let isPaid = false;
  let cloudLocked = false;
  let message = '';

  const fromEmail = await quotaFromEmailFallback();
  if (fromEmail) {
    applyCache(fromEmail);
    isPaid = fromEmail.isPaid || isPaidPlanName(fromEmail.plan);
    if (!fromEmail.allowed && (isPaid || fromEmail.reason === 'quota_exceeded')) {
      cloudLocked = true;
      message = fromEmail.message || usedUpMessage();
    }
  } else {
    const token = await validIdToken();
    if (token) {
      try {
        const decision = applyCache(await fetchQuotaDecision(token));
        isPaid = decision.isPaid || isPaidPlanName(decision.plan);
        if (!decision.allowed && (isPaid || decision.reason === 'quota_exceeded')) {
          cloudLocked = true;
          message = decision.message || usedUpMessage();
        }
      } catch {
        // keep defaults
      }
    }
  }

  return {
    signedIn,
    isPaid,
    used,
    limit: FREE_DEEPSEEK_TOKENS,
    remaining,
    locked: signedIn && !isPaid && used >= FREE_DEEPSEEK_TOKENS,
    cloudLocked,
    message,
  };
}

export async function assertOlkilWallet(provider: AiProviderId): Promise<void> {
  if (isLocalProvider(provider) || provider === 'poolside' || provider === 'custom') {
    return;
  }

  const access = await getDeepseekAccess();
  if (!access.signedIn) {
    throw new OlkilWalletError(signInMessage(), 'auth_required');
  }

  // Unpaid: local Ollama only. Auto is OpenRouter — never free.
  if (!access.isPaid) {
    if (provider === 'deepseek') {
      if (access.locked) {
        throw new OlkilWalletError(freeTokensExhaustedMessage(), 'free_tokens_exhausted');
      }
      return;
    }
    throw new OlkilWalletError(
      'Cloud Auto models need an OLKIL Lite, Pro, or Ultra plan with remaining credit. Local Ollama still works.',
      'plan_required',
    );
  }

  const fromEmail = await quotaFromEmailFallback();
  if (fromEmail) {
    applyCache(fromEmail);
    if (fromEmail.allowed) {
      return;
    }
    throw new OlkilWalletError(fromEmail.message || usedUpMessage(), fromEmail.reason, fromEmail.upgradeUrl);
  }

  const token = await validIdToken();
  if (!token) {
    throw new OlkilWalletError(signInMessage(), 'auth_required');
  }
  try {
    const decision = applyCache(await fetchQuotaDecision(token));
    if (decision.allowed) {
      return;
    }
    throw new OlkilWalletError(decision.message || usedUpMessage(), decision.reason, decision.upgradeUrl);
  } catch (err) {
    if (err instanceof OlkilWalletError) {
      throw err;
    }
    throw new OlkilWalletError(
      'Could not verify your OLKIL credit. Retry, or use local Ollama.',
      'quota_unavailable',
    );
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
  const usage = opts.usage || null;
  const inputTokens = usage && usage.promptTokens > 0 ? usage.promptTokens : Math.max(0, Math.floor(opts.inputTokens));
  const outputTokens =
    usage && usage.completionTokens > 0
      ? usage.completionTokens
      : usage && usage.reasoningTokens > 0
        ? usage.reasoningTokens
        : Math.max(0, Math.floor(opts.outputTokens));
  const tokens = usage && usage.totalTokens > 0 ? usage.totalTokens : inputTokens + outputTokens;
  await loadOpenRouterRates();
  const costUsd = estimateOlkilCostUsd(opts.model, {
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens: tokens,
    cacheHitTokens: usage?.cacheHitTokens || 0,
    cacheMissTokens: usage?.cacheMissTokens || 0,
    reasoningTokens: usage?.reasoningTokens || 0,
    costUsd: usage?.costUsd,
  });
  if ((!tokens && !(costUsd > 0)) || !isMeteredProvider(opts.provider)) {
    console.warn('[olkil-wallet] skip charge', {
      provider: opts.provider,
      tokens,
      costUsd,
      metered: isMeteredProvider(opts.provider),
      source: usage ? 'api' : 'none',
    });
    return false;
  }

  const access = await getDeepseekAccess();
  if (access.signedIn && !access.isPaid) {
    const session = await loadSession();
    const email = session?.user?.email || '';
    await addFreeTokens(email, tokens);
    console.warn('[olkil-wallet] free DeepSeek tokens', {
      tokens,
      used: access.used + tokens,
      limit: FREE_DEEPSEEK_TOKENS,
    });
    if (quotaCache) {
      return true;
    }
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
      cost_usd: costUsd,
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
    const spendable = Number(sub?.spendable_left ?? 0);
    quotaCache = {
      at: Date.now(),
      allowed: spendable > 0,
      isPaid: Boolean(sub?.is_paid ?? quotaCache?.isPaid) || spendable > 0 || isPaidPlanName(String(sub?.plan || '')),
      message: String(data.message || ''),
      reason: String(data.reason || 'ok'),
      upgradeUrl: typeof data.upgrade_url === 'string' ? data.upgrade_url : undefined,
      plan: String(sub?.plan || sub?.plan_name || quotaCache?.plan || ''),
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
