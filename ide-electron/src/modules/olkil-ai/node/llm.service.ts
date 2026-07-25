import * as fs from 'fs';
import * as path from 'path';
import { Injectable } from '@opensumi/di';
import fetch from 'node-fetch';
import {
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatMessage,
  ChatStreamState,
  ChatToolCall,
  IOlkilAiNodeService,
} from '../common';
import { AI_MODELS, DEFAULT_MODEL_ID, findModel, AiProviderId } from '../common/models';
import { AGENT_TOOLS } from '../common/tools';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const SARVAM_URL = 'https://api.sarvam.ai/v1/chat/completions';

function loadDotEnv(): Record<string, string> {
  const candidates = [
    path.join(process.cwd(), '.env'),
    path.join(__dirname, '../../.env'),
    path.join(__dirname, '../../../.env'),
  ];
  const out: Record<string, string> = {};
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) {
        continue;
      }
      const text = fs.readFileSync(file, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
          continue;
        }
        const eq = trimmed.indexOf('=');
        if (eq <= 0) {
          continue;
        }
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        out[key] = value;
      }
      break;
    } catch {
      // try next
    }
  }
  return out;
}

function providerLabel(provider: AiProviderId): string {
  if (provider === 'nvidia') {
    return 'NVIDIA';
  }
  if (provider === 'sarvam') {
    return 'Sarvam';
  }
  return 'OpenRouter';
}

/** Normalize OpenAI-style content (string | parts array | null). */
export function normalizeMessageContent(content: unknown): string {
  if (content == null) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part === 'object') {
          if (typeof (part as any).text === 'string') {
            return (part as any).text;
          }
          if (typeof (part as any).content === 'string') {
            return (part as any).content;
          }
        }
        return '';
      })
      .join('');
  }
  if (typeof content === 'object' && typeof (content as any).text === 'string') {
    return (content as any).text;
  }
  return '';
}

@Injectable()
export class OlkilAiNodeService implements IOlkilAiNodeService {
  private env = loadDotEnv();
  private streams = new Map<string, ChatStreamState>();

  private getKey(provider: AiProviderId): string {
    if (provider === 'nvidia') {
      return process.env.NVIDIA_API_KEY || this.env.NVIDIA_API_KEY || '';
    }
    if (provider === 'sarvam') {
      return process.env.SARVAM_API_KEY || this.env.SARVAM_API_KEY || '';
    }
    return process.env.OPENROUTER_API_KEY || this.env.OPENROUTER_API_KEY || '';
  }

