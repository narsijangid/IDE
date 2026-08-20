import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import {
  CodeRelationType,
  InvestigationIntent,
  InvestigationResult,
  RepositoryIndexStatus,
  RepositoryOverview,
  RepositorySearchHit,
  RepositorySearchResult,
  RepositorySymbolResult,
} from '../common';
import {
  buildSymbolTables,
  extractOccurrences,
  lookupDefinitions,
  lookupReferences,
  SymbolHit,
  SymbolOccurrence,
} from './scip-lite';
import { buildTrigramSignature, signatureMayContain } from './trigram';
import { invalidateRipgrepCache, ripgrepSearch } from './ripgrep';

const INDEX_VERSION = 7;
const MAX_FILE_BYTES = 1_200_000;
const MAX_INDEX_CHARS = 320_000;
const MAX_FILES = 120_000;
const MAX_TERMS_PER_FILE = 1800;
const CACHE_DIR = path.join(os.homedir(), '.olkil', 'repository-index');

const SKIP_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  '.idea',
  '.vscode',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.olkil',
  '.sumi',
  '.sumi-oss',
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  'bin',
  'obj',
  '__pycache__',
  '.venv',
  'venv',
]);

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonc',
  '.py', '.pyi', '.java', '.kt', '.kts', '.go', '.rs', '.cs', '.cpp',
  '.cc', '.c', '.h', '.hpp', '.rb', '.php', '.swift', '.scala', '.vue',
  '.svelte', '.astro', '.html', '.css', '.less', '.scss', '.sass', '.sql',
  '.graphql', '.gql', '.md', '.mdx', '.yaml', '.yml', '.toml', '.xml',
  '.sh', '.ps1', '.dockerfile', '.gradle', '.properties',
]);

const SPECIAL_FILES = new Set([
  'dockerfile', 'makefile', 'procfile', 'gemfile', 'rakefile',
  'package.json', 'tsconfig.json', 'pyproject.toml', 'cargo.toml',
  'go.mod', 'pom.xml', 'build.gradle', 'requirements.txt',
]);

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'from', 'with', 'this', 'that', 'into', 'then',
  'else', 'true', 'false', 'null', 'undefined', 'return', 'const', 'let',
  'var', 'function', 'class', 'public', 'private', 'protected', 'static',
  'import', 'export', 'default', 'async', 'await', 'new', 'string', 'number',
  'boolean', 'object', 'type', 'interface', 'extends', 'implements', 'void',
  'use', 'using', 'get', 'set', 'has', 'can', 'will', 'file', 'code',
]);

interface IndexedDocument {
  path: string;
  /** Lowercase path key used for map lookups / graph edges. */
  key: string;
  language: string;
  size: number;
  mtimeMs: number;
  lineCount: number;
  terms: Record<string, number>;
  symbols: string[];
  imports: string[];
  calls: string[];
  componentRefs: string[];
  apiCalls: string[];
  routeDefs: string[];
  trigramSignature: string;
  occurrences: SymbolOccurrence[];
  dependencies: string[];
  dependents: string[];
}

interface GraphEdge {
  to: string;
  type: CodeRelationType;
  label: string;
  weight: number;
}

interface PersistedIndex {
  version: number;
  root: string;
  indexedAt: number;
  documents: IndexedDocument[];
}

interface IndexState {
  root: string;
  phase: RepositoryIndexStatus['state'];
  documents: Map<string, IndexedDocument>;
  inverted: Map<string, Map<string, number>>;
  /** basename → document keys (extreme-fast find_files / module seed) */
  basenameIndex: Map<string, string[]>;
  /** path token → document keys */
  pathTokenIndex: Map<string, string[]>;
  graph: Map<string, GraphEdge[]>;
  symbolDefinitions: Map<string, SymbolHit[]>;
  symbolReferences: Map<string, SymbolHit[]>;
  indexedAt?: number;
  elapsedMs?: number;
  error?: string;
  build?: Promise<void>;
}

function normalizeRoot(root: string): string {
  return path.resolve(root || '').replace(/[\\/]+$/, '');
}

function relative(root: string, absolute: string): string {
  return path.relative(root, absolute).replace(/\\/g, '/');
}

function normalizeRelative(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function isInsideRoot(root: string, absolute: string): boolean {
  const rel = path.relative(root, absolute);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function languageFor(filePath: string): string {
  const name = path.basename(filePath).toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  const ext = path.extname(name).slice(1);
  const aliases: Record<string, string> = {
    tsx: 'typescript', ts: 'typescript', jsx: 'javascript', js: 'javascript',
    mjs: 'javascript', cjs: 'javascript', py: 'python', pyi: 'python',
    rs: 'rust', cs: 'csharp', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
    rb: 'ruby', kt: 'kotlin', kts: 'kotlin', yml: 'yaml',
  };
  return aliases[ext] || ext || name;
}

function splitIdentifier(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9_$-]+/)
    .map((token) => token.replace(/^[-_$]+|[-_$]+$/g, ''))
    .filter((token) => token.length > 1 && token.length < 80 && !STOP_WORDS.has(token));
}

function tokenize(text: string): string[] {
  const raw = splitIdentifier(text);
  const out = [...raw];
  // Bigrams give a small model semantic-ish phrase matching without a remote
  // embedding call (e.g. "auth middleware", "dependency graph").
  for (let i = 0; i + 1 < raw.length; i++) {
    if (raw[i].length > 2 && raw[i + 1].length > 2) {
      out.push(`${raw[i]}_${raw[i + 1]}`);
    }
  }
  return out;
}

