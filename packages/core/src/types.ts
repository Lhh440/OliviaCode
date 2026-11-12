export type ApprovalMode = 'ask' | 'auto' | 'never';

export type TaskStatus = 'idle' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped';

export interface ToolRun {
  id: string;
  name: string;
  detail: string;
  status: 'running' | 'ok' | 'error';
  rows?: string[];
}

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx';
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  file: string;
  adds: number;
  dels: number;
  hunks: DiffHunk[];
  state: 'pending' | 'accepted' | 'rejected';
}

export type Part =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string; done: boolean }
  | { kind: 'tool'; run: ToolRun }
  | { kind: 'diff'; diff: DiffFile };

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  parts: Part[];
  at: number;
  streaming?: boolean;
}

export interface Task {
  id: string;
  title: string;
  branch: string;
  model: string;
  approval: ApprovalMode;
  status: TaskStatus;
  at: number;
  messages: Message[];
}

export interface Settings {
  baseUrl: string;
  apiKey: string;
  model: string;
  approval: ApprovalMode;
  demo: boolean;
}

export interface ModelInfo {
  id: string;
  label: string;
  short: string;
}

/** 与后端 /models 对齐的真实 id；label 只用于展示。 */
export const MODELS: ModelInfo[] = [
  { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', short: 'DeepSeek 4.1' },
  { id: 'qwen3.8-27b', label: 'Qwen3.8 27B', short: 'Qwen3.8' },
];

export function modelLabel(id: string | undefined): string {
  return MODELS.find((model) => model.id === id)?.label ?? id ?? '未选择';
}

export function modelShort(id: string | undefined): string {
  return MODELS.find((model) => model.id === id)?.short ?? id ?? '—';
}

export const APPROVALS: { value: ApprovalMode; label: string; hint: string }[] = [
  { value: 'ask', label: '每次询问', hint: '写入与命令执行前都要确认' },
  { value: 'auto', label: '自动放行', hint: '工作区内的读写自动执行，越界仍询问' },
  { value: 'never', label: '全部放行', hint: '不再询问，谨慎使用' },
];

let seq = 0;
export function uid(prefix = 'id'): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}`;
}

export function relativeTime(at: number, now = Date.now()): string {
  const diff = Math.max(0, now - at);
  const minute = 60_000;
  if (diff < minute) return '刚刚';
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
  const hour = 60 * minute;
  if (diff < 24 * hour) return `${Math.floor(diff / hour)} 小时前`;
  const day = 24 * hour;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  const d = new Date(at);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

export function titleFromPrompt(prompt: string): string {
  const clean = prompt.replace(/\s+/g, ' ').trim();
  if (!clean) return '新任务';
  return clean.length > 26 ? `${clean.slice(0, 26)}…` : clean;
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool.start'; id: string; name: string; detail: string }
  | { type: 'tool.finish'; id: string; status: 'ok' | 'error'; rows?: string[] }
  | { type: 'diff'; diff: DiffFile }
  | { type: 'done' };
