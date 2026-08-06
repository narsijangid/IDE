/**
 * Split a unified before/after into Cursor-style hunks for per-hunk Accept/Reject.
 */
export interface DiffHunk {
  id: string;
  /** 0-based index into the ops stream for debugging */
  index: number;
  additions: number;
  deletions: number;
  /** Human-readable title */
  title: string;
  /** Lines belonging to this hunk (for preview) */
  preview: Array<{ type: 'add' | 'del' | 'context'; text: string; lineNumber?: number }>;
  /** Apply this hunk alone: content if only this hunk is kept from before→after */
  /** We store the after-region line range for surgical apply */
  beforeStart: number;
  beforeEnd: number;
  afterStart: number;
  afterEnd: number;
  status?: 'pending' | 'accepted' | 'rejected';
}

function lineDiffOps(a: string[], b: string[]) {
  // Simple LCS DP (same spirit as common/diff.ts) — kept local to avoid circular deps
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  type Op = {
    type: 'equal' | 'add' | 'del';
    text: string;
    lineNumber: number;
    aIdx?: number;
    bIdx?: number;
  };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', text: a[i], lineNumber: j + 1, aIdx: i, bIdx: j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', text: a[i], lineNumber: i + 1, aIdx: i });
      i++;
    } else {
      ops.push({ type: 'add', text: b[j], lineNumber: j + 1, bIdx: j });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: 'del', text: a[i], lineNumber: i + 1, aIdx: i });
    i++;
  }
  while (j < m) {
    ops.push({ type: 'add', text: b[j], lineNumber: j + 1, bIdx: j });
    j++;
  }
  return ops;
}

/** Build hunks separated by ≥2 equal context lines. */
export function buildDiffHunks(before: string, after: string): DiffHunk[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const ops = lineDiffOps(a, b);
  const hunks: DiffHunk[] = [];
  let cur: typeof ops = [];
  let equalRun = 0;

  const flush = () => {
    if (!cur.some((o) => o.type !== 'equal')) {
      cur = [];
      return;
    }
    const adds = cur.filter((o) => o.type === 'add').length;
    const dels = cur.filter((o) => o.type === 'del').length;
    const firstChange = cur.find((o) => o.type !== 'equal');
    const title =
      firstChange?.text.trim().slice(0, 48) ||
      (adds && dels ? `±${adds + dels} lines` : adds ? `+${adds}` : `−${dels}`);
    const aIdxs = cur.filter((o) => o.aIdx != null).map((o) => o.aIdx!);
    const bIdxs = cur.filter((o) => o.bIdx != null).map((o) => o.bIdx!);
    hunks.push({
      id: `h${hunks.length + 1}`,
      index: hunks.length,
      additions: adds,
      deletions: dels,
      title,
      preview: cur
        .filter((o) => o.type !== 'equal' || cur.indexOf(o) < 3 || cur.indexOf(o) > cur.length - 4)
        .slice(0, 24)
        .map((o) => ({
          type: o.type === 'equal' ? ('context' as const) : (o.type as 'add' | 'del'),
          text: o.text,
          lineNumber: o.lineNumber,
        })),
      beforeStart: aIdxs.length ? Math.min(...aIdxs) : 0,
      beforeEnd: aIdxs.length ? Math.max(...aIdxs) + 1 : 0,
      afterStart: bIdxs.length ? Math.min(...bIdxs) : 0,
      afterEnd: bIdxs.length ? Math.max(...bIdxs) + 1 : 0,
      status: 'pending',
    });
    cur = [];
  };

  for (const op of ops) {
    if (op.type === 'equal') {
      equalRun++;
      if (equalRun >= 3 && cur.some((o) => o.type !== 'equal')) {
        // keep one context line then flush
        cur.push(op);
        flush();
        equalRun = 0;
        continue;
      }
      if (cur.length) {
        cur.push(op);
      }
    } else {
      equalRun = 0;
      cur.push(op);
    }
  }
  flush();
  return hunks;
}

/**
 * Apply accepted hunks: start from `before`, splice in after-regions for accepted hunks only.
 * Rejected/pending hunks keep the before content for that region.
 */
export function applyAcceptedHunks(
  before: string,
  after: string,
  hunks: DiffHunk[],
): string {
  const accepted = hunks.filter((h) => h.status === 'accepted');
  if (!accepted.length) {
    return before;
  }
  if (accepted.length === hunks.length) {
    return after;
  }
  // Rebuild: walk hunks in order, take before or after segment
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const sorted = [...hunks].sort((x, y) => x.beforeStart - y.beforeStart);
  const out: string[] = [];
  let aPos = 0;
  let bPos = 0;
  for (const h of sorted) {
    // copy unchanged gap from before
    while (aPos < h.beforeStart) {
      out.push(a[aPos]);
      aPos++;
      bPos++; // keep rough alignment for rejected path — approximate
    }
    if (h.status === 'accepted') {
      for (let i = h.afterStart; i < h.afterEnd; i++) {
        if (i < b.length) {
          out.push(b[i]);
        }
      }
      aPos = h.beforeEnd;
      bPos = h.afterEnd;
    } else {
      for (let i = h.beforeStart; i < h.beforeEnd; i++) {
        if (i < a.length) {
          out.push(a[i]);
        }
      }
      aPos = h.beforeEnd;
      bPos = h.afterEnd;
    }
  }
  while (aPos < a.length) {
    out.push(a[aPos++]);
  }
  return out.join('\n');
}
