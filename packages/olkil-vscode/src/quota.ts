import { authOrigin, type OlkilSession } from './auth';

export interface OlkilQuota {
  plan: string;
  planName: string;
  leftLabel: string;
  spendable: number;
  percentUsed: number;
  percentLeft: number;
  isPaid: boolean;
  allowed: boolean;
  upgradeUrl: string;
}

export const PAID_PLANS = [
  {
    id: 'lite',
    name: 'Lite',
    price: '$3',
    period: '/ mo',
    blurb: 'Cloud agent and frontier models',
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$10',
    period: '/ mo',
    blurb: 'Extended Agent limits',
    featured: true,
  },
  {
    id: 'ultra',
    name: 'Ultra',
    price: '$49',
    period: '/ mo',
    blurb: 'Parallel agents and priority',
  },
] as const;

export function isPaidPlanSlug(plan: string): boolean {
  return /\b(lite|pro|ultra)\b/i.test(String(plan || ''));
}

export function canUseVscodeAgent(quota: OlkilQuota | null): boolean {
  if (!quota) return false;
  const paid = quota.isPaid || isPaidPlanSlug(quota.plan) || isPaidPlanSlug(quota.planName);
  if (!paid) return false;
  if (quota.allowed === false) return false;
  return true;
}

export async function fetchQuota(session: OlkilSession): Promise<OlkilQuota> {
  const res = await fetch(authOrigin() + '/wp-json/olkil-payu/v1/quota', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + session.idToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id_token: session.idToken,
      email: session.user?.email || '',
    }),
  });
  const json = (await res.json().catch(() => null)) as Record<string, any> | null;
  if (!res.ok || !json) {
    throw new Error('Plan check failed (HTTP ' + res.status + ').');
  }
  const sub = json.subscription || json;
  const plan = String(sub.plan || json.next_plan || '');
  const planName = String(sub.plan_name || sub.plan || 'Free');
  const spendable = Number(sub.spendable_left ?? sub.tokens_left ?? 0);
  const percent = Number(sub.percent_left);
  const isPaid = Boolean(sub.is_paid) || isPaidPlanSlug(plan) || isPaidPlanSlug(planName);
  const allowed =
    spendable > 0 &&
    json.reason !== 'quota_exceeded' &&
    sub.quota_reason !== 'quota_exceeded' &&
    !(Number.isFinite(percent) && percent < 0.05);
  return {
    plan,
    planName,
    leftLabel: String(sub.spendable_left_label || sub.tokens_left_label || ''),
    spendable,
    percentUsed: Number.isFinite(Number(sub.percent_used)) ? Number(sub.percent_used) : 0,
    percentLeft: Number.isFinite(percent) ? percent : 100,
    isPaid,
    allowed,
    upgradeUrl: String(json.upgrade_url || sub.upgrade_url || 'https://olkil.com/pricing/'),
  };
}

function numDeep(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === 'string' && value.trim()) {
    const x = Number(value);
    return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0;
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return numDeep(o.tokens ?? o.total ?? o.count ?? o.input ?? o.output);
  }
  return 0;
}

function costNum(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(String(value || '').trim());
  return Number.isFinite(n) && n > 0 && n < 25 ? n : 0;
}

export function estimateCostUsd(
  model: string | undefined,
  prompt: number,
  completion: number,
  cacheHit = 0,
): number {
  const slug = String(model || '')
    .replace(/^openrouter:/i, '')
    .toLowerCase();
  const table: Record<string, [number, number, number]> = {
    'deepseek/deepseek-v4-flash': [0.09, 0.18, 0.018],
    'deepseek-v4-flash': [0.09, 0.18, 0.018],
    'x-ai/grok-4.6': [2, 6, 0.5],
    'anthropic/claude-sonnet-5': [2, 10, 0.2],
    'anthropic/claude-opus-5': [5, 25, 0.5],
    'openai/gpt-5.6-sol': [2, 10, 0.2],
    'openai/gpt-5.6-luna': [0.2, 1.2, 0.02],
  };
  const rates =
    table[slug] ||
    Object.entries(table).find(([id]) => slug && (id.includes(slug) || slug.includes(id)))?.[1] ||
    [2, 10, 0.2];
  const hit = Math.max(0, cacheHit);
  const miss = Math.max(0, prompt - hit);
  const usd = (miss / 1_000_000) * rates[0] + (hit / 1_000_000) * rates[2] + (Math.max(0, completion) / 1_000_000) * rates[1];
  return Math.min(8, Math.max(0, usd));
}

export type ParsedUsage = {
  prompt: number;
  completion: number;
  total: number;
  costUsd: number;
  cacheHit: number;
  cacheMiss: number;
  reasoning: number;
};

