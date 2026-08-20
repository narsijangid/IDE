/**
 * Deterministic fast-path handlers — skip the LLM agent loop for well-known
 * localized edits (title/name changes, simple config patches).
 * Cursor-class: grep → read line range → patch in <1s.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ripgrepSearch } from '../ripgrep';
import { detectTaskIntent } from './task-router';
import { readFileText, resolveWorkspacePath } from './patch-engine';

export interface FastPathFileChange {
  id: string;
  kind: 'edit';
  path: string;
  beforeContent: string;
  afterContent: string;
}

export interface FastPathResult {
  text: string;
  fileChanges: FastPathFileChange[];
}

export interface FastPathInput {
  prompt: string;
  workspaceRoot: string;
  mode: 'agent' | 'plan' | 'ask';
  runId: string;
}

export async function tryFastPath(input: FastPathInput): Promise<FastPathResult | null> {
  if (input.mode !== 'agent' || !input.workspaceRoot?.trim()) {
    return null;
  }
  const intent = detectTaskIntent(input.prompt);
  if (intent === 'title-change') {
    return tryTitleChange(input);
  }
  return null;
}

function extractReplacementValue(prompt: string): string | null {
  const quoted = prompt.match(/["']([^"']{2,80})["']/);
  if (quoted?.[1]?.trim()) {
    return quoted[1].trim();
  }
  const toMatch = prompt.match(/\bto\s+([A-Za-z0-9][A-Za-z0-9 \-_/.]{1,72})\s*\.?\s*$/i);
  if (toMatch?.[1]?.trim()) {
    return toMatch[1].trim();
  }
  return null;
}

async function tryTitleChange(input: FastPathInput): Promise<FastPathResult | null> {
  const newTitle = extractReplacementValue(input.prompt);
  if (!newTitle) {
    return null;
  }

  const hits: Array<{ abs: string; rel: string; line: number; text: string }> = [];

  const seeds: Array<{ query: string; glob: string; relPaths: string[] }> = [
    {
      query: 'productName',
      glob: '**/product.json',
      relPaths: ['product.json', 'ide-electron/product.json'],
    },
    {
      query: '<title>',
      glob: '**/index.html',
      relPaths: ['index.html', 'ide-electron/app/browser/index.html'],
    },
  ];

  for (const { query, glob, relPaths } of seeds) {
    const rg = await ripgrepSearch(input.workspaceRoot, query, {
      maxResults: 4,
      globs: [glob],
      timeoutMs: 400,
    });
    for (const match of rg.matches) {
      const abs = path.isAbsolute(match.path)
        ? match.path
        : resolveWorkspacePath(input.workspaceRoot, match.path);
      if (!fs.existsSync(abs)) continue;
      const rel = path.relative(input.workspaceRoot, abs).replace(/\\/g, '/');
      hits.push({ abs, rel, line: match.line, text: match.text });
    }
    // Direct probe when ripgrep unavailable or glob misses shallow files.
    if (!rg.matches.length) {
      for (const rel of relPaths) {
        const abs = resolveWorkspacePath(input.workspaceRoot, rel);
        if (!fs.existsSync(abs)) continue;
        const text = readFileText(abs);
        if (!text || !text.includes(query === 'productName' ? 'productName' : '<title>')) continue;
        const line =
          text.split(/\r?\n/).findIndex((l) => l.includes(query === 'productName' ? 'productName' : '<title>')) +
          1;
        hits.push({ abs, rel, line: Math.max(1, line), text: query });
      }
    }
  }

  if (!hits.length) {
    return null;
  }

  const fileChanges: FastPathFileChange[] = [];
  const edited: string[] = [];

  for (const hit of hits.slice(0, 3)) {
    const before = readFileText(hit.abs);
    if (before == null) continue;

    let after = before;
    if (/product\.json$/i.test(hit.rel)) {
      after = replaceJsonStringField(after, 'productName', newTitle);
      const appSlug = newTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (appSlug) {
        after = replaceJsonStringField(after, 'applicationName', appSlug);
      }
    } else if (/index\.html$/i.test(hit.rel)) {
      after = after.replace(/(<title[^>]*>)[^<]*(<\/title>)/i, `$1${newTitle}$2`);
    }

    if (after === before) continue;

    fs.writeFileSync(hit.abs, after, 'utf8');
    fileChanges.push({
      id: `${input.runId}_${hit.rel}`,
      kind: 'edit',
      path: hit.abs,
      beforeContent: before,
      afterContent: after,
    });
    edited.push(hit.rel);
  }

  if (!fileChanges.length) {
    return null;
  }

  return {
    text: `Updated project title to "${newTitle}" in ${edited.join(', ')}.`,
    fileChanges,
  };
}

function replaceJsonStringField(content: string, field: string, value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const re = new RegExp(`("${field}"\\s*:\\s*")[^"]*(")`, 'i');
  if (re.test(content)) {
    return content.replace(re, `$1${escaped}$2`);
  }
  return content;
}
