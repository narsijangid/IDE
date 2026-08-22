export type AiProviderId = 'ollama' | 'poolside' | 'deepseek';

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

export function findModel(id: string): AiModelOption {
  return AI_MODELS.find((m) => m.id === id) || AI_MODELS[0];
}

/** Name the product should use when referring to itself in chat. */
export function publicModelName(option: AiModelOption): string {
  return option.publicName || option.displayName || option.label;
}
