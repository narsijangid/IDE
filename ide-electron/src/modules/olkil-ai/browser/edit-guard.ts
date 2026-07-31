/**
 * Edit guard — the discipline layer that makes agent edits trustworthy.
 *
 * Cursor-class agents do not "hope" an edit is right. Every mutation goes
 * through: artifact stripping (line-number prefixes, markdown fences),
 * whitespace-tolerant anchoring, and post-edit syntax validation with
 * rejection feedback so the model can self-correct instead of saving a
 * broken file.
 */

export interface SyntaxIssue {
  line: number;
  message: string;
}

/**
 * Models frequently copy the "  12|" prefixes from read_file output into
 * search/replace snippets. Strip them when the majority of lines carry one.
 */
export function stripLineNumberArtifacts(snippet: string): string {
  if (!snippet.includes('|')) return snippet;
  const lines = snippet.split('\n');
  const prefixed = lines.filter((line) => /^\s*\d+\|/.test(line)).length;
  const nonEmpty = lines.filter((line) => line.trim().length > 0).length;
  if (nonEmpty === 0 || prefixed < Math.max(1, Math.ceil(nonEmpty * 0.6))) {
    return snippet;
  }
  return lines.map((line) => line.replace(/^\s*\d+\|/, '')).join('\n');
}

/** Remove a single wrapping markdown code fence, if the model emitted one. */
export function stripMarkdownFence(content: string): string {
  const match = content.match(/^\s*```[\w-]*\r?\n([\s\S]*?)\r?\n```\s*$/);
  return match ? match[1] : content;
}

