import React from 'react';

/**
 * Lightweight safe markdown renderer (no raw HTML).
 * Supports: fenced code, inline code, **bold**, *italic*, lists, headings, links-as-text.
 */
export function MarkdownMessage({ text, className }: { text: string; className?: string }) {
  const blocks = parseBlocks(text || '');
  return (
    <div className={className}>
      {blocks.map((block, i) => {
        if (block.type === 'code') {
          return (
            <pre key={i} className="md-code-block">
              {block.lang ? <div className="md-code-lang">{block.lang}</div> : null}
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.type === 'ul') {
          return (
            <ul key={i} className="md-ul">
              {block.items.map((item, j) => (
                <li key={j}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        }
        if (block.type === 'ol') {
          return (
            <ol key={i} className="md-ol">
              {block.items.map((item, j) => (
                <li key={j}>{renderInline(item)}</li>
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
                {renderInline(block.text)}
              </h1>
            );
          }
          if (level === 2) {
            return (
              <h2 key={i} className={className}>
                {renderInline(block.text)}
              </h2>
            );
          }
          return (
            <h3 key={i} className={className}>
              {renderInline(block.text)}
            </h3>
          );
        }
        if (block.type === 'hr') {
          return <hr key={i} className="md-hr" />;
        }
        return (
          <p key={i} className="md-p">
            {renderInline(block.text)}
          </p>
        );
      })}
    </div>
  );
}

type Block =
  | { type: 'p'; text: string }
  | { type: 'code'; text: string; lang?: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'h'; level: number; text: string }
  | { type: 'hr' };

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // fenced code
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
        i++; // closing ```
      }
      out.push({ type: 'code', text: buf.join('\n'), lang });
      continue;
    }

    // heading
    const h = line.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      out.push({ type: 'h', level: h[1].length, text: h[2] });
      i++;
      continue;
    }

    // hr
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push({ type: 'hr' });
      i++;
      continue;
    }

    // unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      out.push({ type: 'ul', items });
      continue;
    }

    // ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        i++;
      }
      out.push({ type: 'ol', items });
      continue;
    }

    // blank
    if (!line.trim()) {
      i++;
      continue;
    }

    // paragraph (merge consecutive non-empty non-special lines)
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i]) &&
      !/^#{1,3}\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    out.push({ type: 'p', text: buf.join('\n') });
  }

  return out.length ? out : [{ type: 'p', text: '' }];
}

function renderInline(text: string): React.ReactNode[] {
  // Tokenize: `code`, **bold**, *italic*, remaining text
  const nodes: React.ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) {
      nodes.push(text.slice(last, m.index));
    }
    const tok = m[0];
    if (tok.startsWith('`')) {
      nodes.push(
        <code key={key++} className="md-inline-code">
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith('**') || tok.startsWith('__')) {
      nodes.push(
        <strong key={key++} className="md-strong">
          {renderInline(tok.slice(2, -2))}
        </strong>,
      );
    } else {
      nodes.push(
        <em key={key++} className="md-em">
          {tok.slice(1, -1)}
        </em>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) {
    nodes.push(text.slice(last));
  }
  return nodes;
}
