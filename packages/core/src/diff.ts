import type { DiffHunk, DiffLine } from './types';

export interface TextDiff {
  adds: number;
  dels: number;
  hunks: DiffHunk[];
}

const MAX_LINES = 1500;

/**
 * 统一 diff 头：`@@ -旧起点,旧行数 +新起点,新行数 @@`。
 * 行数为 0（纯新增/纯删除）时按 git 惯例写「前一行行号,0」，
 * 新文件因此是 `@@ -0,0 +1,N @@`，而不是看起来自相矛盾的 `@@ -1,0 +1,N @@`。
 */
export function formatHunkHeader(
  oldStart: number,
  oldCount: number,
  newStart: number,
  newCount: number,
): string {
  const at = (start: number, count: number): string =>
    count === 0 ? `${Math.max(0, start - 1)},0` : `${start},${count}`;
  return `@@ -${at(oldStart, oldCount)} +${at(newStart, newCount)} @@`;
}

function split(text: string): string[] {
  if (text === '') return [];
  return text.replace(/\r\n/g, '\n').split('\n');
}

interface Op {
  kind: 'add' | 'del' | 'ctx';
  text: string;
  aLine: number;
  bLine: number;
}

/** 行级 LCS diff。文件过大时退化为「整段替换」，宁可粗糙也不卡死 UI。 */
export function diffText(before: string, after: string, context = 3): TextDiff {
  const a = split(before);
  const b = split(after);

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    const lines: DiffLine[] = [
      ...a.map((text) => ({ kind: 'del' as const, text })),
      ...b.map((text) => ({ kind: 'add' as const, text })),
    ];
    return {
      adds: b.length,
      dels: a.length,
      hunks: [{ header: formatHunkHeader(1, a.length, 1, b.length), lines }],
    };
  }

  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'ctx', text: a[i]!, aLine: i + 1, bLine: j + 1 });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: 'del', text: a[i]!, aLine: i + 1, bLine: j + 1 });
      i += 1;
    } else {
      ops.push({ kind: 'add', text: b[j]!, aLine: i + 1, bLine: j + 1 });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: 'del', text: a[i]!, aLine: i + 1, bLine: j + 1 });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: 'add', text: b[j]!, aLine: i + 1, bLine: j + 1 });
    j += 1;
  }

  const adds = ops.filter((op) => op.kind === 'add').length;
  const dels = ops.filter((op) => op.kind === 'del').length;

  const hunks: DiffHunk[] = [];
  let index = 0;
  while (index < ops.length) {
    if (ops[index]!.kind === 'ctx') {
      index += 1;
      continue;
    }
    let start = Math.max(0, index - context);
    let end = index;
    while (end < ops.length) {
      if (ops[end]!.kind !== 'ctx') {
        end += 1;
        continue;
      }
      let run = 0;
      while (end + run < ops.length && ops[end + run]!.kind === 'ctx') run += 1;
      if (run > context * 2 && end + run < ops.length) break;
      end += run;
    }
    const slice = ops.slice(start, Math.min(end + context, ops.length));
    const anchor = slice[0]!;
    const oldCount = slice.filter((op) => op.kind !== 'add').length;
    const newCount = slice.filter((op) => op.kind !== 'del').length;
    hunks.push({
      header: formatHunkHeader(anchor.aLine, oldCount, anchor.bLine, newCount),
      lines: slice.map((op) => ({ kind: op.kind, text: op.text })),
    });
    index = Math.min(end + context, ops.length);
  }

  return { adds, dels, hunks };
}

/** 生成侧栏/日志用的短摘要。 */
export function diffSummary(diff: TextDiff): string {
  return `+${diff.adds} −${diff.dels}`;
}