const TRUNCATION_PATTERNS = [
  /(?:\/\/|#|\/\*|<!--)\s*\.\.\.\s*(?:rest|existing|remaining|unchanged|other|previous)\b/i,
  /(?:\/\/|#)\s*(?:rest|remainder) of (?:the )?(?:file|code|function)/i,
  /\.\.\.\s*existing code\s*\.\.\./i,
];

/**
 * Detect junk that must never be written to a source file: git conflict
 * markers and "// ... rest of code" style truncation placeholders.
 */
export function findContentArtifact(content: string): string | undefined {
  if (/^(<{7}|>{7})/m.test(content)) {
    return 'content contains git conflict markers (<<<<<<< / >>>>>>>)';
  }
  for (const pattern of TRUNCATION_PATTERNS) {
    const hit = content.match(pattern);
    if (hit) {
      return `content contains a truncation placeholder ("${hit[0].trim()}"). Write the COMPLETE code — placeholders destroy the file`;
    }
  }
  return undefined;
}

const JS_EXTENSIONS = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts']);
const CSS_EXTENSIONS = new Set(['css', 'less', 'scss']);
const MARKUP_EXTENSIONS = new Set(['html', 'htm', 'vue', 'svelte', 'xml', 'svg']);
const JSX_EXTENSIONS = new Set(['jsx', 'tsx']);

function extensionOf(filePath: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(filePath);
  return match ? match[1].toLowerCase() : '';
}

/** Language-aware structural validation. Empty array = no problems found. */
export function syntaxIssues(filePath: string, content: string): SyntaxIssue[] {
  const ext = extensionOf(filePath);
  if (ext === 'json') {
    try {
      JSON.parse(content);
      return [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const position = /position (\d+)/.exec(message);
      const line = position ? content.slice(0, Number(position[1])).split('\n').length : 1;
      return [{ line, message: `invalid JSON: ${message.slice(0, 120)}` }];
    }
  }
  const issues: SyntaxIssue[] = [];
  if (JS_EXTENSIONS.has(ext)) {
    issues.push(...scanBrackets(content, 'js'));
    if (JSX_EXTENSIONS.has(ext) || /<[A-Za-z]/.test(content)) {
      issues.push(...scanMarkupTags(content));
    }
  } else if (CSS_EXTENSIONS.has(ext)) {
    issues.push(...scanBrackets(content, 'css'));
  } else if (MARKUP_EXTENSIONS.has(ext)) {
    issues.push(...scanMarkupTags(content));
    if (ext === 'vue' || ext === 'svelte') {
      issues.push(...scanBrackets(content, 'js'));
    }
  } else if (ext === 'py') {
    issues.push(...scanPythonIndent(content));
  }
  return issues.slice(0, 8);
}

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

/**
 * Lightweight JSX/HTML tag balancer. Catches the classic agent failure mode:
 * half-pasted components that leave an unclosed <div> or stray </Button>.
 * Skips comments, DOCTYPE, and void/self-closing tags.
 */
export function scanMarkupTags(content: string): SyntaxIssue[] {
  const issues: SyntaxIssue[] = [];
  const stack: Array<{ name: string; line: number }> = [];
  let line = 1;
  let i = 0;
  const n = content.length;
  const report = (message: string, atLine: number) => {
    if (issues.length < 6) issues.push({ line: atLine, message });
  };

  while (i < n) {
    const ch = content[i];
    if (ch === '\n') {
      line++;
      i++;
      continue;
    }
    // Skip JS/CSS strings so generic `<` comparisons don't look like tags.
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < n && content[i] !== quote) {
        if (content[i] === '\\') i++;
        if (content[i] === '\n') line++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === '/' && content[i + 1] === '/') {
      while (i < n && content[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && content[i + 1] === '*') {
      i += 2;
      while (i < n && !(content[i] === '*' && content[i + 1] === '/')) {
        if (content[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (ch !== '<') {
      i++;
      continue;
    }
    // HTML/JSX comment or doctype
    if (content.startsWith('<!--', i)) {
      const end = content.indexOf('-->', i + 4);
      if (end < 0) {
        report(`unterminated HTML comment at line ${line}`, line);
        break;
      }
      for (let k = i; k < end; k++) if (content[k] === '\n') line++;
      i = end + 3;
      continue;
    }
    if (content.startsWith('<!', i)) {
      while (i < n && content[i] !== '>') {
        if (content[i] === '\n') line++;
        i++;
      }
      i++;
      continue;
    }

    const close = content[i + 1] === '/';
    let pos = i + (close ? 2 : 1);
    if (pos >= n || !/[A-Za-z]/.test(content[pos])) {
      i++;
      continue;
    }
    const nameStart = pos;
    while (pos < n && /[\w:.-]/.test(content[pos])) pos++;
    const name = content.slice(nameStart, pos);
    const lower = name.toLowerCase();
    const tagLine = line;
    let selfClosing = false;
    while (pos < n && content[pos] !== '>') {
      if (content[pos] === '\n') line++;
      // Skip attribute strings so `>` inside them doesn't end the tag.
      if (content[pos] === '"' || content[pos] === "'") {
        const q = content[pos++];
        while (pos < n && content[pos] !== q) {
          if (content[pos] === '\\') pos++;
          if (content[pos] === '\n') line++;
          pos++;
        }
        pos++;
        continue;
      }
      if (content[pos] === '/' && content[pos + 1] === '>') {
        selfClosing = true;
        pos += 2;
        break;
      }
      // JSX expression attrs: <Foo bar={...}>
      if (content[pos] === '{') {
        let depth = 1;
        pos++;
        while (pos < n && depth > 0) {
          if (content[pos] === '{') depth++;
          else if (content[pos] === '}') depth--;
          else if (content[pos] === '\n') line++;
          else if (content[pos] === '"' || content[pos] === "'" || content[pos] === '`') {
            const q = content[pos++];
            while (pos < n && content[pos] !== q) {
              if (content[pos] === '\\') pos++;
              if (content[pos] === '\n') line++;
              pos++;
            }
          }
          pos++;
        }
        continue;
      }
      pos++;
    }
    if (pos < n && content[pos] === '>') pos++;
    i = pos;

    if (selfClosing || VOID_TAGS.has(lower)) continue;
    if (close) {
      if (!stack.length) {
        report(`unexpected closing </${name}> at line ${tagLine}`, tagLine);
      } else {
        const top = stack[stack.length - 1];
        // JSX is case-sensitive; HTML tags compare case-insensitively.
        const match =
          top.name === name ||
          (top.name.toLowerCase() === lower && /^[a-z]/.test(top.name) && /^[a-z]/.test(name));
        if (!match) {
          report(
            `mismatched </${name}> at line ${tagLine} (open <${top.name}> from line ${top.line})`,
            tagLine,
          );
          stack.pop();
        } else {
          stack.pop();
        }
      }
    } else {
      stack.push({ name, line: tagLine });
    }
  }

  for (const open of stack.slice(-4)) {
    report(`unclosed <${open.name}> opened at line ${open.line}`, open.line);
  }
  return issues;
}

/** Catch catastrophic Python indent collapses (common agent paste failure). */
export function scanPythonIndent(content: string): SyntaxIssue[] {
  const issues: SyntaxIssue[] = [];
  const lines = content.split(/\r?\n/);
  let prevIndent = 0;
  let prevNonEmpty = '';
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const indent = /^[ \t]*/.exec(raw)![0].length;
    const trimmed = raw.trim();
    // After a colon-ending block header, next non-empty line must indent deeper.
    if (prevNonEmpty.endsWith(':') && indent <= prevIndent && !trimmed.startsWith('#')) {
      issues.push({
        line: i + 1,
        message: `expected indented block after line ending with ':' (line ${i})`,
      });
      if (issues.length >= 4) break;
    }
    prevIndent = indent;
    prevNonEmpty = trimmed;
  }
  return issues;
}

/**
 * Block catastrophic overwrites: emptying a large file, or replacing a huge
 * unique region with nearly nothing (classic "lost half the component" bug).
 */
export function destructiveEditIssue(
  before: string,
  after: string,
  options?: { searchLen?: number; replaceLen?: number },
): string | undefined {
  const beforeLen = before.length;
  const afterLen = after.length;
  if (beforeLen < 400) return undefined;
  if (afterLen === 0) {
    return 'edit would empty a non-trivial file — use delete_file if removal is intended';
  }
  if (afterLen < beforeLen * 0.35 && beforeLen - afterLen > 800) {
    return `edit would delete ~${Math.round((1 - afterLen / beforeLen) * 100)}% of the file (${beforeLen}→${afterLen} chars) — too destructive for one patch`;
  }
  const searchLen = options?.searchLen ?? 0;
  const replaceLen = options?.replaceLen ?? afterLen;
  if (searchLen > 600 && replaceLen < searchLen * 0.25 && searchLen - replaceLen > 400) {
    return `replacement shrinks a large unique region (${searchLen}→${replaceLen} chars) — likely truncated paste; write the COMPLETE replacement`;
  }
  return undefined;
}

const REGEX_PRECEDING_CHARS = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '',
]);
const REGEX_PRECEDING_WORDS = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'new', 'delete', 'void', 'instanceof', 'yield', 'await',
]);
const CLOSER_TO_OPENER: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/**
 * Bracket/string/comment scanner for JS-family and CSS-family files.
 * Handles strings, template literals with ${} nesting, comments, and a
 * standard heuristic for regex literals. Not a full parser — but paired
 * with before/after comparison it reliably catches the edits that break
 * files (lost brace, unterminated string, half-pasted block).
 */
export function scanBrackets(content: string, language: 'js' | 'css'): SyntaxIssue[] {
  const issues: SyntaxIssue[] = [];
  // Bracket entries; templateExpr marks the '{' opened by a `${` so that
  // closing it resumes template-body scanning.
  const stack: Array<{ ch: string; line: number; templateExpr?: boolean }> = [];
  let line = 1;
  let lastSignificant = '';
  let lastWord = '';
  let i = 0;
  const n = content.length;

  const report = (message: string, atLine: number) => {
    if (issues.length < 6) issues.push({ line: atLine, message });
  };

  /**
   * Scan a template literal body starting at position `pos` (just past the
   * backtick or the `}` of an interpolation). Returns the position to resume
   * code scanning from. Pushes a templateExpr '{' when hitting `${`.
   */
  const scanTemplateBody = (pos: number, startLine: number): number => {
    while (pos < n) {
      const c = content[pos];
      if (c === '\\') {
        pos += 2;
        continue;
      }
      if (c === '\n') {
        line++;
        pos++;
        continue;
      }
      if (c === '`') {
        return pos + 1;
      }
      if (c === '$' && content[pos + 1] === '{') {
        stack.push({ ch: '{', line, templateExpr: true });
        return pos + 2;
      }
      pos++;
    }
    report(`unterminated template literal starting at line ${startLine}`, startLine);
    return pos;
  };

  while (i < n) {
    const ch = content[i];
    const next = i + 1 < n ? content[i + 1] : '';

    if (ch === '\n') {
      line++;
      i++;
      continue;
    }

    // Comments
    if (ch === '/' && next === '/') {
      while (i < n && content[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      const startLine = line;
      i += 2;
      while (i < n && !(content[i] === '*' && content[i + 1] === '/')) {
        if (content[i] === '\n') line++;
        i++;
      }
      if (i >= n) {
        report(`unterminated block comment opened at line ${startLine}`, startLine);
        break;
      }
      i += 2;
      continue;
    }

    // Strings
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const startLine = line;
      i++;
      while (i < n && content[i] !== quote && content[i] !== '\n') {
        if (content[i] === '\\') i++;
        i++;
      }
      if (i < n && content[i] === quote) {
        i++;
        lastSignificant = quote;
        lastWord = '';
        continue;
      }
      if (language === 'css' && i < n) {
        // CSS strings may span lines in weird preprocessor cases; don't flag.
        line++;
        i++;
        continue;
      }
      report(`unterminated string (${quote}…) at line ${startLine}`, startLine);
      continue;
    }

    // Template literals (JS only)
    if (language === 'js' && ch === '`') {
      i = scanTemplateBody(i + 1, line);
      lastSignificant = '`';
      lastWord = '';
      continue;
    }

    // Regex literal heuristic (JS only)
    if (
      language === 'js' &&
      ch === '/' &&
      (REGEX_PRECEDING_CHARS.has(lastSignificant) || REGEX_PRECEDING_WORDS.has(lastWord))
    ) {
      let pos = i + 1;
      let inClass = false;
      let closedRegex = false;
      while (pos < n && content[pos] !== '\n') {
        if (content[pos] === '\\') {
          pos += 2;
          continue;
        }
        if (content[pos] === '[') inClass = true;
        else if (content[pos] === ']') inClass = false;
        else if (content[pos] === '/' && !inClass) {
          closedRegex = true;
          break;
        }
        pos++;
      }
      if (closedRegex) {
        pos++;
        while (pos < n && /[a-z]/i.test(content[pos])) pos++;
        i = pos;
      } else {
        // Not a regex after all — treat as division.
        i++;
      }
      lastSignificant = '/';
      lastWord = '';
      continue;
    }

    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push({ ch, line });
      lastSignificant = ch;
      lastWord = '';
      i++;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      const expected = CLOSER_TO_OPENER[ch];
      const top = stack[stack.length - 1];
      if (!top) {
        report(`unexpected '${ch}' at line ${line} (nothing open)`, line);
        i++;
      } else if (top.ch !== expected) {
        report(`mismatched '${ch}' at line ${line} ('${top.ch}' from line ${top.line} is still open)`, line);
        stack.pop();
        i++;
      } else {
        stack.pop();
        if (ch === '}' && top.templateExpr) {
          // Interpolation closed — resume scanning the template body.
          i = scanTemplateBody(i + 1, top.line);
          lastSignificant = '`';
          lastWord = '';
          continue;
        }
        i++;
      }
      lastSignificant = ch;
      lastWord = '';
      continue;
    }

    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < n && /[\w$]/.test(content[j])) j++;
      lastWord = content.slice(i, j);
      // Sentinel: a '/' right after an identifier is division, not a regex
      // (unless the identifier is a keyword — checked via lastWord).
      lastSignificant = 'ident';
      i = j;
      continue;
    }
    lastSignificant = ch;
    lastWord = '';
    i++;
  }

  for (const open of stack) {
    report(`unclosed '${open.ch}' opened at line ${open.line}`, open.line);
  }
  return issues;
}

/**
 * Issues present after the edit that were NOT present before it. A file may
 * already be broken — we only block edits that make things worse.
 */
export function newlyIntroducedIssues(before: SyntaxIssue[], after: SyntaxIssue[]): SyntaxIssue[] {
  const kind = (issue: SyntaxIssue) => issue.message.replace(/line \d+/g, 'line N');
  const budget = new Map<string, number>();
  for (const issue of before) {
    const key = kind(issue);
    budget.set(key, (budget.get(key) || 0) + 1);
  }
  const fresh: SyntaxIssue[] = [];
  for (const issue of after) {
    const key = kind(issue);
    const remaining = budget.get(key) || 0;
    if (remaining > 0) {
      budget.set(key, remaining - 1);
    } else {
      fresh.push(issue);
    }
  }
  return fresh;
}

export type FuzzyLocateResult =
  | { kind: 'found'; index: number; length: number; actual: string }
  | { kind: 'not_found' }
  | { kind: 'ambiguous'; count: number };

/**
 * Whitespace-tolerant anchor: match the snippet line-by-line comparing
 * trimmed content, then return the REAL text from the file so the
 * replacement is anchored to what is actually on disk.
 */
export function fuzzyLocate(text: string, search: string): FuzzyLocateResult {
  const searchLines = search.split('\n');
  while (searchLines.length && !searchLines[0].trim()) searchLines.shift();
  while (searchLines.length && !searchLines[searchLines.length - 1].trim()) searchLines.pop();
  if (!searchLines.length) return { kind: 'not_found' };
  const trimmed = searchLines.map((line) => line.trim());
  // Single-line anchors shorter than 8 chars are too ambiguous for fuzzy.
  if (trimmed.length === 1 && trimmed[0].length < 8) return { kind: 'not_found' };

  const textLines = text.split('\n');
  const starts: number[] = [];
  for (let i = 0; i + trimmed.length <= textLines.length; i++) {
    let ok = true;
    for (let k = 0; k < trimmed.length; k++) {
      if (textLines[i + k].trim() !== trimmed[k]) {
        ok = false;
        break;
      }
    }
    if (ok) starts.push(i);
  }
  if (!starts.length) return { kind: 'not_found' };
  if (starts.length > 1) return { kind: 'ambiguous', count: starts.length };

  const startLine = starts[0];
  let index = 0;
  for (let i = 0; i < startLine; i++) index += textLines[i].length + 1;
  const actual = textLines.slice(startLine, startLine + trimmed.length).join('\n');
  return { kind: 'found', index, length: actual.length, actual };
}

/**
 * When a fuzzy match found the real snippet at a different indentation than
 * the model wrote, shift the replacement by the same delta so it lands at
 * the correct depth.
 */
export function reindentReplacement(actualSnippet: string, searchSnippet: string, replacement: string): string {
  const firstIndent = (block: string): string | undefined => {
    for (const line of block.split('\n')) {
      if (line.trim()) return /^[ \t]*/.exec(line)![0];
    }
    return undefined;
  };
  const actualIndent = firstIndent(actualSnippet);
  const searchIndent = firstIndent(searchSnippet);
  if (actualIndent === undefined || searchIndent === undefined || actualIndent === searchIndent) {
    return replacement;
  }
  // Mixed tabs/spaces deltas are unsafe to synthesize — leave untouched.
  if (/\t/.test(actualIndent) !== /\t/.test(searchIndent)) return replacement;

  const delta = actualIndent.length - searchIndent.length;
  const unit = /\t/.test(actualIndent) ? '\t' : ' ';
  return replacement
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line;
      if (delta > 0) return unit.repeat(delta) + line;
      const current = /^[ \t]*/.exec(line)![0];
      return current.length >= -delta ? line.slice(-delta) : line.trimStart();
    })
    .join('\n');
}
