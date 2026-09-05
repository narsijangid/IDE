export type AiProviderId = 'ollama' | 'poolside' | 'deepseek' | 'custom';

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

/**
 * Cloud (DeepSeek / Dazzlone) + local Ollama models.
 * Pull Ollama models with: `ollama pull <model>`
 */
export const AI_MODELS: AiModelOption[] = [
  {
    id: 'deepseek:deepseek-v4-flash',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    displayName: 'DeepSeek V4 Flash',
    badge: 'CLOUD',
    publicName: 'DeepSeek V4 Flash',
  },
  {
    id: 'deepseek:deepseek-v4-pro',
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    displayName: 'DeepSeek V4 Pro',
    badge: 'CLOUD',
    publicName: 'DeepSeek V4 Pro',
  },
  {
    id: 'poolside:poolside/laguna-s-2.1',
    provider: 'poolside',
    model: 'poolside/laguna-s-2.1',
    label: 'Dazzlone (FREE)',
    displayName: 'Dazzlone',
    badge: 'FREE',
    publicName: 'Dazzlone',
  },
  {
    id: 'ollama:qwen2.5-coder:7b',
    provider: 'ollama',
    model: 'qwen2.5-coder:7b',
    label: 'Ollama · Qwen2.5 Coder 7B (local)',
    displayName: 'Qwen2.5 Coder 7B',
    badge: 'LOCAL',
    publicName: 'Qwen2.5 Coder 7B (Ollama)',
    approxSizeGb: 4.7,
  },
  {
    id: 'ollama:llama3.2',
    provider: 'ollama',
    model: 'llama3.2',
    label: 'Ollama · Llama 3.2 (local, light)',
    displayName: 'Llama 3.2',
    badge: 'LOCAL',
    publicName: 'Llama 3.2 (Ollama)',
    approxSizeGb: 2.0,
  },
  {
    id: 'ollama:llama3.1',
    provider: 'ollama',
    model: 'llama3.1',
    label: 'Ollama · Llama 3.1 (local)',
    displayName: 'Llama 3.1',
    badge: 'LOCAL',
    publicName: 'Llama 3.1 (Ollama)',
    approxSizeGb: 4.7,
  },
  {
    id: 'ollama:mistral',
    provider: 'ollama',
    model: 'mistral',
    label: 'Ollama · Mistral (local)',
    displayName: 'Mistral',
    badge: 'LOCAL',
    publicName: 'Mistral (Ollama)',
    approxSizeGb: 4.1,
  },
];

/** Default = DeepSeek V4 Flash (fast, low-cost cloud) */
export const DEFAULT_MODEL_ID = 'deepseek:deepseek-v4-flash';

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
  return AI_MODELS.find((m) => m.id === id) || customCatalog.find((m) => m.id === id) || AI_MODELS[0];
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
