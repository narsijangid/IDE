import { AUTO_MODEL_ID } from './auto-router';

export type AiProviderId = 'ollama' | 'poolside' | 'deepseek' | 'openrouter' | 'custom';

/** Poolside/Dazzlone is retired from the picker — never show it as a selectable model. */
export function isRetiredOlkilModel(model: {
  id?: string;
  provider?: string;
  publicName?: string;
  displayName?: string;
  label?: string;
  model?: string;
}): boolean {
  if ((model.provider || '').toLowerCase() === 'poolside') {
    return true;
  }
  const blob = `${model.id || ''} ${model.publicName || ''} ${model.displayName || ''} ${model.label || ''} ${model.model || ''}`.toLowerCase();
  return blob.startsWith('poolside:') || /\bpoolside:/.test(blob) || /\bdazzlone\b/.test(blob) || /\blaguna\b/.test(blob);
}

export interface AiModelOption {
  /** Unique UI id, e.g. ollama:qwen2.5-coder:7b */
  id: string;
  provider: AiProviderId;
  /** Provider-native model name (API) */
  model: string;
  /** Plain fallback label */
  label: string;
  /** UI primary name (e.g. Dazzlone) */
  displayName?: string;
  /** UI badge after the name (e.g. FREE) — rendered in accent green */
  badge?: string;
  /** Public identity when user asks "which model are you?" */
  publicName?: string;
  /** Approximate download size for Ollama models (shown before pull). */
  approxSizeGb?: number;
  /** Cursor-style picker grouping */
  group?: 'auto' | 'featured' | 'local' | 'more';
}

