import type { TaskRoute, TaskSize } from './types';

export type TaskIntent = 'title-change' | 'rename-label' | 'config-edit' | 'general';

const SIMPLE_HINT =
  'This is a small, localized task. The evidence pack already shows the target file(s). Edit immediately — do NOT search, grep, or read more files unless the excerpt is missing.';

const MEDIUM_HINT =
  'This is a medium multi-file task. Use the evidence pack, read only the needed ranges, copy an existing pattern, then edit. Stop exploring once targets are known.';

const LARGE_HINT =
  'This is a large task. Use the evidence pack and reference implementation first. Explore only remaining gaps in parallel. Stop searching when files, symbols, and the pattern are known.';

const SIMPLE_RE =
  /\b(rename|typo|typos|comment|label|color|padding|margin|css|copy|wording|tooltip|placeholder|spelling|indent|title|heading|header\s*text|project\s*name|app\s*name|product\s*name|window\.title|document\.title|productName|applicationName)\b/i;

const TITLE_CHANGE_RE =
  /\b(title|project\s*name|app\s*name|product\s*name|window\.title|document\.title|productName|applicationName)\b/i;
const EDIT_VERB_RE = /\b(change|update|set|rename|replace|modify|edit)\b/i;
const LARGE_RE =
  /\b(architect|refactor\s+all|migrate|redesign|multi[- ]module|backend\s+and\s+frontend|all\s+reports?|every\s+report|across\s+the\s+(codebase|repo|project)|end[- ]to[- ]end|system[- ]wide)\b/i;
const MULTI_FILE_RE =
  /\b(reports?|components?|models?|api|backend|frontend|service|controller|excel|export|column|mapping)\b/i;

function extractQuoted(text: string): string[] {
  const out: string[] = [];
  const re = /["'“”]([^"'“”]{2,80})["'“”]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    out.push(match[1].trim());
  }
  return out;
}

function extractPascal(text: string): string[] {
  return (text.match(/\b[A-Z][A-Za-z0-9]{2,}(?:[A-Z][A-Za-z0-9]+)+\b/g) || []).slice(0, 12);
}

function mentionedPaths(text: string): string[] {
  return (text.match(/[\w./\\-]+\.(ts|tsx|js|jsx|py|java|go|cs|json|html|css|vue|svelte)\b/gi) || []).slice(
    0,
    8,
  );
}

export function detectTaskIntent(prompt: string): TaskIntent {
  const text = (prompt || '').trim();
  if (TITLE_CHANGE_RE.test(text) && EDIT_VERB_RE.test(text)) {
    return 'title-change';
  }
  if (SIMPLE_RE.test(text)) {
    return 'rename-label';
  }
  if (/\b(config|setting|env|\.json|package\.json|product\.json)\b/i.test(text) && text.length < 220) {
    return 'config-edit';
  }
  return 'general';
}

/** High-signal grep/index terms for known intents — avoids generic “title” noise. */
export function seedTermsForIntent(intent: TaskIntent, prompt: string): string[] {
  const terms = extractTaskTerms(prompt);
  const seeded: string[] = [];
  if (intent === 'title-change') {
    seeded.push('productName', 'applicationName', '<title>', 'document.title');
  } else if (intent === 'config-edit') {
    seeded.push('product.json', 'package.json', 'index.html');
  }
  return [...new Set([...seeded, ...terms])].filter((t) => t.length >= 2).slice(0, 8);
}

export function extractTaskTerms(prompt: string): string[] {
  const terms = new Set<string>();
  for (const q of extractQuoted(prompt)) terms.add(q);
  for (const p of extractPascal(prompt)) terms.add(p);
  const phrases = prompt.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4}\b/g) || [];
  for (const phrase of phrases) {
    if (!/^(The|This|Please|Add|Update|Fix|Remove|Change|In)\b/.test(phrase)) terms.add(phrase);
  }
  const camel = prompt.match(/\b[a-z]+[A-Z][A-Za-z0-9]+\b/g) || [];
  for (const c of camel) terms.add(c);
  return [...terms].filter((t) => t.length >= 3).slice(0, 10);
}

export function classifyTask(prompt: string, opts?: { activeFile?: string }): TaskRoute {
  const text = (prompt || '').trim();
  const paths = mentionedPaths(text);
  const terms = extractTaskTerms(text);
  const intent = detectTaskIntent(text);
  const hasActive = Boolean(opts?.activeFile);
  const entityCount = terms.length;

  let size: TaskSize = 'medium';
  let reason = 'default multi-step coding task';

  if (!text) {
    size = 'simple';
    reason = 'empty/short prompt';
  } else if (LARGE_RE.test(text) || entityCount >= 6 || (MULTI_FILE_RE.test(text) && entityCount >= 4)) {
    size = 'large';
    reason = entityCount >= 6 ? 'many named entities / modules' : 'broad architecture or multi-surface change';
  } else if (
    intent === 'title-change' ||
    intent === 'config-edit' ||
    SIMPLE_RE.test(text) ||
    (paths.length === 1 && entityCount <= 2) ||
    (hasActive && text.length < 180 && entityCount <= 2 && !MULTI_FILE_RE.test(text)) ||
    (text.length < 120 && EDIT_VERB_RE.test(text) && entityCount <= 2)
  ) {
    size = 'simple';
    reason =
      intent === 'title-change'
        ? 'title/name change'
        : intent === 'config-edit'
          ? 'config edit'
          : paths.length === 1
            ? 'single explicit file'
            : 'localized edit';
  } else if (paths.length >= 3 || (MULTI_FILE_RE.test(text) && entityCount >= 2)) {
    size = 'medium';
    reason = 'related files / feature surface';
  }

  if (size === 'simple') {
    const titleTask = intent === 'title-change';
    return {
      size,
      reason,
      maxIterations: titleTask ? 8 : 12,
      maxContinues: 1,
      prefetchBudgetMs: titleTask ? 650 : 800,
      maxPrefetchFiles: titleTask ? 3 : 4,
      maxPrefetchSearches: titleTask ? 3 : 4,
      maxContextChars: titleTask ? 3_500 : 5_000,
      allowDeepInvestigate: false,
      promptHint: titleTask
        ? 'Title/name change. product.json, package.json, and index.html excerpts are in the evidence pack. Edit those lines now — zero further exploration.'
        : SIMPLE_HINT,
    };
  }
  if (size === 'medium') {
    return {
      size,
      reason,
      maxIterations: 72,
      maxContinues: 6,
      prefetchBudgetMs: 1_600,
      maxPrefetchFiles: 8,
      maxPrefetchSearches: 6,
      maxContextChars: 8_000,
      allowDeepInvestigate: true,
      promptHint: MEDIUM_HINT,
    };
  }
  return {
    size,
    reason,
    maxIterations: 120,
    maxContinues: 8,
    prefetchBudgetMs: 2_800,
    maxPrefetchFiles: 14,
    maxPrefetchSearches: 10,
    maxContextChars: 11_000,
    allowDeepInvestigate: true,
    promptHint: LARGE_HINT,
  };
}
