/**
 * SCIP-lite symbol intelligence (inspired by https://github.com/scip-code/scip).
 * Full SCIP needs language indexers (scip-typescript, scip-java, …).
 * Locally we approximate:
 *   symbol id ≈ local.<kind>.<Name>
 *   definitions + references + occurrences for goto / find-refs.
 */

export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'const'
  | 'variable'
  | 'method'
  | 'component'
  | 'route'
  | 'unknown';

export interface SymbolOccurrence {
  name: string;
  kind: SymbolKind;
  role: 'definition' | 'reference';
  line: number;
  detail?: string;
}

export interface SymbolHit {
  name: string;
  kind: SymbolKind;
  path: string;
  line: number;
  role: 'definition' | 'reference';
  detail?: string;
  score: number;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

function pushUnique(out: SymbolOccurrence[], item: SymbolOccurrence) {
  if (
    out.some(
      (existing) =>
        existing.name === item.name &&
        existing.role === item.role &&
        existing.line === item.line,
    )
  ) {
    return;
  }
  if (out.length < 900) out.push(item);
}

/**
 * Tree-sitter-inspired structural extraction via targeted patterns
 * (fast, no native WASM dependency in Electron main).
 */
export function extractOccurrences(text: string): SymbolOccurrence[] {
  const out: SymbolOccurrence[] = [];
  const patterns: Array<{ re: RegExp; kind: SymbolKind; role: 'definition' | 'reference'; group: number; detail?: (m: RegExpExecArray) => string }> = [
    { re: /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g, kind: 'function', role: 'definition', group: 1 },
    { re: /\b(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/g, kind: 'class', role: 'definition', group: 1 },
    { re: /\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/g, kind: 'interface', role: 'definition', group: 1 },
    { re: /\b(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/g, kind: 'type', role: 'definition', group: 1 },
    { re: /\b(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/g, kind: 'enum', role: 'definition', group: 1 },
    { re: /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g, kind: 'const', role: 'definition', group: 1 },
    { re: /\b(?:public|private|protected|static|async|\s)+([A-Za-z_$][\w$]*)\s*\([^;{]*\)\s*\{/g, kind: 'method', role: 'definition', group: 1 },
    { re: /\bdef\s+([A-Za-z_][\w]*)\s*\(/g, kind: 'function', role: 'definition', group: 1 },
    { re: /\bclass\s+([A-Za-z_][\w]*)\s*[:(]/g, kind: 'class', role: 'definition', group: 1 },
    { re: /\b(?:fn|func)\s+([A-Za-z_][\w]*)\s*\(/g, kind: 'function', role: 'definition', group: 1 },
    { re: /@(?:Get|Post|Put|Patch|Delete|RequestMapping|GetMapping|PostMapping)\s*\(\s*['"`]([^'"`]+)['"`]/g, kind: 'route', role: 'definition', group: 1 },
    { re: /\b(?:app|router)\.(?:get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/gi, kind: 'route', role: 'definition', group: 1 },
    { re: /\b(?:from|import)\s+['"`]([^'"`]+)['"`]/g, kind: 'unknown', role: 'reference', group: 1, detail: () => 'import' },
    { re: /\b([A-Z][A-Za-z0-9_$]*)\s*\(/g, kind: 'function', role: 'reference', group: 1 },
    { re: /<([A-Z][A-Za-z0-9_$]*)\b/g, kind: 'component', role: 'reference', group: 1 },
    { re: /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g, kind: 'function', role: 'reference', group: 1, detail: () => 'call' },
  ];

  for (const pattern of patterns) {
    pattern.re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.re.exec(text))) {
      const name = match[pattern.group];
      if (!name || name.length < 2) continue;
      // Filter common false positives for method/function scanners.
      if (
        (pattern.kind === 'method' || pattern.detail?.(match) === 'call') &&
        /^(if|for|while|switch|catch|return|function|class|else|try|new|typeof|await|async|super|constructor|describe|it|test|expect)$/.test(
          name,
        )
      ) {
        continue;
      }
      pushUnique(out, {
        name,
        kind: pattern.kind === 'unknown' && /[A-Z]/.test(name[0]) ? 'component' : pattern.kind,
        role: pattern.role,
        line: lineOf(text, match.index),
        detail: pattern.detail?.(match),
      });
    }
  }

  return out;
}

export function buildSymbolTables(docs: Array<{ key: string; path: string; occurrences: SymbolOccurrence[] }>) {
  const definitions = new Map<string, SymbolHit[]>();
  const references = new Map<string, SymbolHit[]>();

  const add = (map: Map<string, SymbolHit[]>, hit: SymbolHit) => {
    const key = hit.name.toLowerCase();
    const list = map.get(key) || [];
    list.push(hit);
    map.set(key, list);
  };

  for (const doc of docs) {
    for (const occ of doc.occurrences) {
      const hit: SymbolHit = {
        name: occ.name,
        kind: occ.kind,
        path: doc.path,
        line: occ.line,
        role: occ.role,
        detail: occ.detail,
        score: occ.role === 'definition' ? 100 : 40,
      };
      if (occ.role === 'definition') add(definitions, hit);
      else add(references, hit);
    }
  }

  // A declaration such as `function uploadDocument()` also matches the
  // generic call pattern. SCIP occurrence roles must not report that token
  // as both definition and reference.
  for (const [key, refs] of references) {
    const defs = definitions.get(key) || [];
    references.set(
      key,
      refs.filter(
        (ref) => !defs.some((def) => def.path === ref.path && def.line === ref.line),
      ),
    );
  }

  return { definitions, references };
}

export function lookupDefinitions(
  definitions: Map<string, SymbolHit[]>,
  name: string,
  limit = 20,
): SymbolHit[] {
  const exact = definitions.get(name.toLowerCase()) || [];
  if (exact.length) {
    return exact
      .slice()
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, limit);
  }
  // Fuzzy: compact camel match (DocumentUpload ≈ documentupload)
  const compact = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const fuzzy: SymbolHit[] = [];
  for (const [key, hits] of definitions) {
    const keyCompact = key.replace(/[^a-z0-9]/g, '');
    if (keyCompact.includes(compact) || compact.includes(keyCompact)) {
      for (const hit of hits) {
        fuzzy.push({ ...hit, score: hit.score * 0.7 });
      }
    }
  }
  return fuzzy.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function lookupReferences(
  references: Map<string, SymbolHit[]>,
  definitions: Map<string, SymbolHit[]>,
  name: string,
  limit = 40,
): SymbolHit[] {
  const key = name.toLowerCase();
  const refs = [...(references.get(key) || [])];
  const defs = definitions.get(key) || [];
  // Include defs so callers see owners first.
  return [...defs, ...refs]
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit);
}
