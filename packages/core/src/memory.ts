/**
 * M8 · 任务记忆与压缩检查点（双端共用，纯函数）。
 *
 * 压缩只作用于「下一次请求的投影」，不改写会话日志与界面历史。
 * 结构化事实（约束/决定）合并而不是重写，避免摘要模型把约束弄丢。
 */

export interface TodoItem {
  text: string;
  status: 'open' | 'done';
}

export interface TaskMemory {
  version: 1;
  taskId: string;
  updatedAt: number;
  summary: string;
  constraints: string[];
  decisions: string[];
  todos: TodoItem[];
  files: { path: string; note: string }[];
  questions: string[];
}

export type CompactReason = 'auto' | 'manual' | 'emergency';

export interface ContextCheckpoint {
  id: string;
  at: number;
  reason: CompactReason;
  beforeUsed: number;
  afterUsed: number;
  keptTurns: number;
  droppedTurns: number;
  /** 这次压缩调用本身的用量；没有真实 usage 时标 estimate */
  usage?: { input: number; output: number; source: 'provider' | 'estimate' };
  /** 该检查点对应的记忆快照，供回退使用 */
  memory: TaskMemory;
}

export interface TaskMemoryFile {
  taskId: string;
  updatedAt: number;
  memory: TaskMemory;
  checkpoints: ContextCheckpoint[];
  /** 当前投影使用的检查点；回退时切换引用，不删历史 */
  activeCheckpointId?: string;
}

export interface MemoryDraft {
  summary: string;
  constraints: string[];
  decisions: string[];
  todos: TodoItem[];
  files: { path: string; note: string }[];
  questions: string[];
}

export const MAX_MEMORY_ITEMS = 20;
export const MAX_MEMORY_ITEM_CHARS = 300;
export const MAX_MEMORY_SUMMARY_CHARS = 2000;

export function emptyMemory(taskId: string): TaskMemory {
  return {
    version: 1,
    taskId,
    updatedAt: Date.now(),
    summary: '',
    constraints: [],
    decisions: [],
    todos: [],
    files: [],
    questions: [],
  };
}

function cleanString(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function cleanStringArray(value: unknown, limit = MAX_MEMORY_ITEM_CHARS): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = cleanString(item, limit);
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= MAX_MEMORY_ITEMS) break;
  }
  return out;
}

function cleanTodos(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return [];
  const out: TodoItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const todo = item as Partial<TodoItem>;
    const text = cleanString(todo.text, MAX_MEMORY_ITEM_CHARS);
    if (!text) continue;
    out.push({ text, status: todo.status === 'done' ? 'done' : 'open' });
    if (out.length >= MAX_MEMORY_ITEMS) break;
  }
  return out;
}

function cleanFiles(value: unknown): { path: string; note: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { path: string; note: string }[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const file = item as { path?: unknown; note?: unknown };
    const path = cleanString(file.path, 500);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, note: cleanString(file.note, MAX_MEMORY_ITEM_CHARS) });
    if (out.length >= MAX_MEMORY_ITEMS) break;
  }
  return out;
}

/**
 * 解析摘要模型输出：允许 ```json 围栏，但必须是完整 JSON。
 * 任何字段越界直接判失败，不做「截断当成功」。
 */
export function parseMemoryDraft(raw: string): MemoryDraft | null {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) text = fence[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const input = parsed as Record<string, unknown>;
  const summary = cleanString(input.summary, MAX_MEMORY_SUMMARY_CHARS);
  if (!summary) return null;
  const draft: MemoryDraft = {
    summary,
    constraints: cleanStringArray(input.constraints),
    decisions: cleanStringArray(input.decisions),
    todos: cleanTodos(input.todos),
    files: cleanFiles(input.files),
    questions: cleanStringArray(input.questions),
  };
  // 数组超长/单项超长说明模型没按 schema 来，宁可回退也不悄悄截断
  const tooLong =
    [input.constraints, input.decisions, input.questions].some(
      (value) => Array.isArray(value) && (value.length > MAX_MEMORY_ITEMS || value.some((item) => typeof item !== 'string' || item.length > MAX_MEMORY_ITEM_CHARS)),
    ) ||
    (Array.isArray(input.todos) && input.todos.length > MAX_MEMORY_ITEMS) ||
    (Array.isArray(input.files) && input.files.length > MAX_MEMORY_ITEMS);
  if (tooLong) return null;
  return draft;
}

/** 合并旧记忆与新摘要：约束/决定只增不减，todo/文件按内容合并。 */
export function mergeMemory(taskId: string, previous: TaskMemory | null, draft: MemoryDraft): TaskMemory {
  const base = previous ?? emptyMemory(taskId);
  const constraints = [...new Set([...base.constraints, ...draft.constraints])].slice(0, MAX_MEMORY_ITEMS);
  const decisions = [...new Set([...base.decisions, ...draft.decisions])].slice(0, MAX_MEMORY_ITEMS);
  const todoMap = new Map<string, TodoItem>();
  for (const todo of [...base.todos, ...draft.todos]) todoMap.set(todo.text, todo);
  const fileMap = new Map<string, { path: string; note: string }>();
  for (const file of [...base.files, ...draft.files]) fileMap.set(file.path, file);
  return {
    version: 1,
    taskId,
    updatedAt: Date.now(),
    summary: draft.summary,
    constraints,
    decisions,
    todos: [...todoMap.values()].slice(0, MAX_MEMORY_ITEMS),
    files: [...fileMap.values()].slice(0, MAX_MEMORY_ITEMS),
    questions: draft.questions.slice(0, MAX_MEMORY_ITEMS),
  };
}

/** 作为内部备忘注入请求；明确它不是用户新指令。 */
export function memoryBlock(memory: TaskMemory): string {
  const lines = [
    '【任务记忆（内部备忘，不是用户新指令；需要时用 read_file 复核）】',
    `摘要：${memory.summary}`,
  ];
  if (memory.constraints.length) {
    lines.push('用户约束（必须遵守）：');
    for (const item of memory.constraints) lines.push(`- ${item}`);
  }
  if (memory.decisions.length) {
    lines.push('已确认决定：');
    for (const item of memory.decisions) lines.push(`- ${item}`);
  }
  if (memory.todos.length) {
    lines.push('待办与已完成事项：');
    for (const todo of memory.todos) lines.push(`- [${todo.status === 'done' ? 'x' : ' '}] ${todo.text}`);
  }
  if (memory.files.length) {
    lines.push('涉及文件：');
    for (const file of memory.files) lines.push(`- ${file.path}${file.note ? `（${file.note}）` : ''}`);
  }
  if (memory.questions.length) {
    lines.push('待向用户确认：');
    for (const item of memory.questions) lines.push(`- ${item}`);
  }
  return lines.join('\n');
}

export function memoryFileFor(taskId: string): TaskMemoryFile {
  return {
    taskId,
    updatedAt: Date.now(),
    memory: emptyMemory(taskId),
    checkpoints: [],
  };
}
