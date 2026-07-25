import { FileDiffLine } from './index';

export function countLineStats(before: string, after: string): { additions: number; deletions: number } {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const { adds, dels } = lineDiffOps(a, b);
  return { additions: adds, deletions: dels };
}

export function buildDiffPreview(before: string, after: string, maxLines = 16): FileDiffLine[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const { ops } = lineDiffOps(a, b);

  const interesting = new Set<number>();
  ops.forEach((op, idx) => {
    if (op.type !== 'equal') {
      interesting.add(idx);
      if (idx > 0) {
        interesting.add(idx - 1);
      }
      if (idx + 1 < ops.length) {
        interesting.add(idx + 1);
      }
    }
  });

  const preview: FileDiffLine[] = [];
  let gap = 0;
  for (let i = 0; i < ops.length; i++) {
    if (!interesting.has(i)) {
      gap++;
      continue;
    }
    if (gap > 0) {
      preview.push({ type: 'gap', text: '' });
      gap = 0;
    }
    const op = ops[i];
    preview.push({
      type: op.type === 'equal' ? 'context' : op.type === 'add' ? 'add' : 'del',
      lineNumber: op.lineNumber,
      text: op.text,
    });
    if (preview.length >= maxLines) {
      if (i < ops.length - 1) {
        preview.push({ type: 'gap', text: '' });
      }
      break;
    }
  }

  return preview.length
    ? preview
    : [{ type: 'context', lineNumber: 1, text: '(no line changes)' }];
}

/** Short human summary of what changed (for the file card footer). */
export function buildChangeSummary(before: string, after: string, maxParts = 4): string {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const { ops } = lineDiffOps(a, b);
  const parts: string[] = [];
  for (const op of ops) {
    if (op.type === 'equal') {
      continue;
    }
    const clip = op.text.trim().replace(/\s+/g, ' ').slice(0, 72);
    if (!clip) {
      continue;
    }
    parts.push(op.type === 'add' ? `+ ${clip}` : `− ${clip}`);
    if (parts.length >= maxParts) {
      break;
    }
  }
  if (!parts.length) {
    return 'No line-level changes';
  }
  const extra = ops.filter((o) => o.type === 'add' || o.type === 'del').length - parts.length;
  return extra > 0 ? `${parts.join(' · ')} · +${extra} more` : parts.join(' · ');
}

export interface EditorDiffMarkers {
  /** 1-based line numbers in the AFTER content to paint green */
  addedLines: number[];
  /** Deleted hunks to show as red view-zones after `afterLineNumber` (0 = before line 1) */
  deletedHunks: Array<{ afterLineNumber: number; lines: string[] }>;
}

/** Markers for painting Cursor-like green/red in the live editor. */
export function computeEditorDiffMarkers(before: string, after: string): EditorDiffMarkers {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const { ops } = lineDiffOps(a, b);

  const addedLines: number[] = [];
  const deletedHunks: Array<{ afterLineNumber: number; lines: string[] }> = [];
  let afterPos = 0;
  let pendingDels: string[] = [];

  const flushDels = () => {
    if (pendingDels.length) {
      deletedHunks.push({ afterLineNumber: afterPos, lines: pendingDels });
      pendingDels = [];
    }
  };

  for (const op of ops) {
    if (op.type === 'equal') {
      flushDels();
      afterPos++;
    } else if (op.type === 'add') {
      flushDels();
      addedLines.push(op.lineNumber);
      afterPos++;
    } else {
      pendingDels.push(op.text);
    }
  }
  flushDels();

  return { addedLines, deletedHunks };
}

type Op =
  | { type: 'equal'; lineNumber: number; text: string }
  | { type: 'add'; lineNumber: number; text: string }
  | { type: 'del'; lineNumber: number; text: string };

function lineDiffOps(a: string[], b: string[]): { ops: Op[]; adds: number; dels: number } {
  if (a.length * b.length > 2_000_000) {
    const adds = Math.max(0, b.length - a.length);
    const dels = Math.max(0, a.length - b.length);
    const ops: Op[] = [];
    const n = Math.min(12, Math.max(a.length, b.length));
    for (let i = 0; i < n; i++) {
      if (i < a.length && (i >= b.length || a[i] !== b[i])) {
        ops.push({ type: 'del', lineNumber: i + 1, text: a[i] });
      }
      if (i < b.length && (i >= a.length || a[i] !== b[i])) {
        ops.push({ type: 'add', lineNumber: i + 1, text: b[i] });
      }
    }
    return {
      ops,
      adds: adds || ops.filter((o) => o.type === 'add').length,
      dels: dels || ops.filter((o) => o.type === 'del').length,
    };
  }

  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  let adds = 0;
  let dels = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', lineNumber: j + 1, text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', lineNumber: i + 1, text: a[i] });
      dels++;
      i++;
    } else {
      ops.push({ type: 'add', lineNumber: j + 1, text: b[j] });
      adds++;
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: 'del', lineNumber: i + 1, text: a[i] });
    dels++;
    i++;
  }
  while (j < m) {
    ops.push({ type: 'add', lineNumber: j + 1, text: b[j] });
    adds++;
    j++;
  }
  return { ops, adds, dels };
}
