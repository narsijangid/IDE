/** Line-level diff helpers for file change stats and editor markers. */

export type DiffLine =
  | { type: 'context' | 'add' | 'del'; lineNumber: number; text: string }
  | { type: 'gap'; text: string };

export function countLineStats(before: string | null, after: string | null): { additions: number; deletions: number } {
  if (before == null && after != null) {
    if (after === '') return { additions: 0, deletions: 0 };
    return { additions: after.split(/\r?\n/).length, deletions: 0 };
  }
  if (before != null && after == null) {
    if (before === '') return { additions: 0, deletions: 0 };
    return { additions: 0, deletions: before.split(/\r?\n/).length };
  }
  if (before === after) return { additions: 0, deletions: 0 };
  const a = String(before || '').split(/\r?\n/);
  const b = String(after || '').split(/\r?\n/);
  const { adds, dels } = lineDiffOps(a, b);
  return { additions: adds, deletions: dels };
}

export function buildDiffPreview(before: string | null, after: string | null, maxLines = 12): DiffLine[] {
  const a = String(before || '').split(/\r?\n/);
  const b = String(after || '').split(/\r?\n/);
  const { ops } = lineDiffOps(a, b);
  const interesting = new Set<number>();
  ops.forEach((op, idx) => {
    if (op.type !== 'equal') {
      interesting.add(idx);
      if (idx > 0) interesting.add(idx - 1);
      if (idx + 1 < ops.length) interesting.add(idx + 1);
    }
  });
  const preview: DiffLine[] = [];
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
      if (i < ops.length - 1) preview.push({ type: 'gap', text: '' });
      break;
    }
  }
  return preview.length ? preview : [{ type: 'context', lineNumber: 1, text: '(no line changes)' }];
}

export interface EditorDiffMarkers {
  addedLines: number[];
  deletedHunks: Array<{ afterLineNumber: number; lines: string[] }>;
}

export function computeEditorDiffMarkers(before: string | null, after: string | null): EditorDiffMarkers {
  const a = String(before || '').split(/\r?\n/);
  const b = String(after || '').split(/\r?\n/);
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
    const bag = new Map<string, number>();
    for (const line of a) bag.set(line, (bag.get(line) || 0) + 1);
    let adds = 0;
    for (const line of b) {
      const n = bag.get(line) || 0;
      if (n > 0) bag.set(line, n - 1);
      else adds += 1;
    }
    let dels = 0;
    for (const n of bag.values()) dels += n;
    return { ops: [], adds, dels };
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
