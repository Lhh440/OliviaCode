import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  attachmentTextRef,
  emptyMemory,
  estimateImageTokens,
  estimateTokens,
  measureContext,
  mergeMemory,
  normalizeAttachments,
  parseMemoryDraft,
  type ImageAttachment,
  type MemoryDraft,
} from '@olivia/core';
import { MemoryStore } from './memory-store';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const VALID: MemoryDraft = {
  summary: '已经把侧栏改成按状态分组，测试通过；下一步补空状态。',
  constraints: ['不要改 packages/core 的公开类型'],
  decisions: ['使用现有 SelectMenu，不引第三方组件'],
  todos: [{ text: '补空状态文案', status: 'open' }],
  files: [{ path: 'apps/web/src/components/Sidebar.tsx', note: '已改分组' }],
  questions: ['要不要顺手加筛选？'],
};

function asRaw(draft: MemoryDraft): string {
  return JSON.stringify(draft);
}

function attachment(index: number): ImageAttachment {
  return {
    id: `img_${index}`,
    path: `C:\\artifacts\\upload_${index}.png`,
    mime: 'image/png',
    width: 800,
    height: 600,
    bytes: 12_000,
    sha256: `sha_${index}`,
    source: 'paste',
    createdAt: Date.now(),
  };
}

async function testParsing(): Promise<void> {
  console.log('parse / merge');
  const fenced = parseMemoryDraft(`\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\``);
  check('fenced JSON accepted', Boolean(fenced));
  check('summary parsed', fenced?.summary.includes('侧栏') === true);
  check('missing summary rejected', parseMemoryDraft('{"constraints":[]}') === null);
  check('broken JSON rejected', parseMemoryDraft('{"summary": "x"') === null);
  const tooMany = {
    ...VALID,
    constraints: Array.from({ length: 21 }, (_item, index) => `约束 ${index}`),
  };
  check('too many constraints rejected', parseMemoryDraft(JSON.stringify(tooMany)) === null);
  const tooLong = { ...VALID, constraints: ['x'.repeat(301)] };
  check('overlong item rejected', parseMemoryDraft(JSON.stringify(tooLong)) === null);
  const badTodo = parseMemoryDraft(
    JSON.stringify({ ...VALID, todos: [{ text: 'x', status: 'doing' }] }),
  );
  check('illegal todo status falls back to open', badTodo?.todos[0]?.status === 'open');

  const first = mergeMemory('task_1', null, {
    summary: '第一版',
    constraints: ['必须保留 A'],
    decisions: ['决定甲'],
    todos: [{ text: '待办一', status: 'open' as const }],
    files: [{ path: 'a.ts', note: '新增' }],
    questions: [],
  });
  const second = mergeMemory('task_1', first, {
    summary: '第二版',
    constraints: [],
    decisions: [],
    todos: [{ text: '待办一', status: 'done' as const }],
    files: [{ path: 'a.ts', note: '已改' }],
    questions: ['问题乙'],
  });
  check('constraints merge instead of rewrite', second.constraints.includes('必须保留 A'));
  check('decisions merge instead of rewrite', second.decisions.includes('决定甲'));
  check('todo status updates by text', second.todos.find((todo) => todo.text === '待办一')?.status === 'done');
  check('file note updates without duplicate', second.files.length === 1 && second.files[0]?.note === '已改');
  check('summary can be rewritten', second.summary === '第二版');
}

async function testStore(): Promise<void> {
  console.log('memory store / checkpoints');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'olivia-memory-'));
  const store = new MemoryStore(dir);
  const empty = await store.read('task_a');
  check('missing file returns empty memory', empty.memory.summary === '' && empty.checkpoints.length === 0);

  const first = await store.commit('task_a', {
    draftRaw: asRaw({ ...VALID, summary: '第一次整理' }),
    reason: 'auto',
    beforeUsed: 90_000,
    afterUsed: 3_000,
    keptTurns: 2,
    droppedTurns: 6,
    usage: { input: 2_200, output: 340, source: 'provider' },
  });
  check('first commit ok', first.ok && Boolean(first.file));
  check('checkpoint appended', first.file?.checkpoints.length === 1);
  check('active checkpoint points at new one', first.file?.activeCheckpointId === first.file?.checkpoints[0]?.id);
  check('memory merged', first.file?.memory.constraints.includes('不要改 packages/core 的公开类型') === true);
  const reread = await store.read('task_a');
  check('read keeps active checkpoint id', reread.activeCheckpointId === first.file?.activeCheckpointId);

  const second = await store.commit('task_a', {
    draftRaw: asRaw({ ...VALID, summary: '第二次整理', constraints: [], decisions: [] }),
    reason: 'manual',
    beforeUsed: 70_000,
    afterUsed: 2_800,
    keptTurns: 2,
    droppedTurns: 3,
  });
  check('second commit appends', second.file?.checkpoints.length === 2);
  check('second commit keeps old constraint', second.file?.memory.constraints.includes('不要改 packages/core 的公开类型') === true);
  check('summary rewritten', second.file?.memory.summary === '第二次整理');

  const cp1 = second.file?.checkpoints[0]?.id ?? '';
  const reverted = await store.revert('task_a', cp1);
  check('revert switches projection', reverted.memory.summary === '第一次整理');
  check('revert keeps original checkpoint list', reverted.checkpoints.length === 2);
  check('revert keeps active id', reverted.activeCheckpointId === cp1);
  check('log/event history untouched (same file count)', (await fs.readdir(dir)).length === 1);

  await store.clear('task_a');
  check('clear removes memory file', (await fs.readdir(dir)).length === 0);
  await fs.rm(dir, { recursive: true, force: true });
}

function testContextAndAttachments(): void {
  console.log('context / attachments');
  const snapshot = measureContext({
    window: 1000,
    parts: [
      { key: 'memory', text: '任务记忆'.repeat(20), items: 1 },
      { key: 'images', text: '', items: 1, tokens: 300 },
    ],
    providerInput: 1000,
  });
  check('context parts include memory', snapshot.parts.some((part) => part.key === 'memory' && part.tokens > 0));
  check('context parts include images', snapshot.parts.some((part) => part.key === 'images' && part.tokens > 0));
  check('provider input normalized to total', snapshot.parts.reduce((sum, part) => sum + part.tokens, 0) === 1000);

  const many = Array.from({ length: 5 }, (_item, index) => attachment(index));
  const normalized = normalizeAttachments(many);
  check('attachment cap is 4', normalized.length === 4);
  const invalid = {
    ...attachment(9),
    mime: 'image/svg+xml',
  };
  check('svg attachment rejected', normalizeAttachments([invalid]).length === 0);
  check('image token estimate is positive', estimateImageTokens(1600, 900) > 0);
  const label = attachmentTextRef(attachment(1));
  check('history image reference has filename, no base64', label.includes('upload_1.png') && !label.includes('base64'));
  check('empty memory is shaped', emptyMemory('t').version === 1 && estimateTokens('') === 0);
}

async function main(): Promise<void> {
  await testParsing();
  await testStore();
  testContextAndAttachments();
  console.log(`\nM8 memory self-test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