export function parseUsageBlob(raw: unknown): ParsedUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, any>;
  const nested = u.usage && typeof u.usage === 'object' ? u.usage : {};
  const tokens = u.tokens && typeof u.tokens === 'object' ? u.tokens : u;
  const details =
    (nested.completion_tokens_details && typeof nested.completion_tokens_details === 'object'
      ? nested.completion_tokens_details
      : u.completion_tokens_details) || {};
  const cache = (tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : u.cache) || {};
  const prompt = numDeep(
    u.native_tokens_prompt ??
      u.tokens_prompt ??
      u.prompt_tokens ??
      u.promptTokens ??
      nested.prompt_tokens ??
      tokens.input ??
      tokens.prompt ??
      u.input,
  );
  const completion = numDeep(
    u.native_tokens_completion ??
      u.tokens_completion ??
      u.completion_tokens ??
      u.completionTokens ??
      nested.completion_tokens ??
      tokens.output ??
      tokens.completion ??
      u.output,
  );
  const cacheHit = numDeep(
    u.native_tokens_cached ??
      u.prompt_cache_hit_tokens ??
      cache.read ??
      nested.prompt_tokens_details?.cached_tokens,
  );
  const cacheMiss = numDeep(u.prompt_cache_miss_tokens ?? cache.write);
  const reasoning = numDeep(
    u.native_tokens_reasoning ??
      u.reasoning_tokens ??
      tokens.reasoning ??
      details.reasoning_tokens ??
      nested.completion_tokens_details?.reasoning_tokens,
  );
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
  const reported = numDeep(u.total_tokens ?? u.native_tokens_total ?? u.total ?? nested.total_tokens ?? tokens.total);
  const billedOut = completion > 0 ? completion : reasoning;
  const total = reported || prompt + billedOut;
  if (total < 1 && prompt < 1 && billedOut < 1 && !(costUsd > 0)) return null;
  return {
    prompt,
    completion,
    total: total || prompt + billedOut,
    costUsd,
    cacheHit,
    cacheMiss,
    reasoning,
  };
}

/** Same turn, different sources — keep the richer numbers, never double-count steps. */
export function maxUsage(a: ParsedUsage | null, b: ParsedUsage | null): ParsedUsage | null {
  if (!a) return b;
  if (!b) return a;
  return {
    prompt: Math.max(a.prompt, b.prompt),
    completion: Math.max(a.completion, b.completion),
    total: Math.max(a.total, b.total),
    costUsd: Math.max(a.costUsd, b.costUsd),
    cacheHit: Math.max(a.cacheHit, b.cacheHit),
    cacheMiss: Math.max(a.cacheMiss, b.cacheMiss),
    reasoning: Math.max(a.reasoning, b.reasoning),
  };
}

export function addUsage(a: ParsedUsage | null, b: ParsedUsage | null): ParsedUsage | null {
  if (!a) return b;
  if (!b) return a;
  return {
    prompt: a.prompt + b.prompt,
    completion: a.completion + b.completion,
    total: a.total + b.total,
    costUsd: a.costUsd + b.costUsd,
    cacheHit: a.cacheHit + b.cacheHit,
    cacheMiss: a.cacheMiss + b.cacheMiss,
    reasoning: a.reasoning + b.reasoning,
  };
}

export interface EngineCreds {
  provider: 'openrouter' | 'deepseek';
  baseURL: string;
  apiKey: string;
  model: string;
}