/** Query phrases that look like named modules/features, not generic verbs. */
function extractModulePhrases(query: string): string[] {
  const lower = query.toLowerCase();
  const phrases = new Set<string>();
  const quoted = /["'`]([^"'`]{2,80})["'`]/g;
  let match: RegExpExecArray | null;
  while ((match = quoted.exec(query))) {
    phrases.add(match[1].trim());
  }
  const named =
    /(?:module|feature|component|service|screen|page|folder|package)\s+(?:named\s+|called\s+)?([a-z0-9][\w\s-]{1,60})/gi;
  while ((match = named.exec(query))) {
    phrases.add(match[1].trim());
  }
  const trailing =
    /([a-z0-9][\w\s-]{1,60})\s+(?:module|feature|component|service|screen|page)/gi;
  while ((match = trailing.exec(query))) {
    phrases.add(match[1].trim());
  }
  const filler = new Set([
    'module', 'feature', 'component', 'service', 'change', 'changes', 'update', 'fix',
    'add', 'remove', 'please', 'project', 'the', 'a', 'an', 'this', 'that', 'with', 'from', 'into',
    'make', 'create', 'edit', 'and', 'or', 'to', 'do', 'need', 'needed', 'some', 'any',
  ]);
  const content = splitIdentifier(lower).filter(
    (t) => t.length > 2 && !STOP_WORDS.has(t) && !filler.has(t),
  );
  for (let n = Math.min(4, content.length); n >= 2; n--) {
    for (let i = 0; i + n <= content.length; i++) {
      phrases.add(content.slice(i, i + n).join(' '));
    }
  }
  if (content.length === 1) {
    phrases.add(content[0]);
  }
  return [...phrases].filter((p) => p.length > 1).slice(0, 12);
}

function pathTokens(filePath: string): string[] {
  return splitIdentifier(filePath.replace(/[\\/]/g, ' '));
}

/** Precomputed phrase spellings — hoisted out of the per-document hot loop. */
interface PreparedPhrase {
  tokens: string[];
  kebab: string;
  snake: string;
  camelLower: string;
  pascalLower: string;
  compact: string;
}

function preparePhrase(phrase: string): PreparedPhrase | undefined {
  const tokens = splitIdentifier(phrase);
  if (!tokens.length) return undefined;
  const pascal = tokens.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join('');
  return {
    tokens,
    kebab: tokens.join('-'),
    snake: tokens.join('_'),
    camelLower: (tokens[0] + pascal.slice(tokens[0].length)).toLowerCase(),
    pascalLower: pascal.toLowerCase(),
    compact: tokens.join(''),
  };
}

/** Per-document path forms, computed once per index build (not per query). */
interface DocPathInfo {
  lower: string;
  compact: string;
  tokens: string[];
  depthBonus: number;
}

const docPathInfoCache = new Map<string, DocPathInfo>();

function docPathInfo(filePath: string): DocPathInfo {
  let info = docPathInfoCache.get(filePath);
  if (!info) {
    const lower = filePath.toLowerCase();
    let depthBonus = 0;
    if (/(^|\/)index\.[^/]+$/i.test(filePath)) depthBonus += 18;
    if (/(module|feature|screen|page|service|controller|routes?)\.[^/]+$/i.test(filePath)) depthBonus += 22;
    if (filePath.split('/').length <= 5) depthBonus += 8;
    info = {
      lower,
      compact: lower.replace(/[^a-z0-9]/g, ''),
      tokens: pathTokens(filePath),
      depthBonus,
    };
    if (docPathInfoCache.size > 300_000) docPathInfoCache.clear();
    docPathInfoCache.set(filePath, info);
  }
  return info;
}

/**
 * Score how well a natural-language module name matches a file path.
 * "application timeline" should hit application-timeline/, ApplicationTimeline/, etc.
 */
function modulePathScorePrepared(
  info: DocPathInfo,
  prepared: PreparedPhrase,
): { score: number; reason: string } | undefined {
  const { lower: lowerPath, compact: compactPath } = info;
  const { tokens: phraseTokens, kebab, snake, camelLower, pascalLower, compact } = prepared;

  let score = 0;
  const reasons: string[] = [];
  if (lowerPath.includes(`/${kebab}/`) || lowerPath.includes(`${kebab}/`) || lowerPath.includes(`/${kebab}.`)) {
    score += 120;
    reasons.push(`folder ${kebab}`);
  } else if (lowerPath.includes(kebab)) {
    score += 90;
    reasons.push(`path ${kebab}`);
  }
  if (lowerPath.includes(snake)) {
    score += 70;
    reasons.push(`path ${snake}`);
  }
  if (compactPath.includes(compact)) {
    score += 85;
    reasons.push(`compact ${pascalLower}`);
  }
  if (lowerPath.includes(camelLower) || lowerPath.includes(pascalLower)) {
    score += 75;
    reasons.push(`identifier ${pascalLower}`);
  }

  let consecutive = 0;
  let phraseIdx = 0;
  for (const segment of info.tokens) {
    if (segment === phraseTokens[phraseIdx]) {
      consecutive++;
      phraseIdx++;
      if (phraseIdx >= phraseTokens.length) {
        break;
      }
    } else if (phraseIdx > 0 && segment !== phraseTokens[0]) {
      // allow gap reset only after miss
      phraseIdx = segment === phraseTokens[0] ? 1 : 0;
      consecutive = phraseIdx;
    }
  }
  if (consecutive === phraseTokens.length) {
    score += 100;
    reasons.push('path tokens');
  } else if (consecutive > 0) {
    score += consecutive * 18;
  }

  if (score > 0) {
    score += info.depthBonus;
  }

  return score > 0 ? { score, reason: reasons[0] || 'module path' } : undefined;
}

function modulePathScore(filePath: string, phrase: string): { score: number; reason: string } | undefined {
  const prepared = preparePhrase(phrase);
  if (!prepared) return undefined;
  return modulePathScorePrepared(docPathInfo(filePath), prepared);
}

function termVector(text: string, filePath: string): Record<string, number> {
  const frequencies = new Map<string, number>();
  const tokens = tokenize(`${filePath} ${filePath} ${text}`);
  for (const token of tokens) {
    frequencies.set(token, Math.min(24, (frequencies.get(token) || 0) + 1));
  }
  return Object.fromEntries(
    [...frequencies.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_TERMS_PER_FILE),
  );
}

function extractSymbols(text: string): string[] {
  const symbols = new Set<string>();
  const patterns = [
    /\b(?:class|interface|type|enum|function|namespace|module|trait|struct)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?:=|:)/g,
    /\bdef\s+([A-Za-z_]\w*)\s*\(/g,
    /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/g,
    /\b(?:public|private|protected|internal)?\s*(?:static\s+)?(?:async\s+)?[A-Za-z_<>,[\]?]+\s+([A-Za-z_]\w*)\s*\(/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) && symbols.size < 300) {
      symbols.add(match[1]);
    }
  }
  return [...symbols];
}

function extractImports(text: string): string[] {
  const imports = new Set<string>();
  const patterns = [
    /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+/gm,
    /^\s*import\s+([A-Za-z0-9_.]+)/gm,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) && imports.size < 250) {
      imports.add(match[1]);
    }
  }
  return [...imports];
}

function extractCalls(text: string): string[] {
  const calls = new Set<string>();
  const pattern = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(/g;
  const ignored = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof',
    'super', 'constructor', 'describe', 'it', 'test', 'expect',
  ]);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) && calls.size < 700) {
    const full = match[1];
    const name = full.includes('.') ? full.split('.').pop()! : full;
    if (name.length > 1 && !ignored.has(name.toLowerCase())) calls.add(name);
  }
  return [...calls];
}

function extractComponentRefs(text: string): string[] {
  const refs = new Set<string>();
  const pattern = /<([A-Z][A-Za-z0-9_$]*(?:\.[A-Z][A-Za-z0-9_$]*)?)(?:\s|\/?>)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) && refs.size < 250) {
    refs.add(match[1].split('.').pop()!);
  }
  return [...refs];
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/\?.*$/, '')
    .replace(/\$\{[^}]+\}|:[A-Za-z_]\w*|\{[^}]+\}/g, ':param')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase() || '/';
}

function extractApiCalls(text: string): string[] {
  const endpoints = new Set<string>();
  const patterns = [
    /\bfetch\s*\(\s*[`'"]([^`'"]+)[`'"]/g,
    /\baxios(?:\.(?:get|post|put|patch|delete))?\s*\(\s*[`'"]([^`'"]+)[`'"]/gi,
    /\b(?:api|client|http|request)\.(?:get|post|put|patch|delete)\s*\(\s*[`'"]([^`'"]+)[`'"]/gi,
    /\burl\s*:\s*[`'"]([^`'"]+)[`'"]/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) && endpoints.size < 250) {
      const endpoint = normalizeEndpoint(match[1]);
      if (endpoint.startsWith('/')) endpoints.add(endpoint);
    }
  }
  return [...endpoints];
}

function extractRouteDefs(text: string): string[] {
  const endpoints = new Set<string>();
  const patterns = [
    /\b(?:app|router)\.(?:get|post|put|patch|delete|use)\s*\(\s*[`'"]([^`'"]+)[`'"]/gi,
    /@(?:Get|Post|Put|Patch|Delete|RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping)\s*\(\s*(?:value\s*=\s*)?[`'"]([^`'"]+)[`'"]/g,
    /\b(?:Route|HttpGet|HttpPost|HttpPut|HttpDelete)\s*\(\s*[`'"]([^`'"]+)[`'"]/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) && endpoints.size < 250) {
      endpoints.add(normalizeEndpoint(match[1]));
    }
  }
  return [...endpoints];
}

const CONCEPT_GROUPS: string[][] = [
  ['upload', 'attachment', 'attach', 'document', 'file', 'media', 'asset', 'multipart', 'dropzone'],
  ['timeline', 'activity', 'history', 'event', 'feed', 'audit', 'log'],
  ['auth', 'authentication', 'login', 'signin', 'session', 'token', 'jwt', 'credential'],
  ['user', 'profile', 'account', 'member', 'customer'],
  ['payment', 'billing', 'invoice', 'checkout', 'subscription', 'transaction'],
  ['image', 'photo', 'picture', 'thumbnail', 'avatar'],
  ['notification', 'alert', 'message', 'toast', 'email', 'sms'],
  ['delete', 'remove', 'destroy', 'archive'],
  ['create', 'add', 'new', 'insert'],
  ['update', 'edit', 'change', 'modify', 'patch'],
  ['search', 'find', 'lookup', 'filter', 'query'],
  ['save', 'persist', 'store', 'write'],
  ['download', 'export', 'retrieve'],
];

function analyzeIntent(query: string): InvestigationIntent {
  const lower = query.toLowerCase();
  const kind: InvestigationIntent['kind'] =
    /\b(not working|broken|bug|error|fail|issue|problem|fix|crash)\b/i.test(lower)
      ? 'bug'
      : /\b(add|create|implement|feature)\b/i.test(lower)
        ? 'feature'
        : /\b(refactor|cleanup|optimi[sz]e|performance)\b/i.test(lower)
          ? 'refactor'
          : 'question';
  const concepts = [...new Set(splitIdentifier(query).filter((token) => token.length > 2))];
  const expanded = new Set(concepts);
  for (const concept of concepts) {
    for (const group of CONCEPT_GROUPS) {
      if (group.includes(concept)) {
        for (const synonym of group) expanded.add(synonym);
      }
    }
  }
  return {
    kind,
    concepts,
    expandedConcepts: [...expanded],
    modulePhrases: extractModulePhrases(query),
  };
}

function isIndexable(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  if (base === 'package-lock.json' || base === 'composer.lock' || base.endsWith('.min.js')) {
    return false;
  }
  return SPECIAL_FILES.has(base) || SOURCE_EXTENSIONS.has(path.extname(base).toLowerCase());
}

function cachePath(root: string): string {
  const key = createHash('sha1').update(root.toLowerCase()).digest('hex');
  return path.join(CACHE_DIR, `${key}.json`);
}

function gitIgnoreMatcher(root: string): (absolute: string, directory: boolean) => boolean {
  try {
    const rules = fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'))
      .map((line) => {
        const directoryOnly = line.endsWith('/');
        let pattern = line.replace(/^\/|\/$/g, '').replace(/\\/g, '/');
        pattern = pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*\//g, '(?:.*/)?')
          .replace(/\*/g, '[^/]*')
          .replace(/\?/g, '[^/]');
        return {
          directoryOnly,
          regex: new RegExp(`(?:^|/)${pattern}${directoryOnly ? '(?:/|$)' : '$'}`, 'i'),
        };
      });
    return (absolute, directory) => {
      const rel = relative(root, absolute);
      return rules.some((rule) => (!rule.directoryOnly || directory) && rule.regex.test(rel));
    };
  } catch {
    return () => false;
  }
}

/**
 * Local repository intelligence engine.
 *
 * It combines a BM25-style sparse vector index, symbol extraction, and a
 * bidirectional dependency graph. This is deterministic, offline, and much
 * cheaper than embedding every chunk through an LLM; excerpts are loaded only
 * for the final ranked files.
 */
export class RepositoryIndexService {
  private readonly states = new Map<string, IndexState>();
  /** Sticky query → hits (agent loops re-issue identical searches). */
  private readonly stickySearch = new Map<string, { at: number; value: any }>();
  private readonly STICKY_TTL_MS = 60_000;
  private readonly STICKY_MAX = 200;

  private stickyGet<T>(key: string): T | undefined {
    const hit = this.stickySearch.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.STICKY_TTL_MS) {
      this.stickySearch.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  private stickySet(key: string, value: unknown): void {
    if (this.stickySearch.size >= this.STICKY_MAX) {
      const oldest = this.stickySearch.keys().next().value;
      if (oldest !== undefined) this.stickySearch.delete(oldest);
    }
    this.stickySearch.set(key, { at: Date.now(), value });
  }

  private invalidateSticky(root?: string): void {
    if (!root) {
      this.stickySearch.clear();
      this.rankCache.clear();
      invalidateRipgrepCache();
      return;
    }
    const prefix = root.toLowerCase();
    for (const key of [...this.stickySearch.keys()]) {
      if (key.includes(prefix)) this.stickySearch.delete(key);
    }
    invalidateRipgrepCache(root);
    this.rankCache.clear();
  }

  async ensure(rootInput: string): Promise<RepositoryIndexStatus> {
    const root = normalizeRoot(rootInput);
    let state = this.states.get(root);
    if (!state) {
      state = {
        root,
        phase: 'loading',
        documents: new Map(),
        inverted: new Map(),
        basenameIndex: new Map(),
        pathTokenIndex: new Map(),
        graph: new Map(),
        symbolDefinitions: new Map(),
        symbolReferences: new Map(),
      };
      this.states.set(root, state);
      if (this.loadCache(state)) {
        // Cached intelligence is usable immediately; reconcile external edits
        // in the background without delaying the current agent turn.
        state.build = this.build(state).catch(() => undefined);
      } else {
        state.build = this.build(state);
      }
    }
    // Extreme: if we already have docs, serve NOW — don't await background reconcile.
    if (state.documents.size > 0) {
      return this.status(state);
    }
    if (state.phase !== 'ready' && state.build) {
      await state.build;
    }
    return this.status(state);
  }

  statusFor(rootInput: string): RepositoryIndexStatus {
    const root = normalizeRoot(rootInput);
    const state = this.states.get(root);
    return state
      ? this.status(state)
      : { root, state: 'idle', files: 0, symbols: 0, edges: 0 };
  }

  async search(rootInput: string, query: string, limit = 12): Promise<RepositorySearchResult> {
    const root = normalizeRoot(rootInput);
    await this.ensure(root);
    const state = this.states.get(root)!;
    const stickyKey = `search|${root}|${state.indexedAt || 0}|${limit}|${query.slice(0, 300)}`;
    const cached = this.stickyGet<RepositorySearchResult>(stickyKey);
    if (cached) return cached;
    const hits = this.rank(state, query, Math.max(1, Math.min(40, limit)));
    const result = {
      status: this.status(state),
      query,
      hits: hits.map((item) =>
        this.toSearchHit(state, item.path, item.score, item.reason, query, false),
      ),
    };
    this.stickySet(stickyKey, result);
    return result;
  }

  async exactSearch(rootInput: string, query: string, limit = 20): Promise<RepositorySearchResult> {
    const root = normalizeRoot(rootInput);
    await this.ensure(root);
    const state = this.states.get(root)!;
    const needle = query.trim();
    if (needle.length < 3) return this.search(root, needle, limit);

    const stickyKey = `exact|${root}|${limit}|${needle.slice(0, 400)}`;
    const cached = this.stickyGet<RepositorySearchResult>(stickyKey);
    if (cached) return cached;

    // Fast path: native ripgrep (livegrep-style) — use rg line text as excerpt
    // (no sync re-read of every hit file).
    const rg = await ripgrepSearch(root, needle, {
      maxResults: Math.max(40, limit * 4),
      timeoutMs: 2200,
    });
    if (rg.engine === 'ripgrep') {
      const byFile = new Map<string, { count: number; firstLine: number; sample: string }>();
      for (const match of rg.matches) {
        const key = normalizeRelative(match.path);
        const entry = byFile.get(key);
        if (entry) {
          entry.count++;
        } else {
          byFile.set(key, { count: 1, firstLine: match.line, sample: match.text });
        }
      }
      const lowerNeedleRg = needle.toLowerCase();
      const ranked = [...byFile.entries()]
        .map(([fileKey, info]) => {
          const doc = state.documents.get(fileKey);
          const pathMatch = fileKey.includes(lowerNeedleRg);
          const symbolMatch = !!doc?.symbols.some((s) => s.toLowerCase().includes(lowerNeedleRg));
          const frontendBoost = /frontend|src\/app|components?\//i.test(fileKey) ? 18 : 0;
          const backendPenalty = /backend|migrations?|models?\//i.test(fileKey) ? -12 : 0;
          return {
            path: fileKey,
            score:
              100 +
              Math.min(30, info.count * 3) +
              (pathMatch ? 45 : 0) +
              (symbolMatch ? 35 : 0) +
              frontendBoost +
              backendPenalty,
            reason: [
              `exact match ×${info.count} (line ${info.firstLine})`,
              `e.g. ${info.sample.slice(0, 120)}`,
              ...(pathMatch ? ['path match'] : []),
              ...(symbolMatch ? ['symbol definition'] : []),
            ],
            sample: `${info.firstLine}|${info.sample}`,
          };
        })
        .sort((a, b) => b.score - a.score);
      const result = {
        status: this.status(state),
        query,
        hits: ranked.slice(0, Math.max(1, Math.min(80, limit))).map((item) => {
          const hit = this.toSearchHit(state, item.path, item.score, item.reason, query, false);
          hit.excerpt = item.sample;
          return hit;
        }),
      };
      this.stickySet(stickyKey, result);
      return result;
    }

    const lowerNeedle = needle.toLowerCase();
    const candidates = [...state.documents.values()].filter((doc) =>
      signatureMayContain(doc.trigramSignature, lowerNeedle),
    );
    const matches: Array<{ path: string; score: number; reason: string[] }> = [];

    // Bloom filtering usually leaves a tiny set. Cap pathological saturated
    // signatures, prioritizing path/symbol candidates before content reads.
    candidates.sort((a, b) => {
      const score = (doc: IndexedDocument) => {
        const identity = `${doc.path} ${doc.symbols.join(' ')}`.toLowerCase();
        return identity.includes(lowerNeedle) ? 1 : 0;
      };
      return score(b) - score(a);
    });
    for (const doc of candidates.slice(0, 6000)) {
      try {
        const text = await fs.promises.readFile(path.join(root, doc.path), 'utf8');
        const lower = text.toLowerCase();
        const first = lower.indexOf(lowerNeedle);
        const pathMatch = doc.path.toLowerCase().includes(lowerNeedle);
        if (first < 0 && !pathMatch) continue;
        let occurrences = 0;
        let cursor = 0;
        while ((cursor = lower.indexOf(lowerNeedle, cursor)) >= 0 && occurrences < 30) {
          occurrences++;
          cursor += Math.max(1, lowerNeedle.length);
        }
        const symbolMatch = doc.symbols.some((symbol) =>
          symbol.toLowerCase().includes(lowerNeedle),
        );
        matches.push({
          path: doc.key,
          score: 100 + Math.min(30, occurrences * 3) + (pathMatch ? 45 : 0) + (symbolMatch ? 35 : 0),
          reason: [
            'exact substring',
            `${occurrences} occurrence${occurrences === 1 ? '' : 's'}`,
            ...(pathMatch ? ['path match'] : []),
            ...(symbolMatch ? ['symbol definition'] : []),
          ],
        });
      } catch {
        // File may have changed between index and verification.
      }
    }
    matches.sort((a, b) => b.score - a.score);
    const bloomResult = {
      status: this.status(state),
      query,
      hits: matches
        .slice(0, Math.max(1, Math.min(80, limit)))
        .map((item) => this.toSearchHit(state, item.path, item.score, item.reason, query, false)),
    };
    this.stickySet(stickyKey, bloomResult);
    return bloomResult;
  }

  /**
   * Extreme-fast path finder from basename / path-token indexes (no FS walk).
   */
  async findFilesByName(
    rootInput: string,
    query: string,
    limit = 40,
  ): Promise<{ files: string[]; engine: 'index' | 'empty'; elapsedMs: number }> {
    const started = Date.now();
    const root = normalizeRoot(rootInput);
    await this.ensure(root);
    const state = this.states.get(root)!;
    const needle = (query || '').trim().toLowerCase().replace(/\*/g, '');
    if (!needle) {
      return { files: [], engine: 'empty', elapsedMs: 0 };
    }
    const stickyKey = `findfiles|${root}|${state.indexedAt || 0}|${needle}|${limit}`;
    const cached = this.stickyGet<{ files: string[]; engine: 'index' | 'empty'; elapsedMs: number }>(
      stickyKey,
    );
    if (cached) return { ...cached, elapsedMs: Date.now() - started };

    const scored = new Map<string, number>();
    const bump = (key: string, score: number) => {
      scored.set(key, Math.max(scored.get(key) || 0, score));
    };

    const baseHit = state.basenameIndex.get(needle);
    if (baseHit) {
      for (const key of baseHit) bump(key, 100);
    }
    for (const [base, keys] of state.basenameIndex) {
      if (base.includes(needle) || needle.includes(base)) {
        for (const key of keys) bump(key, base === needle ? 100 : 70);
      }
    }
    for (const token of tokenize(needle)) {
      const keys = state.pathTokenIndex.get(token);
      if (!keys) continue;
      for (const key of keys) bump(key, 40);
    }
    // Path substring fallback on candidate set only (not full FS)
    if (scored.size < limit) {
      for (const key of state.documents.keys()) {
        if (key.toLowerCase().includes(needle)) bump(key, 55);
        if (scored.size > limit * 8) break;
      }
    }

    const files = [...scored.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(1, Math.min(200, limit)))
      .map(([key]) => state.documents.get(key)?.path || key);

    const result = {
      files,
      engine: (files.length ? 'index' : 'empty') as 'index' | 'empty',
      elapsedMs: Date.now() - started,
    };
    this.stickySet(stickyKey, result);
    return result;
  }

  async symbolDefinitions(
    rootInput: string,
    symbol: string,
    limit = 20,
  ): Promise<RepositorySymbolResult> {
    const root = normalizeRoot(rootInput);
    await this.ensure(root);
    const state = this.states.get(root)!;
    return {
      status: this.status(state),
      symbol,
      hits: lookupDefinitions(state.symbolDefinitions, symbol, Math.max(1, Math.min(80, limit))),
    };
  }

  async symbolReferences(
    rootInput: string,
    symbol: string,
    limit = 40,
  ): Promise<RepositorySymbolResult> {
    const root = normalizeRoot(rootInput);
    await this.ensure(root);
    const state = this.states.get(root)!;
    return {
      status: this.status(state),
      symbol,
      hits: lookupReferences(
        state.symbolReferences,
        state.symbolDefinitions,
        symbol,
        Math.max(1, Math.min(160, limit)),
      ),
    };
  }

  /**
   * Cursor-style module locator: prioritize folder/path identity over bag-of-words
   * content ranking when the user names a feature module.
   */
  async findModules(rootInput: string, query: string, limit = 16): Promise<RepositorySearchResult> {
    const root = normalizeRoot(rootInput);
    await this.ensure(root);
    const state = this.states.get(root)!;
    const stickyKey = `modules|${root}|${state.indexedAt || 0}|${limit}|${query.slice(0, 300)}`;
    const cached = this.stickyGet<RepositorySearchResult>(stickyKey);
    if (cached) return cached;

    const phrases = extractModulePhrases(query);
    const effectivePhrases = phrases.length ? phrases : [query];
    const scores = new Map<string, { score: number; reason: string[] }>();

    const preparedPhrases = effectivePhrases
      .map((phrase) => ({ phrase, prepared: preparePhrase(phrase) }))
      .filter((item): item is { phrase: string; prepared: PreparedPhrase } => !!item.prepared);

    // Extreme: seed from pathTokenIndex / basenameIndex instead of full doc scan when possible.
    const candidateKeys = new Set<string>();
    for (const { prepared } of preparedPhrases) {
      for (const token of prepared.tokens) {
        for (const key of state.pathTokenIndex.get(token) || []) candidateKeys.add(key);
      }
      for (const key of state.basenameIndex.get(prepared.kebab) || []) candidateKeys.add(key);
      for (const key of state.basenameIndex.get(prepared.compact) || []) candidateKeys.add(key);
      for (const [base, keys] of state.basenameIndex) {
        if (base.includes(prepared.compact) || prepared.compact.includes(base.replace(/\.[^.]+$/, ''))) {
          for (const key of keys) candidateKeys.add(key);
        }
      }
    }
    // Fallback: if index sparse, scan (still capped)
    const docsToScan =
      candidateKeys.size >= 3
        ? [...candidateKeys].map((k) => state.documents.get(k)!).filter(Boolean)
        : [...state.documents.values()];

    for (const doc of docsToScan) {
      const info = docPathInfo(doc.path);
      for (const { prepared } of preparedPhrases) {
        const pathHit = modulePathScorePrepared(info, prepared);
        if (pathHit) {
          const current = scores.get(doc.key) || { score: 0, reason: [] };
          current.score += pathHit.score;
          if (!current.reason.includes(pathHit.reason)) current.reason.push(pathHit.reason);
          scores.set(doc.key, current);
        }
        let symbolHits = 0;
        let firstSymbol = '';
        for (const symbol of doc.symbols) {
          const compactSymbol = symbol.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (compactSymbol.includes(prepared.compact)) {
            symbolHits++;
            if (!firstSymbol) firstSymbol = symbol;
          }
        }
        if (symbolHits) {
          const current = scores.get(doc.key) || { score: 0, reason: [] };
          current.score += 55 + Math.min(30, symbolHits * 8);
          const label = `symbol ${firstSymbol}`;
          if (!current.reason.includes(label)) current.reason.push(label);
          scores.set(doc.key, current);
        }
      }
    }

    for (const phrase of effectivePhrases.slice(0, 4)) {
      for (const item of this.rank(state, phrase, Math.max(limit * 2, 24))) {
        const current = scores.get(item.path) || { score: 0, reason: [] };
        current.score += item.score * 0.45;
        for (const reason of item.reason.slice(0, 2)) {
          if (!current.reason.includes(reason)) current.reason.push(reason);
        }
        scores.set(item.path, current);
      }
    }

    const ranked = [...scores.entries()]
      .map(([filePath, value]) => ({ path: filePath, ...value }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(40, limit)));

    const result = {
      status: this.status(state),
      query,
      hits: ranked.map((item) =>
        this.toSearchHit(state, item.path, item.score, item.reason, query, false),
      ),
    };
    this.stickySet(stickyKey, result);
    return result;
  }

  /**
   * Evidence-based investigation:
   * 1) infer intent + semantic concepts
   * 2) retrieve module/content seeds
   * 3) traverse imports, calls, JSX, API routes and reverse edges
   * 4) continue until confidence is high or the evidence budget is exhausted
   */
  async investigate(rootInput: string, query: string, limit = 24): Promise<InvestigationResult> {
    const root = normalizeRoot(rootInput);
    await this.ensure(root);
    const state = this.states.get(root)!;
    const stickyKey = `inv|${root}|${state.indexedAt || 0}|${limit}|${query.slice(0, 350)}`;
    const cached = this.stickyGet<InvestigationResult>(stickyKey);
    if (cached) return cached;

    const started = Date.now();
    const DEADLINE_MS = 1800; // soft budget — partial dossier beats timeout empty
    const timeLeft = () => DEADLINE_MS - (Date.now() - started);

    const intent = analyzeIntent(query);
    const budget = Math.max(8, Math.min(50, limit));
    const expandedQuery = `${query} ${intent.expandedConcepts.join(' ')}`;

    const exactTerms = [
      ...new Set(
        intent.concepts.filter(
          (concept) =>
            concept.length >= 4 &&
            !/^(working|problem|issue|error|change|update|please)$/.test(concept),
        ),
      ),
    ].slice(0, 4);
    const escapedTerms = exactTerms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const [moduleSeeds, combinedExact] = await Promise.all([
      this.findModules(root, query, 12),
      escapedTerms.length
        ? ripgrepSearch(root, `(${escapedTerms.join('|')})`, {
            maxResults: 60,
            regex: true,
            timeoutMs: Math.min(1800, Math.max(600, timeLeft())),
          })
        : Promise.resolve(undefined),
    ]);
    const exactResults: RepositorySearchResult[] = [];
    if (combinedExact?.engine === 'ripgrep' && combinedExact.matches.length) {
      const byFile = new Map<string, number>();
      for (const match of combinedExact.matches) {
        const key = normalizeRelative(match.path);
        byFile.set(key, (byFile.get(key) || 0) + 1);
      }
      exactResults.push({
        status: this.status(state),
        query: exactTerms.join(' | '),
        hits: [...byFile.entries()]
          .map(([fileKey, count]) => ({
            path: fileKey,
            score: 90 + Math.min(40, count * 4),
            language: state.documents.get(fileKey)?.language || '',
            reason: [`exact term match ×${count}`],
            symbols: [],
            excerpt: '',
            dependencies: [],
            dependents: [],
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 16),
      });
    }
    const semanticSeeds = this.rank(state, expandedQuery, 18);
    const seedScores = new Map<string, { score: number; reasons: string[] }>();
    for (const hit of moduleSeeds.hits) {
      const key = normalizeRelative(hit.path);
      seedScores.set(key, { score: hit.score + 80, reasons: hit.reason });
    }
    for (const exactResult of exactResults) {
      for (const hit of exactResult.hits) {
        const key = normalizeRelative(hit.path);
        const current = seedScores.get(key);
        if (current) {
          current.score += hit.score * 0.7;
          if (!current.reasons.includes('Zoekt-style exact evidence')) {
            current.reasons.unshift('Zoekt-style exact evidence');
          }
        } else {
          seedScores.set(key, {
            score: hit.score * 0.9,
            reasons: ['Zoekt-style exact evidence', ...hit.reason],
          });
        }
      }
    }
    for (const hit of semanticSeeds) {
      const current = seedScores.get(hit.path);
      if (current) {
        current.score += hit.score * 0.55;
        for (const reason of hit.reason) if (!current.reasons.includes(reason)) current.reasons.push(reason);
      } else {
        seedScores.set(hit.path, { score: hit.score, reasons: hit.reason });
      }
    }

    type QueueItem = {
      key: string;
      score: number;
      depth: number;
      via: CodeRelationType;
      from?: string;
      label: string;
    };
    const queue: QueueItem[] = [...seedScores.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 10)
      .map(([key, seed]) => ({
        key,
        score: seed.score,
        depth: 0,
        via: 'seed',
        label: seed.reasons.slice(0, 3).join(', '),
      }));
    const best = new Map<string, QueueItem>();
    const parents = new Map<string, { from: string; label: string }>();
    const maxSeed = Math.max(1, ...queue.map((item) => item.score));
    const largeRepo = state.documents.size > 8_000;
    let clueExpansions = 0;

    while (queue.length && best.size < budget && timeLeft() > 120) {
      queue.sort((a, b) => b.score - a.score);
      const current = queue.shift()!;
      const previous = best.get(current.key);
      if (previous && previous.score >= current.score) continue;
      const doc = state.documents.get(current.key);
      if (!doc) continue;
      best.set(current.key, current);
      if (current.from) {
        parents.set(current.key, { from: current.from, label: current.label });
      }
      if (current.depth >= (largeRepo ? 2 : 4)) continue;

      for (const edge of state.graph.get(current.key) || []) {
        const target = state.documents.get(edge.to);
        if (!target) continue;
        const conceptBoost = this.documentConceptScore(target, intent.expandedConcepts);
        const nextScore =
          current.score * edge.weight * (current.depth === 0 ? 0.92 : 0.76) +
          conceptBoost * 7;
        if (nextScore < maxSeed * 0.055) continue;
        queue.push({
          key: edge.to,
          score: nextScore,
          depth: current.depth + 1,
          via: edge.type,
          from: current.key,
          label: edge.label,
        });
      }

      const edgeCount = state.graph.get(current.key)?.length || 0;
      // Skip expensive clue rank on large repos / past deadline / after a few expansions.
      if (
        !largeRepo &&
        clueExpansions < 6 &&
        timeLeft() > 400 &&
        current.depth < 2 &&
        edgeCount < 4
      ) {
        clueExpansions++;
        const clueQuery = [
          ...intent.expandedConcepts.slice(0, 6),
          ...doc.symbols.slice(0, 6),
          ...doc.calls.slice(0, 6),
          ...doc.apiCalls.slice(0, 4),
          ...doc.routeDefs.slice(0, 4),
        ].join(' ');
        for (const neighbor of this.rank(state, clueQuery, 4)) {
          if (neighbor.path === current.key) continue;
          const nextScore = current.score * 0.34 + neighbor.score * 0.5;
          if (nextScore < maxSeed * 0.06) continue;
          queue.push({
            key: neighbor.path,
            score: nextScore,
            depth: current.depth + 1,
            via: 'semantic',
            from: current.key,
            label: 'shares discovered symbols/concepts',
          });
        }
      }
    }

    const ordered = [...best.values()].sort((a, b) => b.score - a.score);
    const evidence = ordered.map((item, index) => {
      const doc = state.documents.get(item.key)!;
      return {
        path: doc.path,
        score: Math.round((item.score / maxSeed) * 1000) / 10,
        depth: item.depth,
        via: item.via,
        from: item.from ? state.documents.get(item.from)?.path : undefined,
        reasons: [
          item.label,
          ...this.evidenceReasons(doc, intent.expandedConcepts),
        ].filter(Boolean).slice(0, 8),
        symbols: doc.symbols.slice(0, 18),
        calls: doc.calls.slice(0, 18),
        apiEndpoints: [...doc.apiCalls, ...doc.routeDefs].slice(0, 16),
        // Only top evidence gets disk excerpts — biggest I/O win.
        excerpt: index < 6 ? this.excerpt(root, doc.path, expandedQuery) : '',
      };
    });

    const trails = ordered
      .filter((item) => item.depth > 0)
      .slice(0, 10)
      .map((item) => {
        const trail: string[] = [];
        let key: string | undefined = item.key;
        let guard = 0;
        while (key && guard++ < 6) {
          const doc = state.documents.get(key);
          if (doc) trail.unshift(doc.path);
          key = parents.get(key)?.from;
        }
        return trail;
      })
      .filter((trail) => trail.length > 1);

    const relationTypes = new Set(evidence.map((item) => item.via));
    const hasApiChain = evidence.some((item) => item.via === 'api_calls' || item.via === 'api_handles');
    const longestTrail = trails.reduce((max, trail) => Math.max(max, trail.length), 0);
    const hasReadworthySeeds = evidence.filter((item) => item.depth === 0 && item.score >= 45).length;
    const conceptCoverage = intent.concepts.length
      ? intent.concepts.filter((concept) =>
          evidence.some((item) =>
            `${item.path} ${item.symbols.join(' ')} ${item.calls.join(' ')}`.toLowerCase().includes(concept),
          ),
        ).length / intent.concepts.length
      : 0;
    const confidence = Math.min(
      99,
      Math.round(
        25 +
        Math.min(28, hasReadworthySeeds * 8) +
        Math.min(22, relationTypes.size * 4) +
        conceptCoverage * 20 +
        (hasApiChain ? 12 : 0) +
        (longestTrail >= 4 ? 14 : longestTrail >= 3 ? 8 : 0) +
        (evidence.length >= 5 ? 5 : 0),
      ),
    );
    const gaps: string[] = [];
    if (!evidence.length) gaps.push('No seed files matched the query.');
    if (relationTypes.size < 2) gaps.push('The code graph has few typed links for this area.');
    if (
      intent.expandedConcepts.some((concept) => ['upload', 'attachment', 'document', 'file'].includes(concept)) &&
      !hasApiChain
    ) {
      gaps.push('No frontend-to-backend API route match was proven; inspect dynamic URL construction.');
    }
    if (confidence < 80) gaps.push('Confidence below 80%; read top evidence and continue searching from discovered symbols.');
    if (timeLeft() <= 0) gaps.push('Investigation soft-deadline reached; continuing with partial evidence.');

    const result: InvestigationResult = {
      status: this.status(state),
      query,
      intent,
      confidence,
      evidence,
      trails,
      gaps,
    };
    this.stickySet(stickyKey, result);
    return result;
  }

  async related(rootInput: string, fileInput: string, limit = 16): Promise<RepositorySearchResult> {
    const root = normalizeRoot(rootInput);
    await this.ensure(root);
    const state = this.states.get(root)!;
    const rel = normalizeRelative(path.isAbsolute(fileInput) ? relative(root, fileInput) : fileInput);
    const source = state.documents.get(rel);
    if (!source) {
      return this.search(root, fileInput, limit);
    }

    const scores = new Map<string, { score: number; reason: string[] }>();
    const add = (targetPath: string, score: number, reason: string) => {
      const target = state.documents.get(normalizeRelative(targetPath));
      if (!target || target.key === source.key) return;
      const current = scores.get(target.key) || { score: 0, reason: [] };
      current.score += score;
      if (!current.reason.includes(reason)) current.reason.push(reason);
      scores.set(target.key, current);
    };
    for (const dep of source.dependencies) add(dep, 12, 'imported by source');
    for (const dependent of source.dependents) add(dependent, 14, 'imports source');

    const semantic = this.rank(state, `${source.path} ${source.symbols.join(' ')}`, limit * 2);
    for (const item of semantic) add(item.path, item.score * 0.35, 'shared symbols/context');

    const ranked = [...scores.entries()]
      .map(([filePath, value]) => ({ path: filePath, ...value }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(40, limit)));
    return {
      status: this.status(state),
      query: `related:${source.path}`,
      hits: ranked.map((item) =>
        this.toSearchHit(state, item.path, item.score, item.reason, source.symbols.slice(0, 8).join(' '))),
    };
  }

  async overview(rootInput: string): Promise<RepositoryOverview> {
    const root = normalizeRoot(rootInput);
    await this.ensure(root);
    const state = this.states.get(root)!;
    const languages = new Map<string, number>();
    const directories = new Map<string, number>();
    const entrypoints: string[] = [];

    for (const doc of state.documents.values()) {
      languages.set(doc.language, (languages.get(doc.language) || 0) + 1);
      const dir = doc.path.includes('/') ? doc.path.split('/').slice(0, 2).join('/') : '.';
      directories.set(dir, (directories.get(dir) || 0) + 1);
      if (/(^|\/)(index|main|app|server|cli|bootstrap)\.[^/]+$/i.test(doc.path) ||
          /(^|\/)(package\.json|pyproject\.toml|cargo\.toml|go\.mod)$/i.test(doc.path)) {
        entrypoints.push(doc.path);
      }
    }

    const hubs = [...state.documents.values()]
      .map((doc) => ({
        path: doc.path,
        dependencies: doc.dependencies.length,
        dependents: doc.dependents.length,
      }))
      .filter((hub) => hub.dependencies || hub.dependents)
      .sort((a, b) => (b.dependents * 2 + b.dependencies) - (a.dependents * 2 + a.dependencies))
      .slice(0, 20);

    return {
      status: this.status(state),
      languages: [...languages.entries()]
        .map(([language, files]) => ({ language, files }))
        .sort((a, b) => b.files - a.files)
        .slice(0, 20),
      topDirectories: [...directories.entries()]
        .map(([dirPath, files]) => ({ path: dirPath, files }))
        .sort((a, b) => b.files - a.files)
        .slice(0, 20),
      entrypoints: entrypoints.slice(0, 30),
      hubs,
    };
  }

  async refreshFiles(rootInput: string, filePaths: string[]): Promise<void> {
    const root = normalizeRoot(rootInput);
    await this.ensure(root);
    const state = this.states.get(root)!;
    for (const fileInput of filePaths) {
      const absolute = path.isAbsolute(fileInput) ? fileInput : path.join(root, fileInput);
      if (!isInsideRoot(root, absolute)) continue;
      const rel = normalizeRelative(relative(root, absolute));
      state.documents.delete(rel);
      const doc = await this.indexFile(root, absolute);
      if (doc) state.documents.set(doc.key, doc);
    }
    this.rebuildDerived(state);
    state.indexedAt = Date.now();
    this.invalidateSticky(root);
    this.persist(state);
  }

  private async build(state: IndexState): Promise<void> {
    const started = Date.now();
    state.phase = 'indexing';
    state.error = undefined;
    try {
      const discovered = await this.discover(state.root);
      const previous = state.documents;
      const next = new Map<string, IndexedDocument>();
      const pending: Array<{ absolute: string; stat: fs.Stats }> = [];

      for (const item of discovered) {
        const rel = normalizeRelative(relative(state.root, item.absolute));
        const cached = previous.get(rel);
        if (cached && cached.mtimeMs === item.stat.mtimeMs && cached.size === item.stat.size) {
          next.set(rel, cached);
        } else {
          pending.push(item);
        }
      }

      // Small parallel batches saturate SSD reads without flooding Electron's
      // shared node process on huge monorepos.
      for (let i = 0; i < pending.length; i += 64) {
        const docs = await Promise.all(
          pending.slice(i, i + 64).map((item) => this.indexFile(state.root, item.absolute, item.stat)),
        );
        for (const doc of docs) {
          if (doc) next.set(doc.key, doc);
        }
        if (i % 240 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      }

      state.documents = next;
      this.rebuildDerived(state);
      state.indexedAt = Date.now();
      state.elapsedMs = Date.now() - started;
      state.phase = 'ready';
      this.persist(state);
    } catch (error: any) {
      state.phase = state.documents.size ? 'ready' : 'error';
      state.error = String(error?.message || error);
      state.elapsedMs = Date.now() - started;
      if (!state.documents.size) throw error;
    } finally {
      state.build = undefined;
    }
  }

  private async discover(root: string): Promise<Array<{ absolute: string; stat: fs.Stats }>> {
    const candidates: string[] = [];
    let directories = [root];
    const ignored = gitIgnoreMatcher(root);

    // Traverse one breadth level at a time. Parallel directory reads are much
    // faster than thousands of serial Windows filesystem round trips.
    while (directories.length && candidates.length < MAX_FILES) {
      const nextDirectories: string[] = [];
      for (let offset = 0; offset < directories.length; offset += 32) {
        const batch = directories.slice(offset, offset + 32);
        const listings = await Promise.all(
          batch.map(async (dir) => {
            try {
              return { dir, entries: await fs.promises.readdir(dir, { withFileTypes: true }) };
            } catch {
              return { dir, entries: [] as fs.Dirent[] };
            }
          }),
        );
        for (const listing of listings) {
          for (const entry of listing.entries) {
            if (entry.isSymbolicLink()) continue;
            const absolute = path.join(listing.dir, entry.name);
            if (ignored(absolute, entry.isDirectory())) continue;
            if (entry.isDirectory()) {
              if (!SKIP_DIRS.has(entry.name.toLowerCase()) && !entry.name.startsWith('.')) {
                nextDirectories.push(absolute);
              }
            } else if (entry.isFile() && isIndexable(absolute)) {
              candidates.push(absolute);
              if (candidates.length >= MAX_FILES) break;
            }
          }
        }
      }
      directories = nextDirectories;
    }

    const files: Array<{ absolute: string; stat: fs.Stats }> = [];
    for (let offset = 0; offset < candidates.length; offset += 96) {
      const batch = candidates.slice(offset, offset + 96);
      const stats = await Promise.all(
        batch.map(async (absolute) => {
          try {
            return { absolute, stat: await fs.promises.stat(absolute) };
          } catch {
            return undefined;
          }
        }),
      );
      for (const item of stats) {
        if (item?.stat.isFile() && item.stat.size <= MAX_FILE_BYTES) files.push(item);
      }
    }
    return files;
  }

  private async indexFile(root: string, absolute: string, knownStat?: fs.Stats): Promise<IndexedDocument | undefined> {
    try {
      if (!isInsideRoot(root, absolute)) return undefined;
      if (!isIndexable(absolute)) return undefined;
      const stat = knownStat || await fs.promises.stat(absolute);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
      const text = await fs.promises.readFile(absolute, 'utf8');
      const indexText = text.length > MAX_INDEX_CHARS ? text.slice(0, MAX_INDEX_CHARS) : text;
      const rel = relative(root, absolute).replace(/\\/g, '/');
      const key = normalizeRelative(rel);
      return {
        path: rel,
        key,
        language: languageFor(absolute),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        lineCount: text.split(/\r?\n/).length,
        terms: termVector(indexText, rel),
        symbols: extractSymbols(indexText),
        imports: extractImports(indexText),
        calls: extractCalls(indexText),
        componentRefs: extractComponentRefs(indexText),
        apiCalls: extractApiCalls(indexText),
        routeDefs: extractRouteDefs(indexText),
        trigramSignature: buildTrigramSignature(`${rel}\n${indexText}`),
        occurrences: extractOccurrences(indexText),
        dependencies: [],
        dependents: [],
      };
    } catch {
      return undefined;
    }
  }

  private rebuildDerived(state: IndexState) {
    const documents = state.documents;
    const allKeys = new Set(documents.keys());
    const byStem = new Map<string, string[]>();
    for (const key of allKeys) {
      const stem = key.replace(/\.[^.\/]+$/, '');
      const list = byStem.get(stem) || [];
      list.push(key);
      byStem.set(stem, list);
    }

    for (const doc of documents.values()) {
      doc.dependencies = [];
      doc.dependents = [];
    }
    for (const doc of documents.values()) {
      for (const specifier of doc.imports) {
        const resolvedKey = this.resolveImport(doc.key, specifier, allKeys, byStem);
        if (resolvedKey && resolvedKey !== doc.key) {
          const target = documents.get(resolvedKey);
          if (!target) continue;
          if (!doc.dependencies.includes(target.path)) {
            doc.dependencies.push(target.path);
          }
          if (!target.dependents.includes(doc.path)) {
            target.dependents.push(doc.path);
          }
        }
      }
    }

    state.graph = new Map();
    const addEdge = (
      from: IndexedDocument,
      to: IndexedDocument,
      type: CodeRelationType,
      label: string,
      weight: number,
    ) => {
      if (from.key === to.key) return;
      const edges = state.graph.get(from.key) || [];
      const existing = edges.find((edge) => edge.to === to.key && edge.type === type);
      if (existing) {
        existing.weight = Math.max(existing.weight, weight);
        return;
      }
      edges.push({ to: to.key, type, label, weight });
      state.graph.set(from.key, edges);
    };

    for (const doc of documents.values()) {
      for (const dependencyPath of doc.dependencies) {
        const target = documents.get(normalizeRelative(dependencyPath));
        if (!target) continue;
        addEdge(doc, target, 'imports', `imports ${path.basename(target.path)}`, 1);
        addEdge(target, doc, 'imported_by', `imported by ${path.basename(doc.path)}`, 0.88);
      }
    }

    const symbolOwners = new Map<string, IndexedDocument[]>();
    for (const doc of documents.values()) {
      for (const symbol of doc.symbols) {
        const key = symbol.toLowerCase();
        const owners = symbolOwners.get(key) || [];
        owners.push(doc);
        symbolOwners.set(key, owners);
      }
    }
    for (const doc of documents.values()) {
      const importedKeys = new Set(doc.dependencies.map((dependency) => normalizeRelative(dependency)));
      for (const call of doc.calls) {
        const owners = symbolOwners.get(call.toLowerCase()) || [];
        // Symbols defined in many files (render, main, init…) create O(n²)
        // noise edges that slow traversal without adding signal.
        if (owners.length > 12) continue;
        for (const owner of owners) {
          const importedOwner = importedKeys.has(owner.key);
          addEdge(
            doc,
            owner,
            'calls',
            `calls ${call}${importedOwner ? ' from imported module' : ''}`,
            importedOwner ? 1.12 : 0.72,
          );
          addEdge(owner, doc, 'called_by', `${call} called by ${path.basename(doc.path)}`, 0.78);
        }
      }
      for (const component of doc.componentRefs) {
        for (const owner of symbolOwners.get(component.toLowerCase()) || []) {
          addEdge(doc, owner, 'renders', `renders <${component}>`, 0.98);
          addEdge(owner, doc, 'rendered_by', `rendered by ${path.basename(doc.path)}`, 0.8);
        }
      }
    }

    const routeOwners: Array<{ endpoint: string; doc: IndexedDocument }> = [];
    for (const doc of documents.values()) {
      for (const endpoint of doc.routeDefs) routeOwners.push({ endpoint, doc });
    }
    for (const doc of documents.values()) {
      for (const apiCall of doc.apiCalls) {
        const matches = routeOwners.filter(
          (route) =>
            route.endpoint === apiCall ||
            route.endpoint.endsWith(apiCall) ||
            apiCall.endsWith(route.endpoint),
        );
        for (const route of matches.slice(0, 12)) {
          addEdge(doc, route.doc, 'api_calls', `API ${apiCall}`, 1.15);
          addEdge(route.doc, doc, 'api_handles', `handles ${apiCall}`, 0.92);
        }
      }
    }

    const modules = new Map<string, IndexedDocument[]>();
    for (const doc of documents.values()) {
      const dir = path.posix.dirname(doc.path);
      const siblings = modules.get(dir) || [];
      siblings.push(doc);
      modules.set(dir, siblings);
    }
    for (const siblings of modules.values()) {
      if (siblings.length < 2 || siblings.length > 24) continue;
      for (const source of siblings) {
        for (const target of siblings) {
          addEdge(source, target, 'same_module', 'same feature folder', 0.42);
        }
      }
    }

    const symbolTables = buildSymbolTables(
      [...documents.values()].map((doc) => ({
        key: doc.key,
        path: doc.path,
        occurrences: doc.occurrences,
      })),
    );
    state.symbolDefinitions = symbolTables.definitions;
    state.symbolReferences = symbolTables.references;

    state.inverted = new Map();
    state.basenameIndex = new Map();
    state.pathTokenIndex = new Map();
    for (const doc of documents.values()) {
      for (const [term, frequency] of Object.entries(doc.terms)) {
        let postings = state.inverted.get(term);
        if (!postings) {
          postings = new Map();
          state.inverted.set(term, postings);
        }
        postings.set(doc.key, frequency);
      }
      const base = path.basename(doc.path).toLowerCase();
      const baseList = state.basenameIndex.get(base) || [];
      baseList.push(doc.key);
      state.basenameIndex.set(base, baseList);
      const stem = base.replace(/\.[^.]+$/, '');
      if (stem !== base) {
        const stemList = state.basenameIndex.get(stem) || [];
        stemList.push(doc.key);
        state.basenameIndex.set(stem, stemList);
      }
      for (const token of pathTokens(doc.path)) {
        if (token.length < 2) continue;
        const list = state.pathTokenIndex.get(token) || [];
        list.push(doc.key);
        state.pathTokenIndex.set(token, list);
      }
    }
  }

  private resolveImport(
    sourcePath: string,
    specifier: string,
    allPaths: Set<string>,
    byStem: Map<string, string[]>,
  ): string | undefined {
    if (!specifier || (!specifier.startsWith('.') && !specifier.startsWith('/'))) return undefined;
    const base = normalizeRelative(
      path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), specifier.replace(/\\/g, '/'))),
    );
    if (allPaths.has(base)) return base;
    const stemMatches = byStem.get(base);
    if (stemMatches?.length === 1) return stemMatches[0];
    for (const candidate of [
      `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`,
      `${base}.json`, `${base}.py`, `${base}.go`, `${base}.rs`,
      `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.jsx`,
    ]) {
      if (allPaths.has(candidate)) return candidate;
    }
    return undefined;
  }

  private rankCache = new Map<string, Array<{ path: string; score: number; reason: string[] }>>();

  private rank(
    state: IndexState,
    query: string,
    limit: number,
  ): Array<{ path: string; score: number; reason: string[] }> {
    // Memoize per index generation: repeated agent turns and BFS clue lookups
    // often re-rank identical queries.
    const cacheKey = `${state.root}|${state.indexedAt || 0}|${limit}|${query.slice(0, 400)}`;
    const cached = this.rankCache.get(cacheKey);
    if (cached) return cached;

    const result = this.rankUncached(state, query, limit);
    if (this.rankCache.size > 300) {
      const oldest = this.rankCache.keys().next().value;
      if (oldest !== undefined) this.rankCache.delete(oldest);
    }
    this.rankCache.set(cacheKey, result);
    return result;
  }

  private rankUncached(
    state: IndexState,
    query: string,
    limit: number,
  ): Array<{ path: string; score: number; reason: string[] }> {
    const queryTerms = [...new Set(tokenize(query))];
    const phrases = extractModulePhrases(query);
    const scores = new Map<string, { score: number; reason: string[] }>();
    const documentCount = Math.max(1, state.documents.size);

    for (const term of queryTerms) {
      const postings = state.inverted.get(term);
      if (!postings) continue;
      const idf = Math.log(1 + (documentCount - postings.size + 0.5) / (postings.size + 0.5));
      for (const [fileKey, frequency] of postings) {
        const current = scores.get(fileKey) || { score: 0, reason: [] };
        current.score += idf * ((frequency * 2.2) / (frequency + 1.2));
        if (current.reason.length < 5 && !current.reason.includes(term)) current.reason.push(term);
        scores.set(fileKey, current);
      }
    }

    // Extreme: path/symbol boosts only on BM25 candidates + path-token hits — never full corpus.
    const boostKeys = new Set<string>(scores.keys());
    for (const term of queryTerms) {
      for (const key of state.pathTokenIndex.get(term) || []) boostKeys.add(key);
      for (const key of state.basenameIndex.get(term) || []) boostKeys.add(key);
    }
    const preparedRankPhrases = (phrases.length ? phrases : [query])
      .map((phrase) => preparePhrase(phrase))
      .filter((prepared): prepared is PreparedPhrase => !!prepared);
    for (const prepared of preparedRankPhrases) {
      for (const token of prepared.tokens) {
        for (const key of state.pathTokenIndex.get(token) || []) boostKeys.add(key);
      }
    }

    const lowerQuery = query.toLowerCase();
    for (const fileKey of boostKeys) {
      const doc = state.documents.get(fileKey);
      if (!doc) continue;
      const current = scores.get(doc.key) || { score: 0, reason: [] };
      const info = docPathInfo(doc.path);
      const base = path.basename(doc.path).toLowerCase();
      const full = info.lower;
      if (lowerQuery.includes(base) || queryTerms.some((term) => base.includes(term) || full.includes(term))) {
        current.score += 8;
        if (!current.reason.includes('path match')) current.reason.unshift('path match');
      }
      // Recency boost — recently touched files rank higher (Cursor-class).
      if (doc.mtimeMs && state.indexedAt) {
        const ageHours = Math.max(0, (state.indexedAt - doc.mtimeMs) / 3_600_000);
        if (ageHours < 24) current.score += 6;
        else if (ageHours < 168) current.score += 2;
      }
      if (/frontend|src\/app|components?\//i.test(doc.path)) current.score += 3;
      for (const prepared of preparedRankPhrases) {
        const pathHit = modulePathScorePrepared(info, prepared);
        if (pathHit) {
          current.score += pathHit.score;
          if (!current.reason.includes(pathHit.reason)) current.reason.unshift(pathHit.reason);
        }
      }
      const symbolMatches = doc.symbols.filter((symbol) => {
        const lower = symbol.toLowerCase();
        const compact = lower.replace(/[^a-z0-9]/g, '');
        return queryTerms.some(
          (term) => lower.includes(term) || compact.includes(term.replace(/[^a-z0-9]/g, '')),
        );
      });
      if (symbolMatches.length) {
        current.score += Math.min(16, symbolMatches.length * 3);
        current.reason.unshift(`symbols: ${symbolMatches.slice(0, 4).join(', ')}`);
      }
      if (current.score > 0) scores.set(doc.key, current);
    }

    const lexical = [...scores.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit * 2);
    for (const [fileKey, source] of lexical) {
      const doc = state.documents.get(fileKey);
      if (!doc) continue;
      for (const connectedPath of doc.dependencies) {
        const connected = state.documents.get(normalizeRelative(connectedPath));
        if (!connected) continue;
        const current = scores.get(connected.key) || { score: 0, reason: [] };
        current.score += source.score * 0.18;
        if (!current.reason.includes('dependency neighbor')) current.reason.push('dependency neighbor');
        scores.set(connected.key, current);
      }
      for (const connectedPath of doc.dependents) {
        const connected = state.documents.get(normalizeRelative(connectedPath));
        if (!connected) continue;
        const current = scores.get(connected.key) || { score: 0, reason: [] };
        current.score += source.score * 0.24;
        if (!current.reason.includes('reverse dependency')) current.reason.push('reverse dependency');
        scores.set(connected.key, current);
      }
    }

    return [...scores.entries()]
      .map(([fileKey, value]) => ({ path: fileKey, ...value }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private toSearchHit(
    state: IndexState,
    fileKey: string,
    score: number,
    reason: string[],
    query: string,
    withExcerpt = true,
  ): RepositorySearchHit {
    const doc = state.documents.get(fileKey) || state.documents.get(normalizeRelative(fileKey));
    if (!doc) {
      return {
        path: fileKey,
        score: Math.round(score * 100) / 100,
        language: '',
        reason: reason.slice(0, 6),
        symbols: [],
        excerpt: '',
        dependencies: [],
        dependents: [],
      };
    }
    return {
      path: doc.path,
      score: Math.round(score * 100) / 100,
      language: doc.language,
      reason: reason.slice(0, 6),
      symbols: doc.symbols.slice(0, 20),
      excerpt: withExcerpt ? this.excerpt(state.root, doc.path, query) : '',
      dependencies: doc.dependencies.slice(0, 10),
      dependents: doc.dependents.slice(0, 10),
    };
  }

  private excerpt(root: string, filePath: string, query: string): string {
    try {
      const text = fs.readFileSync(path.join(root, filePath), 'utf8');
      const lines = text.split(/\r?\n/);
      const terms = tokenize(query).filter((term) => !term.includes('_')).slice(0, 8);
      let bestLine = 0;
      let bestScore = -1;
      const scanLimit = Math.min(lines.length, 4_000);
      for (let i = 0; i < scanLimit; i++) {
        const lower = lines[i].toLowerCase();
        let score = 0;
        for (const term of terms) if (lower.includes(term)) score++;
        if (score > bestScore) {
          bestScore = score;
          bestLine = i;
          if (terms.length && score >= terms.length) break;
        }
      }
      const start = Math.max(0, bestLine - 2);
      return lines
        .slice(start, Math.min(lines.length, start + 8))
        .map((line, index) => `${start + index + 1}|${line.slice(0, 200)}`)
        .join('\n');
    } catch {
      return '';
    }
  }

  private documentConceptScore(doc: IndexedDocument, concepts: string[]): number {
    const pathAndSymbols = `${doc.path} ${doc.symbols.join(' ')} ${doc.calls.join(' ')} ${
      doc.componentRefs.join(' ')
    } ${doc.apiCalls.join(' ')} ${doc.routeDefs.join(' ')}`.toLowerCase();
    let score = 0;
    for (const concept of concepts) {
      if (pathAndSymbols.includes(concept.toLowerCase())) score++;
    }
    return score;
  }

  private evidenceReasons(doc: IndexedDocument, concepts: string[]): string[] {
    const reasons: string[] = [];
    const haystack = `${doc.path} ${doc.symbols.join(' ')} ${doc.calls.join(' ')}`.toLowerCase();
    const matched = concepts.filter((concept) => haystack.includes(concept.toLowerCase())).slice(0, 6);
    if (matched.length) reasons.push(`concepts: ${matched.join(', ')}`);
    if (doc.componentRefs.length) reasons.push(`renders: ${doc.componentRefs.slice(0, 5).join(', ')}`);
    if (doc.apiCalls.length) reasons.push(`calls API: ${doc.apiCalls.slice(0, 4).join(', ')}`);
    if (doc.routeDefs.length) reasons.push(`handles API: ${doc.routeDefs.slice(0, 4).join(', ')}`);
    return reasons;
  }

  private status(state: IndexState): RepositoryIndexStatus {
    let symbols = 0;
    for (const doc of state.documents.values()) {
      symbols += doc.symbols.length;
    }
    const edges = [...state.graph.values()].reduce((total, links) => total + links.length, 0);
    return {
      root: state.root,
      state: state.phase,
      files: state.documents.size,
      symbols,
      edges,
      indexedAt: state.indexedAt,
      elapsedMs: state.elapsedMs,
      error: state.error,
    };
  }

  private loadCache(state: IndexState): boolean {
    try {
      const saved = JSON.parse(fs.readFileSync(cachePath(state.root), 'utf8')) as PersistedIndex;
      if (saved.version !== INDEX_VERSION || normalizeRoot(saved.root) !== state.root || !saved.documents?.length) {
        return false;
      }
      state.documents = new Map(
        saved.documents.map((doc) => {
          const key = doc.key || normalizeRelative(doc.path);
          return [key, { ...doc, key, path: doc.path || key }];
        }),
      );
      state.indexedAt = saved.indexedAt;
      state.phase = 'ready';
      this.rebuildDerived(state);
      return true;
    } catch {
      return false;
    }
  }

  private persist(state: IndexState) {
    const payload: PersistedIndex = {
      version: INDEX_VERSION,
      root: state.root,
      indexedAt: state.indexedAt || Date.now(),
      documents: [...state.documents.values()],
    };
    void fs.promises.mkdir(CACHE_DIR, { recursive: true })
      .then(() => fs.promises.writeFile(cachePath(state.root), JSON.stringify(payload)))
      .catch(() => undefined);
  }
}

let sharedRepositoryIndex: RepositoryIndexService | null = null;

/** Process-wide index so chat warmup and the Cline orchestrator share one cache. */
export function getSharedRepositoryIndex(): RepositoryIndexService {
  if (!sharedRepositoryIndex) {
    sharedRepositoryIndex = new RepositoryIndexService();
  }
  return sharedRepositoryIndex;
}
