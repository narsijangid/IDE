import type { AiModelOption, AiProviderId } from '../../common/models';
import { AI_MODELS } from '../../common/models';

const POOLSIDE_URL = 'https://inference.poolside.ai/v1';
const DEFAULT_DEEPSEEK_BASE = 'https://api.deepseek.com';
const DEFAULT_OLLAMA_BASE = 'http://127.0.0.1:11434';

export interface OpencodeProviderSecrets {
  deepseekKey: string;
  deepseekBase: string;
  poolsideKey: string;
  ollamaBase: string;
}

export function opencodeModelRef(option: AiModelOption): { providerID: string; modelID: string } {
  if (option.provider === 'poolside') {
    return { providerID: 'poolside', modelID: option.model };
  }
  if (option.provider === 'ollama') {
    return { providerID: 'ollama', modelID: option.model };
  }
  return { providerID: 'deepseek', modelID: option.model };
}

function modelsFor(provider: AiProviderId): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const model of AI_MODELS) {
    if (model.provider !== provider) {
      continue;
    }
    out[model.model] = {
      id: model.model,
      name: model.displayName || model.label,
      tool_call: true,
      temperature: true,
      limit: {
        context: provider === 'ollama' ? 32768 : 128000,
        output: 8192,
      },
    };
  }
  return out;
}

/**
 * OPENCODE_CONFIG_CONTENT for the sidecar. Only OLKIL's three providers are
 * enabled so OpenCode does not probe dozens of unused vendor SDKs at boot.
 */
export function buildOpencodeConfigContent(secrets: OpencodeProviderSecrets): Record<string, unknown> {
  const deepseekBase = withV1(secrets.deepseekBase || DEFAULT_DEEPSEEK_BASE);
  const ollamaBase = withV1(secrets.ollamaBase || DEFAULT_OLLAMA_BASE);
  return {
    $schema: 'https://opencode.ai/config.json',
    username: 'OLKIL',
    autoupdate: false,
    share: 'disabled',
    logLevel: 'WARN',
    enabled_providers: ['deepseek', 'poolside', 'ollama'],
    permission: {
      edit: 'allow',
      bash: 'allow',
      webfetch: 'allow',
      doom_loop: 'allow',
      external_directory: 'deny',
    },
    provider: {
      deepseek: {
        npm: '@ai-sdk/openai-compatible',
        name: 'DeepSeek',
        options: {
          baseURL: deepseekBase,
          apiKey: secrets.deepseekKey,
          timeout: 300000,
        },
        models: modelsFor('deepseek'),
      },
      poolside: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Dazzlone',
        options: {
          baseURL: POOLSIDE_URL,
          apiKey: secrets.poolsideKey,
          timeout: 300000,
        },
        models: modelsFor('poolside'),
      },
      ollama: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Ollama',
        options: {
          baseURL: ollamaBase,
          apiKey: 'ollama',
          timeout: 300000,
        },
        models: modelsFor('ollama'),
      },
    },
  };
}

export function opencodeAgentForMode(mode: 'agent' | 'plan' | 'ask'): 'build' | 'plan' {
  return mode === 'agent' ? 'build' : 'plan';
}

function withV1(base: string): string {
  const normalized = String(base || '').replace(/\/$/, '');
  if (/\/v1$/i.test(normalized)) {
    return normalized;
  }
  return `${normalized}/v1`;
}
