import type { TaskRoute, TaskSize } from './types';

const SIMPLE_HINT =
  'This is a small, localized task. Confirm the target file, then edit immediately. Do not start a wide repository investigation.';

const MEDIUM_HINT =
  'This is a medium multi-file task. Use the evidence pack, read only the needed ranges, copy an existing pattern, then edit. Stop exploring once targets are known.';

const LARGE_HINT =
  'This is a large task. Use the evidence pack and reference implementation first. Explore only remaining gaps in parallel. Stop searching when files, symbols, and the pattern are known.';

const SIMPLE_RE =
  /\b(rename|typo|typos|comment|label|color|padding|margin|css|copy|wording|tooltip|placeholder|spelling|indent)\b/i;
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

export function extractTaskTerms(prompt: string): string[] {
  const terms = new Set<string>();
  for (const q of extractQuoted(prompt)) terms.add(q);
  for (const p of extractPascal(prompt)) terms.add(p);
  const phrases = prompt.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4}\b/g) || [];
  for (const phrase of phrases) {
    if (!/^(The|This|Please|Add|Update|Fix|Remove)\b/.test(phrase)) terms.add(phrase);
  }
  const camel = prompt.match(/\b[a-z]+[A-Z][A-Za-z0-9]+\b/g) || [];
  for (const c of camel) terms.add(c);
  return [...terms].filter((t) => t.length >= 3).slice(0, 10);
}

export function classifyTask(prompt: string, opts?: { activeFile?: string }): TaskRoute {
  const text = (prompt || '').trim();
  const paths = mentionedPaths(text);
  const terms = extractTaskTerms(text);
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
    SIMPLE_RE.test(text) ||
    (paths.length === 1 && entityCount <= 2) ||
    (hasActive && text.length < 180 && entityCount <= 2 && !MULTI_FILE_RE.test(text))
  ) {
    size = 'simple';
    reason = paths.length === 1 ? 'single explicit file' : 'localized edit';
  } else if (paths.length >= 3 || (MULTI_FILE_RE.test(text) && entityCount >= 2)) {
    size = 'medium';
    reason = 'related files / feature surface';
  }

  if (size === 'simple') {
    return {
      size,
      reason,
      maxIterations: 16,
      maxContinues: 1,
      prefetchBudgetMs: 900,
      maxPrefetchFiles: 4,
      maxPrefetchSearches: 4,
      maxContextChars: 6_000,
      allowDeepInvestigate: false,
      promptHint: SIMPLE_HINT,
    };
  }
  if (size === 'medium') {
    return {
      size,
      reason,
      maxIterations: 64,
      maxContinues: 3,
      prefetchBudgetMs: 2_200,
      maxPrefetchFiles: 10,
      maxPrefetchSearches: 8,
      maxContextChars: 9_000,
      allowDeepInvestigate: true,
      promptHint: MEDIUM_HINT,
    };
  }
  return {
    size,
    reason,
    maxIterations: 200,
    maxContinues: 8,
    prefetchBudgetMs: 3_500,
    maxPrefetchFiles: 16,
    maxPrefetchSearches: 12,
    maxContextChars: 12_000,
    allowDeepInvestigate: true,
    promptHint: LARGE_HINT,
  };
}
