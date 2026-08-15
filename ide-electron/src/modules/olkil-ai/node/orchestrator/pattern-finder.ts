import type { CompactEvidence, PatternCard } from './types';

const PATTERN_HINTS = [
  'column',
  'export',
  'excel',
  'mapping',
  'dto',
  'model',
  'component',
  'visibility',
  'api',
  'field',
  'header',
];

export function findReferencePattern(input: {
  terms: string[];
  files: CompactEvidence[];
}): PatternCard | undefined {
  if (!input.files.length) return undefined;
  const terms = input.terms.map((t) => t.toLowerCase()).filter(Boolean);
  const scored = input.files.map((file) => {
    const blob = `${file.path} ${file.symbols.join(' ')} ${file.reason.join(' ')} ${file.excerpt || ''}`.toLowerCase();
    let extra = 0;
    for (const term of terms) {
      if (blob.includes(term.toLowerCase())) extra += 12;
    }
    for (const hint of PATTERN_HINTS) {
      if (blob.includes(hint)) extra += 3;
    }
    if (/\.model\.(ts|js)$/i.test(file.path)) extra += 10;
    if (/component\.(ts|js|tsx|jsx)$/i.test(file.path)) extra += 8;
    if (/report/i.test(file.path)) extra += 8;
    return { file, score: file.score + extra };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) return undefined;

  const related = scored
    .slice(1, 6)
    .map((item) => item.file.path);

  const pattern: string[] = [];
  const pathLower = best.file.path.toLowerCase();
  if (/\.model\./.test(pathLower) || /model/.test(pathLower)) pattern.push('model column / field definition');
  if (/component/.test(pathLower) || /\.(tsx|jsx)$/.test(pathLower)) pattern.push('component column / visibility rule');
  if (/api|controller|route|service/.test(pathLower)) pattern.push('API field mapping');
  if (/excel|export|xlsx/.test(pathLower)) pattern.push('Excel mapping');
  if (!pattern.length) pattern.push('existing implementation of the requested field/behavior');
  if (best.file.symbols[0]) pattern.push(`symbol ${best.file.symbols[0]}`);

  return {
    file: best.file.path,
    symbol: best.file.symbols[0],
    score: best.score,
    pattern,
    related,
  };
}