/** User-added OpenAI-compatible endpoint (BYOK). Secrets stay on the run payload. */
export interface CustomModelEndpoint {
  id: string;
  label: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

let customCatalog: AiModelOption[] = [];
const customSecrets = new Map<string, { baseUrl: string; apiKey: string }>();
/** Live OpenRouter catalog (not in the static featured list). */
let openRouterExtra: AiModelOption[] = [];

function orModel(slug: string, displayName: string): AiModelOption {
  return {
    id: `openrouter:${slug}`,
    provider: 'openrouter',
    model: slug,
    label: displayName,
    displayName,
    publicName: displayName,
    group: 'featured',
  };
}

/**
 * Default picker: Auto + Grok / Claude / GPT Sol / Opus / DeepSeek Flash + local.
 */
export const AI_MODELS: AiModelOption[] = [
  {
    id: AUTO_MODEL_ID,
    provider: 'openrouter',
    model: 'auto',
    label: 'Auto',
    displayName: 'Auto',
    publicName: 'OLKIL Auto',
    group: 'auto',
  },
  orModel('x-ai/grok-4.6', 'Grok 4.6'),
  orModel('anthropic/claude-sonnet-5', 'Claude Sonnet 5'),
  orModel('openai/gpt-5.6-sol', 'GPT-5.6 Sol'),
  orModel('anthropic/claude-opus-5', 'Claude Opus 5'),
  orModel('deepseek/deepseek-v4-flash', 'DeepSeek V4 Flash'),
  {
    id: 'ollama:qwen2.5-coder:7b',
    provider: 'ollama',
    model: 'qwen2.5-coder:7b',
    label: 'Qwen2.5 Coder 7B (local)',
    displayName: 'Qwen2.5 Coder 7B',
    badge: 'LOCAL',
    publicName: 'Qwen2.5 Coder 7B',
    approxSizeGb: 4.7,
    group: 'local',
  },
  {
    id: 'ollama:llama3.2',
    provider: 'ollama',
    model: 'llama3.2',
    label: 'Llama 3.2 (local)',
    displayName: 'Llama 3.2',
    badge: 'LOCAL',
    publicName: 'Llama 3.2',
    approxSizeGb: 2.0,
    group: 'local',
  },
  {
    id: 'ollama:llama3.1',
    provider: 'ollama',
    model: 'llama3.1',
    label: 'Llama 3.1 (local)',
    displayName: 'Llama 3.1',
    badge: 'LOCAL',
    publicName: 'Llama 3.1',
    approxSizeGb: 4.7,
    group: 'local',
  },
  {
    id: 'ollama:mistral',
    provider: 'ollama',
    model: 'mistral',
    label: 'Mistral (local)',
    displayName: 'Mistral',
    badge: 'LOCAL',
    publicName: 'Mistral',
    approxSizeGb: 4.1,
    group: 'local',
  },
];

/** Default = Auto (Cursor-style router over OpenRouter). */
export const DEFAULT_MODEL_ID = AUTO_MODEL_ID;

export function customModelCatalogId(id: string): string {
  const raw = String(id || '').trim();
  if (!raw) {
    return '';
  }
  return raw.startsWith('custom:') ? raw : `custom:${raw}`;
}

export function isCustomProvider(provider: string | undefined): boolean {
  return provider === 'custom';
}

export function isOpenRouterProvider(provider?: string): boolean {
  return (provider || '').toLowerCase() === 'openrouter';
}

export function isMeteredCloudProvider(provider?: string): boolean {
  const p = (provider || '').toLowerCase();
  return p === 'deepseek' || p === 'openrouter';
}

export function openrouterCatalogId(modelOrId: string): string {
  const raw = String(modelOrId || '').trim();
  if (!raw) {
    return '';
  }
  return raw.startsWith('openrouter:') ? raw : `openrouter:${raw}`;
}

export function applyOpenRouterExtraModels(models: AiModelOption[] | undefined): AiModelOption[] {
  const featured = new Set(AI_MODELS.map((m) => m.id));
  const next: AiModelOption[] = [];
  const seen = new Set<string>();
  for (const m of models || []) {
    const id = openrouterCatalogId(m.id || m.model);
    if (!id || featured.has(id) || seen.has(id) || id === AUTO_MODEL_ID || isRetiredOlkilModel({ ...m, id })) {
      continue;
    }
    seen.add(id);
    next.push({
      ...m,
      id,
      provider: 'openrouter',
      model: String(m.model || id.replace(/^openrouter:/, '')).trim(),
      label: m.label || m.displayName || m.model,
      displayName: m.displayName || m.label || m.model,
      badge: m.badge && !/openrouter|premium|cloud/i.test(m.badge) ? m.badge : undefined,
      publicName: m.publicName || m.displayName || m.label,
      group: 'more',
    });
  }
  openRouterExtra = next;
  return next;
}

export function openRouterExtraModels(): AiModelOption[] {
  return openRouterExtra;
}

/**
 * Register user-added models for this process (browser UI + node runtime).
 * Browser and node are separate — call from both sides with the same payload.
 */
export function applyCustomModelEndpoints(endpoints: CustomModelEndpoint[] | undefined): AiModelOption[] {
  const next: AiModelOption[] = [];
  customSecrets.clear();
  for (const ep of endpoints || []) {
    const id = customModelCatalogId(ep?.id);
    const model = String(ep?.model || '').trim();
    const baseUrl = normalizeOpenAiBaseUrl(ep?.baseUrl || '');
    if (!id || !model || !baseUrl) {
      continue;
    }
    const label = String(ep.label || model).trim() || model;
    const option: AiModelOption = {
      id,
      provider: 'custom',
      model,
      label,
      displayName: label,
      badge: 'CUSTOM',
      publicName: label,
      group: 'more',
    };
    next.push(option);
    customSecrets.set(id, { baseUrl, apiKey: String(ep.apiKey || '').trim() });
  }
  customCatalog = next;
  return next;
}

export function customEndpointFor(modelId: string): { baseUrl: string; apiKey: string } | undefined {
  return customSecrets.get(customModelCatalogId(modelId));
}

export function findModel(id: string): AiModelOption {
  const key = String(id || '').trim();
  return (
    AI_MODELS.find((m) => m.id === key) ||
    openRouterExtra.find((m) => m.id === key) ||
    customCatalog.find((m) => m.id === key) ||
    synthesizeOpenRouter(key) ||
    AI_MODELS[0]
  );
}

function synthesizeOpenRouter(id: string): AiModelOption | undefined {
  if (!id.startsWith('openrouter:')) {
    return undefined;
  }
  const slug = id.slice('openrouter:'.length).trim();
  if (!slug || slug === 'auto') {
    return undefined;
  }
  const name = slug.split('/').pop() || slug;
  return {
    id,
    provider: 'openrouter',
    model: slug,
    label: name,
    displayName: name,
    badge: undefined,
    publicName: name,
    group: 'more',
  };
}

/** Name the product should use when referring to itself in chat. */
export function publicModelName(option: AiModelOption): string {
  return option.publicName || option.displayName || option.label;
}

/**
 * OpenAI-compatible SDK baseURL: host + version prefix, no /chat/completions.
 * Keeps paths that already include /v1 (OpenRouter, Groq, Gemini OpenAI compat).
 */
export function normalizeOpenAiBaseUrl(raw: string): string {
  let url = String(raw || '').trim();
  if (!url) {
    return '';
  }
  url = url.replace(/\s+/g, '');
  url = url.replace(/\/+$/, '');
  url = url.replace(/\/chat\/completions$/i, '');
  url = url.replace(/\/+$/, '');
  if (!url) {
    return '';
  }
  if (!/\/v\d+[a-z]*(\/|$)/i.test(url)) {
    url = `${url}/v1`;
  }
  return url;
}

export function opencodeCustomProviderId(modelId: string): string {
  const slug = customModelCatalogId(modelId)
    .replace(/^custom:/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `c-${slug || 'model'}`;
}
