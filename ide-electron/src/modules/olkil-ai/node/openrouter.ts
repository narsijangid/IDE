import fetch from 'node-fetch';
import { applyOpenRouterExtraModels, type AiModelOption } from '../common/models';
import { parseProviderUsage, type OlkilApiUsage } from './olkil-wallet.service';

export const DEFAULT_OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

export function openRouterHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://olkil.com',
    'X-Title': 'OLKIL',
  };
}

export function normalizeOpenRouterBase(raw?: string): string {
  const url = String(raw || DEFAULT_OPENROUTER_BASE).trim().replace(/\/+$/, '');
  return url || DEFAULT_OPENROUTER_BASE;
}

let catalogAt = 0;
let catalog: AiModelOption[] = [];

export async function refreshOpenRouterCatalog(apiKey: string, baseUrl?: string): Promise<AiModelOption[]> {
  if (catalog.length && Date.now() - catalogAt < 30 * 60 * 1000) {
    applyOpenRouterExtraModels(catalog);
    return catalog;
  }
  if (!apiKey) {
    return catalog;
  }
  try {
    const base = normalizeOpenRouterBase(baseUrl);
    const res = await fetch(`${base}/models`, {
      headers: openRouterHeaders(apiKey),
    });
    if (!res.ok) {
      return catalog;
    }
    const json = (await res.json()) as { data?: Array<Record<string, any>> };
    const rows = Array.isArray(json?.data) ? json.data : [];
    const next: AiModelOption[] = [];
    for (const row of rows) {
      const slug = String(row?.id || '').trim();
      if (!slug || slug.includes(':batch') || slug.startsWith('~') || slug === 'openrouter/auto') {
        continue;
      }
      const name = String(row?.name || slug).trim();
      const arch = row?.architecture && typeof row.architecture === 'object' ? row.architecture : {};
      const output = String(arch.output_modalities || arch.modality || 'text');
      if (/\bimage\b/i.test(output) && !/\btext\b/i.test(output)) {
        continue;
      }
      next.push({
        id: `openrouter:${slug}`,
        provider: 'openrouter',
        model: slug,
        label: name,
        displayName: name.replace(/^[^:]+:\s*/, ''),
        badge: /:free$/i.test(slug) || Number(row?.pricing?.prompt) === 0 ? 'FREE' : undefined,
        publicName: name.replace(/^[^:]+:\s*/, ''),
        group: 'more',
      });
      if (next.length >= 280) {
        break;
      }
    }
    catalog = next;
    catalogAt = Date.now();
    applyOpenRouterExtraModels(catalog);
  } catch {
    // keep last catalog
  }
  return catalog;
}

/**
 * Prefer OpenRouter generation native token counts over the streaming estimate.
 * Generation stats can lag a moment after the SSE stream ends.
 */
export async function actualOpenRouterUsage(opts: {
  apiKey: string;
  baseUrl?: string;
  generationId?: string;
  fallback?: unknown;
}): Promise<OlkilApiUsage | null> {
  const fallback = parseProviderUsage(opts.fallback);
  const id = String(opts.generationId || '').trim();
  if (!id || !opts.apiKey) {
    return fallback;
  }
  const base = normalizeOpenRouterBase(opts.baseUrl);
  for (let i = 0; i < 4; i++) {
    if (i > 0) {
      await new Promise((r) => setTimeout(r, 350 * i));
    }
    try {
      const res = await fetch(`${base}/generation?id=${encodeURIComponent(id)}`, {
        headers: openRouterHeaders(opts.apiKey),
      });
      if (!res.ok) {
        continue;
      }
      const json = (await res.json()) as { data?: Record<string, unknown> };
      const data = json?.data && typeof json.data === 'object' ? json.data : json;
      const usage = parseProviderUsage(data);
      if (usage) {
        return usage;
      }
    } catch {
      // retry
    }
  }
  return fallback;
}
