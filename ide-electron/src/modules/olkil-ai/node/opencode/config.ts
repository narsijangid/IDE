import type { AiModelOption, AiProviderId, CustomModelEndpoint } from '../../common/models';
import { AI_MODELS, customEndpointFor, isRetiredOlkilModel, opencodeCustomProviderId, openRouterExtraModels } from '../../common/models';

const DEFAULT_DEEPSEEK_BASE = 'https://api.deepseek.com';
const DEFAULT_OLLAMA_BASE = 'http://127.0.0.1:11434';
const DEFAULT_OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

export interface OpencodeProviderSecrets {
  deepseekKey: string;
  deepseekBase: string;
  poolsideKey: string;
  ollamaBase: string;
  openrouterKey: string;
  openrouterBase: string;
}

export function opencodeModelRef(option: AiModelOption): { providerID: string; modelID: string } {
  if (option.provider === 'ollama') {
    return { providerID: 'ollama', modelID: option.model };
  }
  if (option.provider === 'custom') {
    return { providerID: opencodeCustomProviderId(option.id), modelID: option.model };
  }
  if (option.provider === 'openrouter') {
    return { providerID: 'openrouter', modelID: option.model };
  }
  return { providerID: 'deepseek', modelID: option.model };
}

function modelsFor(provider: AiProviderId): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const extras = provider === 'openrouter' ? openRouterExtraModels() : [];
  const list = provider === 'openrouter' ? [...AI_MODELS, ...extras] : AI_MODELS;
  for (const model of list) {
    if (model.provider !== provider || isRetiredOlkilModel(model)) {
      continue;
    }
    if (provider === 'openrouter' && (model.model === 'auto' || model.id.endsWith(':auto'))) {
      continue;
    }
    if (out[model.model]) {
      continue;
    }
    out[model.model] = {
      id: model.model,
      name: model.displayName || model.label,
      tool_call: true,
      temperature: true,
      ...openaiCompatModelFlags(),
      limit: {
        context: provider === 'ollama' ? 32768 : 128000,
        output: 8192,
      },
    };
  }
  return out;
}

/**
 * OPENCODE_CONFIG_CONTENT for the sidecar. Built-in providers plus any user
 * OpenAI-compatible custom models. Unused vendor SDKs stay disabled.
 */
export interface OpencodeMcpServer {
  name: string;
  enabled: boolean;
  type: 'local' | 'remote';
  command?: string;
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export function toOpencodeMcp(servers?: OpencodeMcpServer[]): Record<string, unknown> | undefined {
  if (!servers?.length) {
    return undefined;
  }
  const mcp: Record<string, unknown> = {};
  for (const server of servers) {
    if (!server.enabled || !server.name) {
      continue;
    }
    const key = server.name.replace(/[^\w.-]+/g, '-').slice(0, 40) || 'mcp';
    if (server.type === 'remote' && server.url) {
      const remote: Record<string, unknown> = { type: 'remote', url: server.url, enabled: true };
      if (server.headers && Object.keys(server.headers).length) {
        remote.headers = server.headers;
      }
      mcp[key] = remote;
    } else if (server.command) {
      const command = splitCommand(server.command);
      if (command.length) {
        const local: Record<string, unknown> = { type: 'local', command, enabled: true };
        if (server.env && Object.keys(server.env).length) {
          local.environment = server.env;
        }
        mcp[key] = local;
      }
    }
  }
  return Object.keys(mcp).length ? mcp : undefined;
}

export function buildOpencodeConfigContent(
  secrets: OpencodeProviderSecrets,
  extras?: { mcp?: Record<string, unknown>; customModels?: CustomModelEndpoint[]; plugin?: string[] },
): Record<string, unknown> {
  const deepseekBase = withV1(secrets.deepseekBase || DEFAULT_DEEPSEEK_BASE);
  const ollamaBase = withV1(secrets.ollamaBase || DEFAULT_OLLAMA_BASE);
  const openrouterBase = withV1(secrets.openrouterBase || DEFAULT_OPENROUTER_BASE);
  const customProviders = customProviderBlock(extras?.customModels);
  const enabled = ['openrouter', 'deepseek', 'ollama', ...Object.keys(customProviders)];
  const config: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    username: 'OLKIL',
    autoupdate: false,
    share: 'disabled',
    logLevel: 'WARN',
    enabled_providers: enabled,
    permission: {
      edit: 'allow',
      bash: 'ask',
      webfetch: 'allow',
      doom_loop: 'allow',
      external_directory: 'deny',
    },
    // Auto-compact dumps a session recap and often stops the turn before edits.
    compaction: {
      auto: false,
    },
    provider: {
      openrouter: {
        npm: '@ai-sdk/openai-compatible',
        name: 'OpenRouter',
        options: {
          baseURL: openrouterBase,
          apiKey: secrets.openrouterKey,
          timeout: 300000,
          headers: {
            'HTTP-Referer': 'https://olkil.com',
            'X-Title': 'OLKIL',
          },
        },
        models: modelsFor('openrouter'),
      },
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
      ...customProviders,
    },
  };
  if (extras?.mcp && Object.keys(extras.mcp).length) {
    config.mcp = extras.mcp;
  }
  if (extras?.plugin?.length) {
    config.plugin = extras.plugin;
  }
  return config;
}

function customProviderBlock(endpoints?: CustomModelEndpoint[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const ep of endpoints || []) {
    const optionId = ep.id;
    const secret = customEndpointFor(optionId);
    const baseURL = secret?.baseUrl || ep.baseUrl;
    const apiKey = secret?.apiKey || ep.apiKey;
    if (!baseURL || !apiKey || !ep.model) {
      continue;
    }
    const providerID = opencodeCustomProviderId(optionId);
    out[providerID] = {
      npm: '@ai-sdk/openai-compatible',
      name: ep.label || ep.model,
      options: {
        baseURL,
        apiKey,
        timeout: 300000,
      },
      models: {
        [ep.model]: {
          id: ep.model,
          name: ep.label || ep.model,
          tool_call: true,
          temperature: true,
          ...openaiCompatModelFlags(),
          limit: {
            context: 128000,
            output: 8192,
          },
        },
      },
    };
  }
  return out;
}

function openaiCompatModelFlags(): Record<string, unknown> {
  // OpenCode 1.18.21 injects OpenAI-only `textVerbosity` for gpt-5.x ids on
  // @ai-sdk/openai-compatible (gateways 400 with "verbosity is not supported").
  // Keep reasoning off so variants don't add more of those params. The sidecar
  // is pinned to 1.18.22+ where that injection is native-OpenAI only.
  return { reasoning: false };
}

function splitCommand(command: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command))) {
    out.push(match[1] || match[2] || match[3]);
  }
  return out;
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
