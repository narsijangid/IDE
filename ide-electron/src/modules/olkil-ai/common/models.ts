export type AiProviderId = 'openrouter' | 'nvidia' | 'sarvam';

export interface AiModelOption {
  /** Unique UI id, e.g. openrouter:openai/gpt-4o-mini */
  id: string;
  provider: AiProviderId;
  /** Provider-native model name */
  model: string;
  label: string;
}

export const AI_MODELS: AiModelOption[] = [
  {
    id: 'sarvam:sarvam-30b',
    provider: 'sarvam',
    model: 'sarvam-30b',
    label: 'Sarvam · Sarvam-30B',
  },
  {
    id: 'sarvam:sarvam-105b',
    provider: 'sarvam',
    model: 'sarvam-105b',
    label: 'Sarvam · Sarvam-105B',
  },
  {
    id: 'openrouter:openai/gpt-4o-mini',
    provider: 'openrouter',
    model: 'openai/gpt-4o-mini',
    label: 'OpenRouter · GPT-4o Mini',
  },
  {
    id: 'openrouter:openai/gpt-4o',
    provider: 'openrouter',
    model: 'openai/gpt-4o',
    label: 'OpenRouter · GPT-4o',
  },
  {
    id: 'openrouter:google/gemini-2.0-flash-001',
    provider: 'openrouter',
    model: 'google/gemini-2.0-flash-001',
    label: 'OpenRouter · Gemini 2.0 Flash',
  },
  {
    id: 'nvidia:meta/llama-3.1-70b-instruct (optimized) (optimized)',
    provider: 'nvidia',
    model: 'meta/llama-3.1-70b-instruct',
    label: 'NVIDIA · Llama 3.1 70B',
  },
  {
    id: 'nvidia:nvidia/llama-3.1-nemotron-70b-instruct (optimized) (optimized)',
    provider: 'nvidia',
    model: 'nvidia/llama-3.1-nemotron-70b-instruct',
    label: 'NVIDIA · Nemotron 70B',
  },
  {
    id: 'nvidia:meta/llama-3.3-70b-instruct (optimized) (optimized)',
    provider: 'nvidia',
    model: 'meta/llama-3.3-70b-instruct',
    label: 'NVIDIA · Llama 3.3 70B',
  },
  {
    id: 'nvidia:nvidia/nemotron-mini-4b-instruct (optimized) (optimized)',
    provider: 'nvidia',
    model: 'nvidia/nemotron-mini-4b-instruct',
    label: 'NVIDIA · Nemotron Mini 4B',
  },
];

export const DEFAULT_MODEL_ID = 'sarvam:sarvam-30b';

export function findModel(id: string): AiModelOption {
  return AI_MODELS.find((m) => m.id === id) || AI_MODELS[0];
}