export function collectGenerationIds(raw: unknown, into = new Set<string>()): Set<string> {
  const walk = (value: unknown, depth: number) => {
    if (depth > 8 || value == null) return;
    if (typeof value === 'string') {
      if (/^gen[-_][a-z0-9]/i.test(value)) into.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;
    const o = value as Record<string, unknown>;
    for (const key of ['generationId', 'generationID', 'generation_id', 'id']) {
      const s = o[key];
      if (typeof s === 'string' && /^gen[-_][a-z0-9]/i.test(s)) into.add(s);
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

/** Message `cost` lives on the parent; token counts live on `tokens`. Parse both. */
export function usageFromEngineMessage(row: unknown): ParsedUsage | null {
  if (!row || typeof row !== 'object') return null;
  const rec = row as Record<string, any>;
  const info = rec.info && typeof rec.info === 'object' ? rec.info : rec;
  if (info.role && info.role !== 'assistant') return null;
  let found = maxUsage(parseUsageBlob(info), parseUsageBlob(info.tokens || info.usage));
  if (info.tokens && typeof info.tokens === 'object') {
    found = maxUsage(found, parseUsageBlob({ ...info.tokens, cost: info.cost, total_cost: info.cost }));
  }
  for (const part of rec.parts || info.parts || []) {
    if (!part || typeof part !== 'object') continue;
    const t = String(part.type || '');
    if (t === 'step-finish' || t === 'step_finish') {
      found = maxUsage(found, parseUsageBlob(part));
      found = maxUsage(found, parseUsageBlob(part.tokens || part.usage));
    }
  }
  return found;
}

export async function fetchOpenRouterGenerationUsage(
  creds: EngineCreds | null,
  ids: Iterable<string>,
): Promise<ParsedUsage | null> {
  if (!creds || creds.provider !== 'openrouter' || !creds.apiKey) return null;
  const unique = [...new Set([...ids].map((id) => String(id || '').trim()).filter(Boolean))];
  if (!unique.length) return null;
  const base = String(creds.baseURL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  let found: ParsedUsage | null = null;
  for (const id of unique) {
    for (let i = 0; i < 4; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 400 * i));
      try {
        const res = await fetch(base + '/generation?id=' + encodeURIComponent(id), {
          headers: {
            Authorization: 'Bearer ' + creds.apiKey,
            'HTTP-Referer': 'https://olkil.com',
            'X-Title': 'OLKIL',
          },
        });
        if (!res.ok) continue;
        const json = (await res.json().catch(() => null)) as Record<string, any> | null;
        const data = json?.data && typeof json.data === 'object' ? json.data : json;
        const usage = parseUsageBlob(data);
        if (usage && (usage.costUsd > 0 || usage.total > 0)) {
          found = maxUsage(found, usage);
          break;
        }
      } catch {
        /* retry */
      }
    }
  }
  return found;
}

function credsFromJson(json: Record<string, any> | null): EngineCreds | null {
  if (!json) return null;
  const apiKey = String(json.apiKey || json.key || '').trim();
  if (!apiKey) return null;
  const provider = json.provider === 'openrouter' ? 'openrouter' : 'deepseek';
  return {
    provider,
    baseURL:
      String(json.baseURL || '').trim() ||
      (provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://api.deepseek.com/v1'),
    apiKey,
    model:
      String(json.model || '').trim() ||
      (provider === 'openrouter' ? 'deepseek/deepseek-v4-flash' : 'deepseek-v4-flash'),
  };
}

const FIREBASE_ENGINE_URLS = [
  'https://asia-south1-olkil-2c8ac.cloudfunctions.net/olkilPayuApi/v1/engine',
  'https://olkilpayuapi-2k3jxx4n5q-el.a.run.app/v1/engine',
];

export async function hydrateEngineKey(session: OlkilSession): Promise<EngineCreds | null> {
  const headers = {
    Authorization: 'Bearer ' + session.idToken,
    'Content-Type': 'application/json',
  };
  const body = JSON.stringify({
    id_token: session.idToken,
    email: session.user?.email || '',
  });
  for (const url of FIREBASE_ENGINE_URLS) {
    try {
      const res = await fetch(url, { method: 'POST', headers, body });
      if (!res.ok) continue;
      const creds = credsFromJson((await res.json().catch(() => null)) as Record<string, any> | null);
      if (creds) return creds;
    } catch {
      /* try next */
    }
  }
  try {
    const res = await fetch(authOrigin() + '/wp-json/olkil-payu/v1/engine', {
      method: 'POST',
      headers,
      body,
    });
    const creds = credsFromJson((await res.json().catch(() => null)) as Record<string, any> | null);
    if (creds) return creds;
  } catch {
    /* ignore */
  }
  return null;
}

export async function chargeUsage(
  session: OlkilSession,
  usage: {
    prompt: number;
    completion: number;
    total: number;
    model?: string;
    provider?: string;
    requestId?: string;
    costUsd?: number;
    cacheHit?: number;
    cacheMiss?: number;
    reasoning?: number;
  },
): Promise<OlkilQuota | null> {
  try {
    const res = await fetch(authOrigin() + '/wp-json/olkil-payu/v1/usage', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + session.idToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id_token: session.idToken,
        email: session.user?.email || '',
        tokens: usage.total,
        input_tokens: usage.prompt,
        output_tokens: usage.completion,
        cost_usd:
          usage.costUsd && usage.costUsd > 0
            ? usage.costUsd
            : estimateCostUsd(
                usage.model,
                usage.prompt,
                usage.completion > 0 ? usage.completion : usage.reasoning || 0,
                usage.cacheHit || 0,
              ),
        prompt_cache_hit_tokens: usage.cacheHit || 0,
        prompt_cache_miss_tokens: usage.cacheMiss || 0,
        reasoning_tokens: usage.reasoning || 0,
        model: usage.model || 'deepseek/deepseek-v4-flash',
        provider: usage.provider || 'openrouter',
        request_id: usage.requestId || `vscode-${Date.now()}`,
        surface: 'vscode',
      }),
    });
    const json = (await res.json().catch(() => null)) as Record<string, any> | null;
    const sub = json && (json.subscription || json);
    if (!sub) {
      return null;
    }
    const plan = String(sub.plan || '');
    const planName = String(sub.plan_name || sub.plan || 'Free');
    return {
      plan,
      planName,
      leftLabel: String(sub.spendable_left_label || sub.tokens_left_label || ''),
      spendable: Number(sub.spendable_left ?? sub.tokens_left ?? 0),
      percentUsed: Number(sub.percent_used || 0),
      percentLeft: Number(sub.percent_left || 0),
      isPaid: Boolean(sub.is_paid) || isPaidPlanSlug(plan) || isPaidPlanSlug(planName),
      allowed: json.ok !== false && json.reason !== 'quota_exceeded' && Number(sub.spendable_left ?? sub.tokens_left ?? 0) > 0,
      upgradeUrl: String(json.upgrade_url || sub.upgrade_url || 'https://olkil.com/pricing/'),
    };
  } catch {
    return null;
  }
}