  private get maxTokens(): number {
    const raw = process.env.OPENROUTER_MAX_TOKENS || this.env.OPENROUTER_MAX_TOKENS || '2048';
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 4096) : 2048;
  }

  async listModels() {
    return AI_MODELS.map((m) => ({
      id: m.id,
      provider: m.provider,
      model: m.model,
      label: m.label,
    }));
  }

  async hasApiKey(provider?: string): Promise<boolean> {
    if (provider === 'nvidia' || provider === 'openrouter' || provider === 'sarvam') {
      return Boolean(this.getKey(provider as AiProviderId));
    }
    return Boolean(
      this.getKey('openrouter') || this.getKey('nvidia') || this.getKey('sarvam'),
    );
  }

  async getModelName(modelId?: string): Promise<string> {
    return findModel(modelId || DEFAULT_MODEL_ID).model;
  }

  async getStreamState(streamId: string): Promise<ChatStreamState> {
    // Unknown id ⇒ not done yet (poll may start before the RPC body begins).
    return this.streams.get(streamId) || { text: '', done: false };
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    const option = findModel(request.modelId || DEFAULT_MODEL_ID);
    const apiKey = this.getKey(option.provider);
    if (!apiKey) {
      throw new Error(`${providerLabel(option.provider)} API key missing. Add it to .env`);
    }

    const useStream = Boolean(request.stream && request.streamId);
    if (useStream && request.streamId) {
      this.streams.set(request.streamId, { text: '', done: false });
    }

    const messages = request.messages.map((m) => this.serializeMessage(m));
    const body: Record<string, unknown> = {
      model: option.model,
      messages,
      temperature: 0.2,
      max_tokens: this.maxTokens,
      stream: useStream,
    };

    // Providers reject histories containing tool messages unless `tools` is also
    // sent, so keep the declarations even when forcing tool_choice: 'none'.
    const historyHasToolTraffic = request.messages.some(
      (m) => m.role === 'tool' || Boolean(m.tool_calls?.length),
    );
    if (request.tools?.length) {
      body.tools = request.tools;
      body.tool_choice = request.toolChoice || 'auto';
    } else if (historyHasToolTraffic) {
      body.tools = AGENT_TOOLS;
      body.tool_choice = request.toolChoice || 'none';
    } else if (request.toolChoice === 'none') {
      body.tool_choice = 'none';
    }

    let url = OPENROUTER_URL;
    if (option.provider === 'nvidia') {
      url = NVIDIA_URL;
    } else if (option.provider === 'sarvam') {
      url = SARVAM_URL;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (option.provider === 'sarvam') {
      headers['api-subscription-key'] = apiKey;
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    if (option.provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://olkil.local';
      headers['X-Title'] = 'OLKIL Agent';
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const raw = await res.text();
        const err = `${option.provider} API ${res.status}: ${raw.slice(0, 500)}`;
        if (useStream && request.streamId) {
          this.streams.set(request.streamId, { text: '', done: true, error: err });
        }
        throw new Error(err);
      }

      if (useStream && request.streamId) {
        const result = await this.consumeSse(res, request.streamId);
        this.streams.set(request.streamId, {
          text: result.content,
          done: true,
        });
        // cleanup later
        setTimeout(() => this.streams.delete(request.streamId!), 60_000);
        return result;
      }

      const raw = await res.text();
      let data: any;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(`Invalid ${option.provider} response: ${raw.slice(0, 300)}`);
      }

      return this.parseCompletionChoice(data);
    } catch (e: any) {
      if (useStream && request.streamId) {
        this.streams.set(request.streamId, {
          text: this.streams.get(request.streamId)?.text || '',
          done: true,
          error: e?.message || String(e),
        });
      }
      throw e;
    }
  }

  private parseCompletionChoice(data: any): ChatCompletionResult {
    const choice = data?.choices?.[0];
    const message = choice?.message || {};
    return {
      content: normalizeMessageContent(message.content),
      tool_calls: message.tool_calls,
      finish_reason: choice?.finish_reason,
    };
  }

  private async consumeSse(res: any, streamId: string): Promise<ChatCompletionResult> {
    let content = '';
    const toolCalls: ChatToolCall[] = [];
    let finishReason: string | undefined;

    // node-fetch body is a Node stream
    const body = res.body;
    if (!body || typeof body.on !== 'function') {
      const raw = await res.text();
      // some providers ignore stream and return JSON
      try {
        return this.parseCompletionChoice(JSON.parse(raw));
      } catch {
        content = raw;
        this.streams.set(streamId, { text: content, done: false });
        return { content, finish_reason: 'stop' };
      }
    }

    let buffer = '';
    await new Promise<void>((resolve, reject) => {
      body.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const parts = buffer.split('\n');
        buffer = parts.pop() || '';
        for (const line of parts) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) {
            continue;
          }
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') {
            continue;
          }
          try {
            const json = JSON.parse(payload);
            const choice = json?.choices?.[0];
            const delta = choice?.delta || {};
            if (choice?.finish_reason) {
              finishReason = choice.finish_reason;
            }
            const piece = normalizeMessageContent(delta.content);
            if (piece) {
              content += piece;
              this.streams.set(streamId, { text: content, done: false });
            }
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = typeof tc.index === 'number' ? tc.index : toolCalls.length;
                if (!toolCalls[idx]) {
                  toolCalls[idx] = {
                    id: tc.id || `call_${idx}`,
                    type: 'function',
                    function: { name: tc.function?.name || '', arguments: '' },
                  };
                }
                if (tc.id) {
                  toolCalls[idx].id = tc.id;
                }
                if (tc.function?.name) {
                  toolCalls[idx].function.name += tc.function.name;
                }
                if (tc.function?.arguments) {
                  toolCalls[idx].function.arguments += tc.function.arguments;
                }
              }
            }
          } catch {
            // ignore partial JSON
          }
        }
      });
      body.on('end', () => resolve());
      body.on('error', (err: Error) => reject(err));
    });

    return {
      content,
      tool_calls: toolCalls.length ? toolCalls.filter(Boolean) : undefined,
      finish_reason: finishReason,
    };
  }

  private serializeMessage(m: ChatMessage) {
    const msg: Record<string, unknown> = {
      role: m.role,
      content: m.content ?? '',
    };
    if (m.name) {
      msg.name = m.name;
    }
    if (m.tool_call_id) {
      msg.tool_call_id = m.tool_call_id;
    }
    if (m.tool_calls?.length) {
      msg.tool_calls = m.tool_calls;
      if (!m.content) {
        msg.content = null;
      }
    }
    return msg;
  }
}
