import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { getSharedRepositoryIndex } from '../repository-index.service';
import { ripgrepSearch } from '../ripgrep';
import { buildCompactContext } from './context-builder';
import { findGitRoot } from './environment';
import { findReferencePattern } from './pattern-finder';
import { extractTaskTerms } from './task-router';
import type {
  ActivitySink,
  CompactEvidence,
  CompactTaskContext,
  TaskRoute,
} from './types';

export interface ExploreInput {
  prompt: string;
  workspaceRoot: string;
  activeFile?: string;
  route: TaskRoute;
  envText?: string;
  signal?: AbortSignal;
  onActivity?: ActivitySink;
}

function aborted(signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted);
}

function emit(onActivity: ActivitySink | undefined, event: Parameters<ActivitySink>[0]) {
  try {
    onActivity?.(event);
  } catch {
    // UI must never break retrieval
  }
}

function finish(onActivity: ActivitySink | undefined, id: string, label: string, extra?: Partial<Parameters<ActivitySink>[0]>) {
  emit(onActivity, { id, kind: extra?.kind || 'searching', label, done: true, ...extra });
}

export async function parallelExplore(input: ExploreInput): Promise<CompactTaskContext> {
  const { prompt, workspaceRoot, route, signal } = input;
  const index = getSharedRepositoryIndex();
  const groupId = 'explore_root';
  const terms = extractTaskTerms(prompt);
  const searches = new Set<string>();
  const files = new Map<string, CompactEvidence>();
  let searchCount = 0;

  emit(input.onActivity, {
    id: groupId,
    kind: 'searching',
    label: 'Exploring repository',
    done: false,
    groupId,
    filesExplored: 0,
    searchCount: 0,
  });

  const noteFile = (ev: CompactEvidence) => {
    const key = ev.path.replace(/\\/g, '/').toLowerCase();
    const current = files.get(key);
    if (!current || ev.score > current.score) {
      files.set(key, ev);
    } else {
      current.reason = [...new Set([...current.reason, ...ev.reason])].slice(0, 6);
      current.symbols = [...new Set([...current.symbols, ...ev.symbols])].slice(0, 16);
      current.score = Math.max(current.score, ev.score);
      if (!current.excerpt && ev.excerpt) current.excerpt = ev.excerpt;
    }
  };

  await index.ensure(workspaceRoot).catch(() => undefined);
  if (aborted(signal)) {
    return emptyContext(input, 0, 0);
  }

  const searchTerms = terms.slice(0, route.maxPrefetchSearches);
  if (!searchTerms.length) {
    searchTerms.push(prompt.slice(0, 80));
  }

  const jobs: Array<Promise<void>> = [];

  jobs.push(
    (async () => {
      const id = 'explore_modules';
      emit(input.onActivity, {
        id,
        kind: 'searching',
        label: 'Finding likely modules',
        parentId: groupId,
        groupId,
      });
      searches.add(prompt);
      searchCount += 1;
      const result = await index.findModules(workspaceRoot, prompt, 10);
      for (const hit of result.hits) {
        noteFile({
          path: hit.path,
          score: hit.score,
          reason: hit.reason,
          symbols: hit.symbols,
          excerpt: hit.excerpt,
        });
      }
      finish(input.onActivity, id, 'Found likely modules', {
        kind: 'searching',
        parentId: groupId,
        groupId,
        resultPreview: result.hits.slice(0, 6).map((h) => h.path).join('\n'),
      });
    })(),
  );

  jobs.push(
    (async () => {
      const id = 'explore_semantic';
      emit(input.onActivity, {
        id,
        kind: 'searching',
        label: `Searching “${prompt.slice(0, 36)}”`,
        parentId: groupId,
        groupId,
      });
      searches.add(prompt);
      searchCount += 1;
      const result = await index.search(workspaceRoot, prompt, route.maxPrefetchFiles);
      for (const hit of result.hits) {
        noteFile({
          path: hit.path,
          score: hit.score,
          reason: hit.reason,
          symbols: hit.symbols,
          excerpt: hit.excerpt,
        });
      }
      finish(input.onActivity, id, `Explored “${prompt.slice(0, 36)}”`, {
        kind: 'searching',
        parentId: groupId,
        groupId,
        resultPreview: result.hits.slice(0, 8).map((h) => h.path).join('\n'),
      });
    })(),
  );

  for (const term of searchTerms.slice(0, 6)) {
    jobs.push(
      (async () => {
        const id = `explore_grep_${hash(term)}`;
        emit(input.onActivity, {
          id,
          kind: 'searching',
          label: `Searching for “${term.slice(0, 40)}”`,
          parentId: groupId,
          groupId,
        });
        searches.add(term);
        searchCount += 1;
        const rg = await ripgrepSearch(workspaceRoot, term, {
          maxResults: 24,
          timeoutMs: Math.min(1800, route.prefetchBudgetMs),
        });
        const byFile = new Map<string, { count: number; line: number; text: string }>();
        for (const match of rg.matches) {
          const key = match.path.replace(/\\/g, '/');
          const cur = byFile.get(key);
          if (!cur) byFile.set(key, { count: 1, line: match.line, text: match.text });
          else cur.count += 1;
        }
        for (const [filePath, info] of byFile) {
          noteFile({
            path: filePath,
            score: 80 + Math.min(20, info.count * 3),
            reason: [`exact “${term}” ×${info.count}`],
            symbols: [],
            excerpt: `${info.line}|${info.text.slice(0, 180)}`,
            line: info.line,
          });
        }
        finish(input.onActivity, id, `Searched for “${term.slice(0, 40)}”`, {
          kind: 'searching',
          parentId: groupId,
          groupId,
          resultPreview: [...byFile.keys()].slice(0, 8).join('\n'),
        });
      })(),
    );

    jobs.push(
      (async () => {
        const id = `explore_sym_${hash(term)}`;
        emit(input.onActivity, {
          id,
          kind: 'searching',
          label: `Searching references “${term.slice(0, 36)}”`,
          parentId: groupId,
          groupId,
        });
        searchCount += 1;
        const [defs, refs] = await Promise.all([
          index.symbolDefinitions(workspaceRoot, term, 8),
          index.symbolReferences(workspaceRoot, term, 12),
        ]);
        for (const hit of [...defs.hits, ...refs.hits]) {
          noteFile({
            path: hit.path,
            score: hit.score,
            reason: [`${hit.role} ${hit.name}`],
            symbols: [hit.name],
            line: hit.line,
          });
        }
        finish(input.onActivity, id, `Searched references “${term.slice(0, 36)}”`, {
          kind: 'searching',
          parentId: groupId,
          groupId,
          resultPreview: defs.hits
            .slice(0, 6)
            .map((h) => `${h.name} ${h.path}:L${h.line}`)
            .join('\n'),
        });
      })(),
    );
  }

  if (route.allowDeepInvestigate) {
    jobs.push(
      (async () => {
        const id = 'explore_investigate';
        emit(input.onActivity, {
          id,
          kind: 'searching',
          label: 'Inspecting existing implementation',
          parentId: groupId,
          groupId,
        });
        searchCount += 1;
        const inv = await index.investigate(workspaceRoot, prompt, Math.min(24, route.maxPrefetchFiles + 8));
        for (const ev of inv.evidence) {
          noteFile({
            path: ev.path,
            score: ev.score,
            reason: ev.reasons,
            symbols: ev.symbols,
            excerpt: ev.excerpt,
          });
        }
        finish(input.onActivity, id, 'Inspected existing implementation', {
          kind: 'searching',
          parentId: groupId,
          groupId,
          resultPreview: inv.evidence.slice(0, 8).map((e) => e.path).join('\n'),
        });
      })(),
    );
  }

  if (input.activeFile) {
    jobs.push(
      (async () => {
        const rel = path.relative(workspaceRoot, input.activeFile!).replace(/\\/g, '/');
        const id = 'explore_related';
        emit(input.onActivity, {
          id,
          kind: 'searching',
          label: `Checking related files for ${path.basename(input.activeFile!)}`,
          parentId: groupId,
          groupId,
          filePath: input.activeFile,
        });
        searchCount += 1;
        const related = await index.related(workspaceRoot, rel, 8);
        for (const hit of related.hits) {
          noteFile({
            path: hit.path,
            score: hit.score * 0.8,
            reason: ['related to active file', ...hit.reason],
            symbols: hit.symbols,
          });
        }
        finish(input.onActivity, id, `Checked related files for ${path.basename(input.activeFile!)}`, {
          kind: 'searching',
          parentId: groupId,
          groupId,
          filePath: input.activeFile,
        });
      })(),
    );
  }

  jobs.push(
    (async () => {
      const gitRoot = findGitRoot(workspaceRoot);
      if (!gitRoot) return;
      const id = 'explore_git';
      emit(input.onActivity, {
        id,
        kind: 'running',
        label: 'Checking git status',
        parentId: groupId,
        groupId,
        command: 'git status --short',
      });
      searchCount += 1;
      const status = gitShort(gitRoot);
      finish(input.onActivity, id, 'Checked git status', {
        kind: 'running',
        parentId: groupId,
        groupId,
        command: 'git status --short',
        resultPreview: status.slice(0, 400),
      });
    })(),
  );

  const budget = new Promise<void>((resolve) => {
    setTimeout(resolve, route.prefetchBudgetMs);
  });
  await Promise.race([Promise.allSettled(jobs), budget]);

  const ranked = [...files.values()].sort((a, b) => b.score - a.score);
  const top = ranked.slice(0, route.maxPrefetchFiles);

  const readJobs = top.slice(0, Math.min(6, route.maxPrefetchFiles)).map(async (file, idx) => {
    if (aborted(signal)) return;
    const abs = path.isAbsolute(file.path) ? file.path : path.join(workspaceRoot, file.path);
    const range = inferRange(file);
    const id = `explore_read_${idx}`;
    const base = path.basename(file.path);
    const rangeLabel = range ? ` L${range.start}-L${range.end}` : '';
    emit(input.onActivity, {
      id,
      kind: 'reading',
      label: `Reading ${base}${rangeLabel}`,
      parentId: groupId,
      groupId,
      filePath: abs,
      lineRange: range ? `L${range.start}-L${range.end}` : undefined,
    });
    const excerpt = readRange(abs, range);
    if (excerpt) file.excerpt = excerpt;
    finish(input.onActivity, id, `Read ${base}${rangeLabel}`, {
      kind: 'reading',
      parentId: groupId,
      groupId,
      filePath: abs,
      lineRange: range ? `L${range.start}-L${range.end}` : undefined,
      resultPreview: excerpt.slice(0, 400),
    });
  });
  await Promise.allSettled(readJobs);

  const reference = findReferencePattern({ terms, files: top });
  const backend = top.filter((f) => /backend|server|api|controller|service/i.test(f.path)).map((f) => f.path);
  const frontend = top.filter((f) => /frontend|component|src\/app|views?\//i.test(f.path)).map((f) => f.path);
  const gitRoot = findGitRoot(workspaceRoot);
  const git = gitRoot ? gitShort(gitRoot).slice(0, 500) : undefined;

  const ctx = buildCompactContext({
    task: prompt,
    size: route.size,
    files: top,
    symbols: collectSymbols(top),
    reference,
    backend,
    frontend,
    constraints: [
      'Prefer adapting the reference implementation instead of inventing a new architecture.',
      'Read only remaining unknown ranges. Do not reload files already excerpted here.',
      route.promptHint,
    ],
    git,
    environment: input.envText,
    maxChars: route.maxContextChars,
    filesExplored: files.size,
    searches: searchCount,
  });

  emit(input.onActivity, {
    id: groupId,
    kind: 'searching',
    label: `Explored ${ctx.filesExplored} files, ${ctx.searches} searches`,
    done: true,
    groupId,
    filesExplored: ctx.filesExplored,
    searchCount: ctx.searches,
  });

  return ctx;
}

function emptyContext(input: ExploreInput, files: number, searches: number): CompactTaskContext {
  return buildCompactContext({
    task: input.prompt,
    size: input.route.size,
    files: [],
    maxChars: input.route.maxContextChars,
    filesExplored: files,
    searches,
  });
}

function inferRange(file: CompactEvidence): { start: number; end: number } | undefined {
  if (file.line && file.line > 0) {
    return { start: Math.max(1, file.line - 25), end: file.line + 40 };
  }
  const m = String(file.excerpt || '').match(/^(\d+)\|/);
  if (m) {
    const line = Number(m[1]);
    return { start: Math.max(1, line - 25), end: line + 40 };
  }
  return undefined;
}

function readRange(absPath: string, range?: { start: number; end: number }): string {
  try {
    const text = fs.readFileSync(absPath, 'utf8');
    const lines = text.split(/\r?\n/);
    const start = range ? Math.max(1, range.start) : 1;
    const end = range ? Math.min(lines.length, range.end) : Math.min(lines.length, 80);
    return lines
      .slice(start - 1, end)
      .map((line, i) => `${start + i}|${line.slice(0, 220)}`)
      .join('\n');
  } catch {
    return '';
  }
}

function collectSymbols(files: CompactEvidence[]): CompactTaskContext['relevantSymbols'] {
  const out: CompactTaskContext['relevantSymbols'] = [];
  for (const file of files) {
    for (const name of file.symbols.slice(0, 4)) {
      out.push({
        name,
        kind: 'symbol',
        path: file.path,
        line: file.line || 1,
        role: 'definition',
      });
    }
  }
  return out.slice(0, 16);
}

function gitShort(gitRoot: string): string {
  try {
    const result = spawnSync('git', ['-C', gitRoot, '--no-pager', 'status', '--short'], {
      encoding: 'utf8',
      timeout: 2500,
      windowsHide: true,
    });
    return (result.stdout || result.stderr || '').trim();
  } catch {
    return '';
  }
}

function hash(value: string): string {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 8);
}
