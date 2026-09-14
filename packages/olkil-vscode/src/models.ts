export interface OlkilCloudModel {
  id: string;
  slug: string;
  label: string;
}

/** Same featured cloud lineup as the OLKIL desktop picker (OpenRouter). */
export const CLOUD_MODELS: OlkilCloudModel[] = [
  { id: 'auto', slug: 'deepseek/deepseek-v4-flash', label: 'Auto' },
  { id: 'x-ai/grok-4.6', slug: 'x-ai/grok-4.6', label: 'Grok 4.6' },
  { id: 'anthropic/claude-sonnet-5', slug: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'openai/gpt-5.6-sol', slug: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'anthropic/claude-opus-5', slug: 'anthropic/claude-opus-5', label: 'Claude Opus 5' },
  { id: 'deepseek/deepseek-v4-flash', slug: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
];

export const DEFAULT_MODEL_ID = 'auto';
export const CUSTOM_MODEL_ID = 'custom';

let extraCloud: OlkilCloudModel[] = [];

export function extraCloudModels(): OlkilCloudModel[] {
  return extraCloud;
}

export function setExtraCloudModels(list: OlkilCloudModel[]) {
  extraCloud = Array.isArray(list) ? list : [];
}

export async function fetchOpenRouterCatalog(): Promise<OlkilCloudModel[]> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'HTTP-Referer': 'https://olkil.com', 'X-Title': 'OLKIL' },
    });
    if (!res.ok) return extraCloud;
    const json = (await res.json()) as { data?: Array<Record<string, any>> };
    const rows = Array.isArray(json?.data) ? json.data : [];
    const featured = new Set(CLOUD_MODELS.map((m) => m.slug));
    const next: OlkilCloudModel[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const slug = String(row?.id || '').trim();
      if (!slug || featured.has(slug) || seen.has(slug)) continue;
      if (slug.includes(':batch') || slug.startsWith('~') || slug === 'openrouter/auto') continue;
      const name = String(row?.name || slug).trim();
      const arch = row?.architecture && typeof row.architecture === 'object' ? row.architecture : {};
      const output = String(arch.output_modalities || arch.modality || 'text');
      if (/\bimage\b/i.test(output) && !/\btext\b/i.test(output)) continue;
      if (/\bdazzlone\b|\blaguna\b|\bpoolside\b/i.test(slug + ' ' + name)) continue;
      seen.add(slug);
      next.push({
        id: slug,
        slug,
        label: name.replace(/^[^:]+:\s*/, '') || slug,
      });
      if (next.length >= 280) break;
    }
    extraCloud = next;
  } catch {
    /* keep last */
  }
  return extraCloud;
}

export interface CustomEndpoint {
  id: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

export const ADD_CUSTOM_MODEL_ID = 'custom';
export const CUSTOM_MODEL_PREFIX = 'custom:';

export function newCustomId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function customPickerId(id: string): string {
  return CUSTOM_MODEL_PREFIX + id;
}

export function customIdFromModelId(modelId: string | undefined): string | null {
  const s = String(modelId || '').trim();
  if (s.startsWith(CUSTOM_MODEL_PREFIX)) return s.slice(CUSTOM_MODEL_PREFIX.length);
  return null;
}

export function customProviderId(id: string): string {
  const slug = String(id || 'x')
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 16) || 'x';
  return 'c' + slug;
}

export function pickerModels(customs: Array<{ id: string; model: string }> = []): OlkilCloudModel[] {
  const seen = new Set(CLOUD_MODELS.map((m) => m.slug));
  const extras = extraCloud.filter((m) => m.slug && !seen.has(m.slug));
  const saved = customs
    .filter((c) => c.id && c.model)
    .map((c) => ({
      id: customPickerId(c.id),
      slug: customPickerId(c.id),
      label: c.model,
    }));
  return [
    ...CLOUD_MODELS,
    ...extras,
    ...saved,
    { id: ADD_CUSTOM_MODEL_ID, slug: ADD_CUSTOM_MODEL_ID, label: 'Add custom…' },
  ];
}

export function isAddCustomModel(modelId: string | undefined): boolean {
  return String(modelId || '').trim() === ADD_CUSTOM_MODEL_ID;
}

export function isCustomModel(modelId: string | undefined): boolean {
  const s = String(modelId || '').trim();
  return s === ADD_CUSTOM_MODEL_ID || s.startsWith(CUSTOM_MODEL_PREFIX);
}

export function customEndpointReady(ep: CustomEndpoint | null | undefined): boolean {
  return Boolean(ep?.model?.trim() && ep?.baseUrl?.trim() && ep?.apiKey?.trim());
}

export function normalizeOpenAiBaseUrl(raw: string): string {
  let url = String(raw || '').trim().replace(/\s+/g, '').replace(/\/+$/, '');
  url = url.replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
  if (!url) return '';
  if (!/\/v\d+[a-z]*(\/|$)/i.test(url)) url = url + '/v1';
  return url;
}

export function resolveCloudSlug(modelId: string | undefined): string {
  const id = String(modelId || DEFAULT_MODEL_ID).trim();
  if (id === CUSTOM_MODEL_ID || id.startsWith(CUSTOM_MODEL_PREFIX)) return id;
  const hit = CLOUD_MODELS.find((m) => m.id === id || m.slug === id) || extraCloud.find((m) => m.id === id || m.slug === id);
  if (hit) return hit.slug;
  if (id.includes('/')) return id;
  return 'deepseek/deepseek-v4-flash';
}
