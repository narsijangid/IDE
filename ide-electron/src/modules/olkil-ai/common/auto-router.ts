/**
 * Cursor-style Auto router: score the turn, then pick a strong model
 * that still stays cheap when the work is simple.
 */
export type AutoOptimizeFor = 'cost' | 'balanced' | 'intelligence';

export const AUTO_MODEL_ID = 'openrouter:auto';

/** Price-efficient coding models (OpenRouter slugs). */
const COST_POOL = [
  'openai/gpt-5.6-luna',
  'google/gemini-3.8-flash',
  'deepseek/deepseek-v4-flash',
  'google/gemini-3.5-flash',
] as const;

/** Daily-driver quality. */
const BALANCE_POOL = [
  'anthropic/claude-sonnet-5',
  'openai/gpt-5.6-sol',
  'x-ai/grok-4.6',
  'google/gemini-3.5-flash',
  'moonshotai/kimi-k2.7-code',
] as const;

/** Frontier when the turn is hard. */
const INTEL_POOL = [
  'anthropic/claude-opus-5',
  'openai/gpt-5.6-sol',
  'x-ai/grok-4.6',
  'anthropic/claude-sonnet-5',
] as const;

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
 * Resolve Auto → a concrete OpenRouter catalog id.
 * Pinned models pass through unchanged.
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
  const mode = input.optimizeFor || 'balanced';
  const score = scoreTurnComplexity(input.userText || '', input.messageCount || 1);
  const slug = pickSlug(mode, score, input.userText || '');
  return `openrouter:${slug}`;
}

function pickSlug(mode: AutoOptimizeFor, score: number, text: string): string {
  const ui = /\b(css|layout|ui|ux|button|modal|style|tailwind|less|scss|frontend|react|tsx)\b/i.test(text);
  if (mode === 'cost') {
    if (score >= 0.72) {
      return BALANCE_POOL[0];
    }
    if (ui) {
      return 'google/gemini-3.8-flash';
    }
    return COST_POOL[Math.min(COST_POOL.length - 1, score > 0.4 ? 1 : 0)];
  }
  if (mode === 'intelligence') {
    if (score < 0.28) {
      return BALANCE_POOL[0];
    }
    if (score < 0.55) {
      return INTEL_POOL[1];
    }
    return INTEL_POOL[0];
  }
  // Balance — Cursor default: cheap when simple, Sonnet-class when not.
  if (score < 0.34) {
    return ui ? 'google/gemini-3.8-flash' : COST_POOL[0];
  }
  if (score < 0.68) {
    return ui ? BALANCE_POOL[3] : BALANCE_POOL[0];
  }
  return INTEL_POOL[0];
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
