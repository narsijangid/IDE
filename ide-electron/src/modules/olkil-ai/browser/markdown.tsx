import React, { useState } from 'react';

/**
 * Lightweight safe markdown renderer (no raw HTML).
 * Supports: fenced code, inline code, **bold**, *italic*, lists, headings,
 * GFM tables, links-as-text, clickable file paths, copy on code blocks.
 */
export function MarkdownMessage({
  text,
  className,
  onOpenPath,
}: {
  text: string;
  className?: string;
  onOpenPath?: (path: string, line?: number) => void;
}) {
  const blocks = parseBlocks(text || '');
  return (
    <div className={className}>
      {blocks.map((block, i) => {
        if (block.type === 'code') {
          return (
            <div key={i}>
              <CodeBlock lang={block.lang} text={block.text} />
            </div>
          );
        }
        if (block.type === 'table') {
          return (
            <div key={i} className="md-table-wrap">
              <table className="md-table">
                <thead>
                  <tr>
                    {block.headers.map((h, j) => (
                      <th key={j}>{renderInline(h, onOpenPath)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, r) => (
                    <tr key={r}>
                      {row.map((cell, c) => (
                        <td key={c}>{renderInline(cell, onOpenPath)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (block.type === 'ul') {
          return (
            <ul key={i} className="md-ul">
              {block.items.map((item, j) => (
                <li key={j}>{renderInline(item, onOpenPath)}</li>
              ))}
            </ul>
          );
        }
        if (block.type === 'ol') {
          return (
            <ol key={i} className="md-ol">
              {block.items.map((item, j) => (
                <li key={j}>{renderInline(item, onOpenPath)}</li>
              ))}
            </ol>
          );
        }
        if (block.type === 'h') {
          const level = Math.min(3, Math.max(1, block.level));
          const className = `md-h md-h${level}`;
          if (level === 1) {
            return (
              <h1 key={i} className={className}>
                {renderInline(block.text, onOpenPath)}
              </h1>
            );
          }
          if (level === 2) {
            return (
              <h2 key={i} className={className}>
                {renderInline(block.text, onOpenPath)}
              </h2>
            );
          }
          return (
            <h3 key={i} className={className}>
              {renderInline(block.text, onOpenPath)}
            </h3>
          );
        }
        if (block.type === 'hr') {
          return <hr key={i} className="md-hr" />;
        }
        return (
          <p key={i} className="md-p">
            {renderInline(block.text, onOpenPath)}
          </p>
        );
      })}
    </div>
  );
}

function CodeBlock({ lang, text }: { lang?: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  };
  const label = (lang || 'code').replace(/^javascript$/i, 'js').replace(/^typescript$/i, 'ts');
  return (
    <pre className="md-code-block">
      <div className="md-code-toolbar">
        <span className="md-code-lang">{label}</span>
        <button type="button" className="md-code-copy" onClick={() => void onCopy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <code>{text}</code>
    </pre>
  );
}

type Block =
  | { type: 'p'; text: string }
  | { type: 'code'; text: string; lang?: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'h'; level: number; text: string }
  | { type: 'hr' }
  | { type: 'table'; headers: string[]; rows: string[][] };

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
}

function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.includes('|') && !/^```/.test(t);
}

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] || undefined;
      i++;
      const buf: string[] = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        i++;
      }
      out.push({ type: 'code', text: buf.join('\n'), lang });
      continue;
    }

    const h = line.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      out.push({ type: 'h', level: h[1].length, text: h[2] });
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push({ type: 'hr' });
      i++;
      continue;
    }

    // GFM table: header | sep | rows
    if (
      isTableRow(line) &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      const headers = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i]) && !isTableSeparator(lines[i])) {
        const cells = splitTableRow(lines[i]);
        // Pad / trim to header width
        while (cells.length < headers.length) cells.push('');
        rows.push(cells.slice(0, headers.length));
        i++;
      }
      out.push({ type: 'table', headers, rows });
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      out.push({ type: 'ul', items });
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        i++;
      }
      out.push({ type: 'ol', items });
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i]) &&
      !/^#{1,3}\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]) &&
      !(isTableRow(lines[i]) && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
    ) {
      buf.push(lines[i]);
      i++;
    }
    out.push({ type: 'p', text: buf.join('\n') });
  }

  return out.length ? out : [{ type: 'p', text: '' }];
}

function renderInline(
  text: string,
  onOpenPath?: (path: string, line?: number) => void,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // `code`, **bold**, *italic*, backtick paths, bare path:line
  const re =
    /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|`?(?:[A-Za-z]:)?[A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+(?::\d+(?:-\d+)?)?`?)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) {
      nodes.push(text.slice(last, m.index));
    }
    const tok = m[0];
    if (tok.startsWith('`') && tok.endsWith('`') && tok.length > 2 && !/\s/.test(tok.slice(1, -1))) {
      const inner = tok.slice(1, -1);
      if (looksLikePath(inner) && onOpenPath) {
        const { path, line } = splitPathLine(inner);
        nodes.push(
          <button
            key={key++}
            type="button"
            className="md-file-link"
            onClick={() => onOpenPath(path, line)}
          >
            {inner}
          </button>,
        );
      } else {
        nodes.push(
          <code key={key++} className="md-inline-code">
            {inner}
          </code>,
        );
      }
    } else if (tok.startsWith('`')) {
      nodes.push(
        <code key={key++} className="md-inline-code">
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith('**') || tok.startsWith('__')) {
      nodes.push(
        <strong key={key++} className="md-strong">
          {renderInline(tok.slice(2, -2), onOpenPath)}
        </strong>,
      );
    } else if (tok.startsWith('*') || tok.startsWith('_')) {
      nodes.push(
        <em key={key++} className="md-em">
          {tok.slice(1, -1)}
        </em>,
      );
    } else if (looksLikePath(tok) && onOpenPath) {
      const { path, line } = splitPathLine(tok);
      nodes.push(
        <button
          key={key++}
          type="button"
          className="md-file-link"
          onClick={() => onOpenPath(path, line)}
        >
          {tok}
        </button>,
      );
    } else {
      nodes.push(tok);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) {
    nodes.push(text.slice(last));
  }
  return nodes;
}

function looksLikePath(s: string): boolean {
  return /(?:\/|\\|\.[A-Za-z0-9]{1,8}$)/.test(s) && !/\s/.test(s) && s.length < 200;
}

function splitPathLine(s: string): { path: string; line?: number } {
  const m = /^(.*):(\d+)(?:-\d+)?$/.exec(s);
  if (m) {
    return { path: m[1], line: Number(m[2]) };
  }
  return { path: s };
}
