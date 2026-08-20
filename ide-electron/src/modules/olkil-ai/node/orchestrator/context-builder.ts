import type { CompactEvidence, CompactTaskContext, PatternCard, TaskSize } from './types';

export function buildCompactContext(input: {
  task: string;
  size: TaskSize;
  files: CompactEvidence[];
  symbols?: CompactTaskContext['relevantSymbols'];
  reference?: PatternCard;
  backend?: string[];
  frontend?: string[];
  constraints?: string[];
  git?: string;
  environment?: string;
  maxChars: number;
  filesExplored: number;
  searches: number;
}): CompactTaskContext {
  const relevantFiles = rankEvidence(input.files).slice(0, input.size === 'simple' ? 4 : input.size === 'medium' ? 10 : 16);
  const relatedBackend = (input.backend || []).slice(0, 8);
  const relatedFrontend = (input.frontend || []).slice(0, 8);
  const constraints = (input.constraints || []).slice(0, 8);
  const symbols = (input.symbols || []).slice(0, 16);

  const blocks: string[] = [
    'REPOSITORY EVIDENCE PACK (deterministic retrieval — do not repeat these exact searches)',
    `TASK:\n${input.task.slice(0, 500)}`,
    `TASK SIZE: ${input.size}`,
  ];

  if (relevantFiles.length) {
    blocks.push(
      'RELEVANT FILES:\n' +
        relevantFiles
          .map((file) => {
            const head = `- ${file.path} (score ${Math.round(file.score)}${file.line ? `, L${file.line}` : ''}) ${file.reason.slice(0, 3).join('; ')}`;
            const excerpt = file.excerpt ? `\n  ${file.excerpt.split('\n').slice(0, 6).join('\n  ')}` : '';
            const symbolsLine = file.symbols.length ? `\n  symbols: ${file.symbols.slice(0, 8).join(', ')}` : '';
            return head + symbolsLine + excerpt;
          })
          .join('\n'),
    );
  }

  if (symbols.length) {
    blocks.push(
      'RELEVANT SYMBOLS:\n' +
        symbols
          .map((s) => `- ${s.name} (${s.kind}/${s.role}) ${s.path}:L${s.line}`)
          .join('\n'),
    );
  }

  if (input.reference) {
    blocks.push(
      [
        'REFERENCE IMPLEMENTATION:',
        `file: ${input.reference.file}`,
        input.reference.symbol ? `symbol: ${input.reference.symbol}` : '',
        'pattern:',
        ...input.reference.pattern.map((p) => `- ${p}`),
        input.reference.related.length ? `TARGET / RELATED:\n- ${input.reference.related.join('\n- ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  if (relatedBackend.length) blocks.push(`RELATED BACKEND:\n- ${relatedBackend.join('\n- ')}`);
  if (relatedFrontend.length) blocks.push(`RELATED FRONTEND:\n- ${relatedFrontend.join('\n- ')}`);
  if (constraints.length) blocks.push(`IMPORTANT CONSTRAINTS:\n- ${constraints.join('\n- ')}`);
  if (input.git) blocks.push(`GIT:\n${input.git}`);
  if (input.environment) blocks.push(`ENVIRONMENT:\n${input.environment}`);

  blocks.push(
    input.size === 'simple'
      ? 'Evidence is sufficient. Edit the shown file(s) now — do NOT run additional searches unless a target file is missing from this pack.'
      : 'Use this pack as the starting evidence. Call extra tools only for remaining gaps, in parallel. Then plan briefly and edit.',
  );

  let text = blocks.filter(Boolean).join('\n\n');
  if (text.length > input.maxChars) {
    text = `${text.slice(0, input.maxChars)}\n…[evidence truncated]`;
  }

  return {
    task: input.task,
    size: input.size,
    relevantFiles,
    relevantSymbols: symbols,
    reference: input.reference,
    relatedBackend,
    relatedFrontend,
    constraints,
    git: input.git,
    environment: input.environment,
    text,
    filesExplored: input.filesExplored,
    searches: input.searches,
  };
}

export function rankEvidence(files: CompactEvidence[]): CompactEvidence[] {
  const byPath = new Map<string, CompactEvidence>();
  for (const file of files) {
    const key = file.path.replace(/\\/g, '/').toLowerCase();
    const current = byPath.get(key);
    if (!current || file.score > current.score) {
      byPath.set(key, {
        ...file,
        reason: unique([...(current?.reason || []), ...file.reason]).slice(0, 6),
        symbols: unique([...(current?.symbols || []), ...file.symbols]).slice(0, 16),
        excerpt: file.excerpt || current?.excerpt,
      });
    } else {
      current.reason = unique([...current.reason, ...file.reason]).slice(0, 6);
      current.symbols = unique([...current.symbols, ...file.symbols]).slice(0, 16);
      current.score = Math.max(current.score, file.score);
      if (!current.excerpt && file.excerpt) current.excerpt = file.excerpt;
    }
  }
  return [...byPath.values()].sort((a, b) => b.score - a.score);
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
