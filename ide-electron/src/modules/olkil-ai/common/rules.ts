import * as fs from 'fs';
import * as path from 'path';

/**
 * Cursor-style project rules loader.
 * Precedence (later overrides earlier themes; all concatenated):
 *   1. AGENTS.md / AGENT.md
 *   2. .cursorrules / .cursor/rules/*.mdc|*.md
 *   3. .olkil/rules/*.md|*.mdc
 *   4. .olkil/RULES.md
 */
const RULE_FILES = ['AGENTS.md', 'AGENT.md', '.cursorrules', '.olkil/RULES.md'];
const RULE_DIRS = ['.cursor/rules', '.olkil/rules'];
const MAX_TOTAL = 24_000;
const MAX_FILE = 8_000;

export function loadProjectRules(workspaceRoot: string): string {
  if (!workspaceRoot || !fs.existsSync(workspaceRoot)) {
    return '';
  }
  const chunks: string[] = [];

  for (const rel of RULE_FILES) {
    const abs = path.join(workspaceRoot, rel);
    const body = readClipped(abs);
    if (body) {
      chunks.push(`### ${rel}\n${body}`);
    }
  }

  for (const dirRel of RULE_DIRS) {
    const dir = path.join(workspaceRoot, dirRel);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      continue;
    }
    let entries: string[] = [];
    try {
      entries = fs
        .readdirSync(dir)
        .filter((n) => /\.(md|mdc|txt)$/i.test(n))
        .sort();
    } catch {
      continue;
    }
    for (const name of entries.slice(0, 20)) {
      const body = readClipped(path.join(dir, name));
      if (body) {
        chunks.push(`### ${dirRel}/${name}\n${body}`);
      }
    }
  }

  if (!chunks.length) {
    return '';
  }
  let out = `PROJECT RULES (follow unless the user overrides):\n${chunks.join('\n\n')}`;
  if (out.length > MAX_TOTAL) {
    out = `${out.slice(0, MAX_TOTAL)}\n/* rules truncated */`;
  }
  return out;
}

function readClipped(abs: string): string | null {
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return null;
    }
    const raw = fs.readFileSync(abs, 'utf8');
    if (!raw.trim()) {
      return null;
    }
    return raw.length > MAX_FILE ? `${raw.slice(0, MAX_FILE)}\n/* truncated */` : raw;
  } catch {
    return null;
  }
}
