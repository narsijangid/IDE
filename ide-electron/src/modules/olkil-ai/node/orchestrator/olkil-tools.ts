import * as path from 'path';
import { spawnSync } from 'child_process';
import { getSharedRepositoryIndex } from '../repository-index.service';
import { ripgrepSearch } from '../ripgrep';
import { findGitRoot } from './environment';
import { findReferencePattern } from './pattern-finder';
import type { SessionState } from './session-state';
import type { ToolResultCache } from './tool-cache';

type OlkilTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: any, context: any) => Promise<any>;
  timeoutMs?: number;
  retryable?: boolean;
  maxRetries?: number;
};

function jsonSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function clip(value: unknown, max = 8_000): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated]`;
}

export function createOlkilIntelligenceTools(opts: {
  cwd: string;
  cache: ToolResultCache;
  session: SessionState;
  mode: 'agent' | 'plan' | 'ask';
}): OlkilTool[] {
  const { cwd, cache, session } = opts;
  const index = getSharedRepositoryIndex();

  const tools: OlkilTool[] = [
    {
      name: 'repository_search',
      description:
        'Fast ranked repository search (symbols + path + imports + text). Use instead of repeating search_codebase for the same concept. Independent queries should be parallel tool calls in one turn.',
      inputSchema: jsonSchema(
        {
          query: { type: 'string', description: 'Feature, symbol, or behavior to locate' },
          max_results: { type: 'integer' },
        },
        ['query'],
      ),
      timeoutMs: 12_000,
      retryable: true,
      maxRetries: 1,
      execute: async (input) => {
        const query = String(input?.query || '');
        session.noteSearch(query);
        const cached = cache.getSearch(cwd, `repo:${query}`);
        if (cached) return cached;
        const result = await index.search(cwd, query, Math.min(16, Number(input?.max_results) || 10));
        const text = clip(
          result.hits.map((h) => `${Math.round(h.score)} ${h.path} :: ${h.reason.slice(0, 3).join('; ')} [${h.symbols.slice(0, 6).join(', ')}]`),
        );
        cache.setSearch(cwd, `repo:${query}`, text);
        return text;
      },
    },
    {
      name: 'exact_code_search',
      description:
        'Exact substring search (ripgrep). Use for UI labels, field names, error strings. Prefer multiple parallel calls over sequential repeats.',
      inputSchema: jsonSchema({ query: { type: 'string' }, max_results: { type: 'integer' } }, ['query']),
      timeoutMs: 8_000,
      retryable: true,
      maxRetries: 1,
      execute: async (input) => {
        const query = String(input?.query || '');
        session.noteSearch(query);
        const cached = cache.getSearch(cwd, `exact:${query}`);
        if (cached) return cached;
        const rg = await ripgrepSearch(cwd, query, { maxResults: Math.min(40, Number(input?.max_results) || 20) });
        const text = clip(
          rg.matches.slice(0, 24).map((m) => `${m.path}:L${m.line}: ${m.text.slice(0, 180)}`),
        );
        cache.setSearch(cwd, `exact:${query}`, text);
        return text || 'No matches.';
      },
    },
    {
      name: 'goto_definition',
      description: 'Find definitions of a function, class, component, type, or constant.',
      inputSchema: jsonSchema({ symbol: { type: 'string' }, max_results: { type: 'integer' } }, ['symbol']),
      timeoutMs: 8_000,
      execute: async (input) => {
        const symbol = String(input?.symbol || '');
        session.noteSearch(`def:${symbol}`);
        const result = await index.symbolDefinitions(cwd, symbol, Number(input?.max_results) || 12);
        return clip(result.hits.map((h) => `${h.kind} ${h.name} ${h.path}:L${h.line}`));
      },
    },
    {
      name: 'find_references',
      description: 'Find references/usages of a symbol. Use after goto_definition.',
      inputSchema: jsonSchema({ symbol: { type: 'string' }, max_results: { type: 'integer' } }, ['symbol']),
      timeoutMs: 8_000,
      execute: async (input) => {
        const symbol = String(input?.symbol || '');
        session.noteSearch(`ref:${symbol}`);
        const result = await index.symbolReferences(cwd, symbol, Number(input?.max_results) || 24);
        return clip(result.hits.map((h) => `${h.role} ${h.name} ${h.path}:L${h.line}`));
      },
    },
    {
      name: 'find_module',
      description: 'Locate a named feature/module folder by fuzzy name. Use first when the user names a module.',
      inputSchema: jsonSchema({ query: { type: 'string' }, max_results: { type: 'integer' } }, ['query']),
      timeoutMs: 8_000,
      execute: async (input) => {
        const query = String(input?.query || '');
        session.noteSearch(`mod:${query}`);
        const result = await index.findModules(cwd, query, Number(input?.max_results) || 12);
        return clip(result.hits.map((h) => `${h.path} (${h.reason.slice(0, 2).join('; ')})`));
      },
    },
    {
      name: 'investigate_codepath',
      description:
        'Multi-hop evidence pack: seeds + imports + calls + API trails. Use ONCE when the evidence pack is still thin. Do not loop this tool.',
      inputSchema: jsonSchema({ query: { type: 'string' }, max_evidence: { type: 'integer' } }, ['query']),
      timeoutMs: 14_000,
      execute: async (input) => {
        const query = String(input?.query || '');
        session.noteSearch(`inv:${query}`);
        const inv = await index.investigate(cwd, query, Math.min(28, Number(input?.max_evidence) || 18));
        const pattern = findReferencePattern({
          terms: query.split(/\s+/).slice(0, 6),
          files: inv.evidence.map((e) => ({
            path: e.path,
            score: e.score,
            reason: e.reasons,
            symbols: e.symbols,
            excerpt: e.excerpt,
          })),
        });
        return clip({
          confidence: inv.confidence,
          trails: inv.trails.slice(0, 6),
          evidence: inv.evidence.slice(0, 14).map((e) => ({
            path: e.path,
            score: Math.round(e.score),
            via: e.via,
            reasons: e.reasons.slice(0, 3),
            symbols: e.symbols.slice(0, 6),
          })),
          reference: pattern,
        });
      },
    },
    {
      name: 'related_files',
      description: 'Files connected by imports, reverse deps, and shared symbols.',
      inputSchema: jsonSchema({ path: { type: 'string' }, max_results: { type: 'integer' } }, ['path']),
      timeoutMs: 8_000,
      execute: async (input) => {
        const filePath = String(input?.path || '');
        const result = await index.related(cwd, filePath, Number(input?.max_results) || 12);
        return clip(result.hits.map((h) => `${h.path} :: ${h.reason.slice(0, 3).join('; ')}`));
      },
    },
    {
      name: 'git_info',
      description:
        'Read git status, diff, log, or file history from the REAL repository root (walks up from the workspace; never assume the IDE folder is the git root).',
      inputSchema: jsonSchema({
        action: {
          type: 'string',
          description: 'status | diff | log | file_log | blame',
        },
        path: { type: 'string', description: 'Optional file path for file_log/blame/diff' },
        max_lines: { type: 'integer' },
      }),
      timeoutMs: 8_000,
      retryable: false,
      execute: async (input) => {
        const gitRoot = findGitRoot(cwd);
        if (!gitRoot) {
          return 'No git repository found by walking up from the workspace. Do not retry git in a random parent.';
        }
        const action = String(input?.action || 'status');
        const max = Math.min(80, Number(input?.max_lines) || 40);
        const rel = input?.path
          ? path.relative(gitRoot, path.isAbsolute(input.path) ? input.path : path.resolve(cwd, input.path))
          : '';
        const args =
          action === 'diff'
            ? ['--no-pager', 'diff', '--', rel || '.']
            : action === 'log'
              ? ['--no-pager', 'log', '-12', '--oneline']
              : action === 'file_log'
                ? ['--no-pager', 'log', '-8', '--oneline', '--', rel || '.']
                : action === 'blame' && rel
                  ? ['--no-pager', 'blame', '-L', '1,80', '--', rel]
                  : ['--no-pager', 'status', '--short'];
        const result = spawnSync('git', ['-C', gitRoot, ...args], {
          encoding: 'utf8',
          timeout: 4000,
          windowsHide: true,
        });
        const out = (result.stdout || result.stderr || '').split(/\r?\n/).slice(0, max).join('\n');
        return `gitRoot=${gitRoot}\n${out || '(clean)'}`;
      },
    },
  ];

  return tools;
}
