/**
 * Auto picker: always DeepSeek V4 Flash on OpenRouter (cheap, low tokens).
 * Pinned models in the catalog still pass through unchanged.
 */
export type AutoOptimizeFor = 'cost' | 'balanced' | 'intelligence';

export const AUTO_MODEL_ID = 'openrouter:auto';

/** Background model for Auto — not shown as the picker label. */
export const AUTO_ROUTED_SLUG = 'deepseek/deepseek-v4-flash';

const HARD_RE =
  /\b(architect|refactor|migrate|rewrite|redesign|multi-?file|race condition|deadlock|security|auth|oauth|jwt|schema|database|performance|optimiz|concurren|distribut|algorithm|type.?error|webpack|vite|electron|opencode)\b/i;
const MEDIUM_RE =
  /\b(bug|fix|implement|feature|endpoint|api|component|hook|css|layout|test|spec|debug|error|crash|fail|tool|agent|edit|patch)\b/i;
const EASY_RE =
  /\b(typo|rename|comment|wording|copy|label|color|padding|margin|format|what is|explain|summar)\b/i;

export function isAutoModelId(modelId?: string): boolean {
  const id = String(modelId || '').trim().toLowerCase();
  return id === AUTO_MODEL_ID || id === 'auto' || id === 'openrouter/auto';
}

export function lastUserText(messages: Array<{ role?: string; content?: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') {
      continue;
    }
    const text = contentToText(m.content);
    if (text.trim()) {
      return text;
    }
  }
  return '';
}

export function scoreTurnComplexity(text: string, messageCount: number): number {
  const t = String(text || '');
  let score = 0.18;
  if (t.length > 400) score += 0.12;
  if (t.length > 1200) score += 0.12;
  if (t.length > 4000) score += 0.12;
  if ((t.match(/```/g) || []).length >= 2) score += 0.12;
  if (/\b(src|app|ide-electron|package\.json|tsconfig)\b/i.test(t)) score += 0.08;
  if (HARD_RE.test(t)) score += 0.28;
  if (MEDIUM_RE.test(t)) score += 0.14;
  if (EASY_RE.test(t) && !HARD_RE.test(t)) score -= 0.16;
  if (messageCount >= 8) score += 0.08;
  if (messageCount >= 16) score += 0.08;
  return Math.max(0, Math.min(1, score));
}

/**
 * Resolve Auto → DeepSeek V4 Flash. Any other catalog id is left as-is.
 */
export function routeOpenRouterModel(input: {
  modelId?: string;
  optimizeFor?: AutoOptimizeFor;
  userText?: string;
  messageCount?: number;
}): string {
  const requested = String(input.modelId || AUTO_MODEL_ID).trim() || AUTO_MODEL_ID;
  if (!isAutoModelId(requested)) {
    return requested;
  }
  return `openrouter:${AUTO_ROUTED_SLUG}`;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part === 'object' && typeof (part as any).text === 'string') {
          return (part as any).text;
        }
        return '';
      })
      .join('\n');
  }
  return '';
}
