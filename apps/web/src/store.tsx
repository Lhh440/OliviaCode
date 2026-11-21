import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  type Dispatch,
  type ReactNode,
} from 'react';
import type { Message, SessionEvent, Settings, Task, TaskStatus, ToolRun, DiffFile } from '@olivia/core';
import { DEFAULT_CONTEXT_WINDOW, replaySession, replayUsage, uid, type UsageStep } from '@olivia/core';
import { seedTasks } from './seed';

export interface State {
  tasks: Task[];
  activeId: string | null;
  settings: Settings;
}

export const defaultSettings: Settings = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-v4.1-flash',
  approval: 'ask',
  demo: true,
  allowShell: false,
  defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
  compactThreshold: 85,
};

/** 开发/自托管时可用 OLIVIA_BASE_URL / OLIVIA_API_KEY / OLIVIA_MODEL 预置连接。 */
function applyEnv<T extends { settings: Settings }>(state: T): T {
  const env = typeof window !== 'undefined' ? window.olivia?.env : undefined;
  if (!env?.apiKey) return state;
  return {
    ...state,
    settings: {
      ...state.settings,
      baseUrl: env.baseUrl || state.settings.baseUrl,
      apiKey: env.apiKey,
      model: env.model || state.settings.model,
      demo: false,
    },
  };
}

const STORAGE_KEY = 'olivia.state.v1';

function initState(): State {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<State>;
      if (Array.isArray(parsed.tasks) && parsed.tasks.length >= 0) {
        return applyEnv({
          tasks: parsed.tasks,
          activeId: parsed.activeId ?? parsed.tasks[0]?.id ?? null,
          settings: { ...defaultSettings, ...(parsed.settings ?? {}), apiKey: '' },
        });
      }
    }
  } catch {
    // 损坏的本地状态直接丢弃，用种子数据
  }
  return applyEnv({ tasks: seedTasks, activeId: seedTasks[0]?.id ?? null, settings: defaultSettings });
}

export type Action =
  | { type: 'addTask'; task: Task }
  | { type: 'selectTask'; id: string }
  | { type: 'deleteTask'; id: string }
  | { type: 'addMessage'; taskId: string; message: Message }
  | { type: 'patchMessage'; taskId: string; messageId: string; patch: (message: Message) => Message }
  | { type: 'patchTask'; taskId: string; patch: Partial<Task> }
  | { type: 'refreshStatus'; taskId: string }
  | { type: 'appendUsage'; taskId: string; usage: UsageStep }
  | { type: 'hydrateMessages'; taskId: string; messages: Message[] }
  | { type: 'settings'; patch: Partial<Settings> };

function mapTask(state: State, id: string, fn: (task: Task) => Task): State {
  return { ...state, tasks: state.tasks.map((task) => (task.id === id ? fn(task) : task)) };
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'addTask':
      return { ...state, tasks: [action.task, ...state.tasks], activeId: action.task.id };
    case 'selectTask':
      return { ...state, activeId: action.id };
    case 'deleteTask': {
      const tasks = state.tasks.filter((task) => task.id !== action.id);
      return {
        ...state,
        tasks,
        activeId: state.activeId === action.id ? tasks[0]?.id ?? null : state.activeId,
      };
    }
    case 'addMessage':
      return mapTask(state, action.taskId, (task) => ({
        ...task,
        at: Date.now(),
        messages: [...task.messages, action.message],
      }));
    case 'patchMessage':
      return mapTask(state, action.taskId, (task) => ({
        ...task,
        messages: task.messages.map((m) => (m.id === action.messageId ? action.patch(m) : m)),
      }));
    case 'patchTask':
      return mapTask(state, action.taskId, (task) => ({ ...task, ...action.patch }));
    /**
     * 手动接受/拒绝 diff、撤销写入这些路径不会产生回合事件，
     * 状态得由消息本身重算，否则徽章会一直挂在「等待确认」。
     */
    case 'refreshStatus':
      return mapTask(state, action.taskId, (task) => {
        const status = deriveStatus(task.messages, task.status);
        return status === task.status ? task : { ...task, status };
      });
    case 'appendUsage':
      return mapTask(state, action.taskId, (task) => ({
        ...task,
        usage: [...(task.usage ?? []), action.usage].slice(-400),
      }));
    case 'hydrateMessages':
      return mapTask(state, action.taskId, (task) => ({ ...task, messages: action.messages }));
    case 'settings':
      return { ...state, settings: { ...state.settings, ...action.patch } };
    default:
      return state;
  }
}

const StoreContext = createContext<{ state: State; dispatch: Dispatch<Action> } | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initState);

  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const { apiKey: _ignored, ...safeSettings } = state.settings;
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ tasks: state.tasks, activeId: state.activeId, settings: safeSettings }),
        );
      } catch {
        // 存储失败（隐私模式等）不影响使用
      }
    }, 260);
    return () => clearTimeout(timer);
  }, [state.tasks, state.activeId, state.settings]);

  /** 启动时从主进程的事件日志重放，日志是消息的权威来源。 */
  useEffect(() => {
    const api = window.olivia;
    if (!api?.task) return;
    let alive = true;
    void (async () => {
      for (const task of state.tasks) {
        if (!task.workspace) continue;
        if (!alive) return;
        const payload = await api.task.load(task.id).catch(() => null);
        // 单个任务读不到日志只跳过它，不能连累后面的任务
        if (!payload) continue;
        const events = payload.events as SessionEvent[];
        const messages = replaySession(events);
        if (messages.length > 0) {
          dispatch({ type: 'hydrateMessages', taskId: task.id, messages });
          // 重放出来的消息才是权威：顺手把上次退出时卡住的状态（执行中/等待确认）重算一遍
          dispatch({ type: 'refreshStatus', taskId: task.id });
        }
        const usage = replayUsage(events);
        if (usage.length > 0) {
          dispatch({ type: 'patchTask', taskId: task.id, patch: { usage } });
        }
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <StoreContext.Provider value={{ state, dispatch }}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore 必须在 StoreProvider 内使用');
  return ctx;
}

export function useActiveTask(): Task | null {
  const { state } = useStore();
  return state.tasks.find((task) => task.id === state.activeId) ?? null;
}

export function createTask(settings: Settings): Task {
  return {
    id: uid('task'),
    title: '新任务',
    branch: 'main',
    model: settings.model,
    providerId: settings.providerId,
    approval: settings.approval,
    status: 'idle',
    at: Date.now(),
    messages: [],
  };
}

/* —— AI 输出的「整块淡入」 ——
   上游一次只推几个字的 delta，逐条上屏就是打字机。这里把 delta 攒成完整的
   句子/短句再交给界面：句末标点一到立刻上屏；迟迟等不到标点就按节流拍子
   吐出去。观感是内容一整块一整块地浮现（对齐 Gemini），而不是逐字往外爬。 */

const SENTENCE_END = /[。！？!?…；;\n]$/;
const CLAUSE_END = /[，、：:,]/;
/** 节流拍子：等不到标点时最多压这么久 */
const HOLD_MS = 460;
/** 短句至少攒到这么长才上屏/在逗号级停顿处切开，避免把「首先」这种碎词单独打出来 */
const CLAUSE_MIN = 14;

/** 返回 buffer 里「能安全上屏」的前缀长度：句末标点优先，其次是最后一个逗号级停顿。 */
function boundaryCut(buffer: string): number {
  if (SENTENCE_END.test(buffer)) return buffer.length;
  for (let index = buffer.length - 2; index >= CLAUSE_MIN; index -= 1) {
    if (CLAUSE_END.test(buffer[index] ?? '')) return index + 1;
  }
  return 0;
}

export interface TextCoalescer {
  push(delta: string): void;
  /** 立刻清空缓冲。工具卡插入、回合收尾这类必须保序的时刻先调它。 */
  flush(): void;
  dispose(): void;
}

export function createTextCoalescer(flush: (text: string) => void): TextCoalescer {
  let buffer = '';
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** force=false：push 时同步调用，没等到边界就继续攒；force=true：节流拍子到了，攒够一个短句就整段吐出 */
  const emit = (force = false): void => {
    if (!buffer) return;
    const cut = boundaryCut(buffer);
    const out = cut > 0 ? buffer.slice(0, cut) : force && buffer.length >= CLAUSE_MIN ? buffer : '';
    if (!out) return;
    buffer = buffer.slice(out.length);
    flush(out);
  };

  const arm = (): void => {
    if (timer || !buffer) return;
    timer = setTimeout(() => {
      timer = null;
      emit(true);
      arm();
    }, HOLD_MS);
  };

  return {
    push(delta: string): void {
      buffer += delta;
      emit();
      arm();
    },
    flush(): void {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!buffer) return;
      const out = buffer;
      buffer = '';
      flush(out);
    },
    dispose(): void {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      buffer = '';
    },
  };
}

/** —— 消息分片的纯函数更新，供流式渲染调用 —— */
export function appendText(message: Message, delta: string): Message {
  const parts = [...message.parts];
  const last = parts[parts.length - 1];
  if (last && last.kind === 'text') {
    parts[parts.length - 1] = { kind: 'text', text: last.text + delta };
  } else {
    parts.push({ kind: 'text', text: delta });
  }
  return { ...message, parts };
}

export function pushTool(message: Message, run: ToolRun): Message {
  return { ...message, parts: [...message.parts, { kind: 'tool', run }] };
}

export function appendToolOutput(message: Message, callId: string, chunk: string): Message {
  return {
    ...message,
    parts: message.parts.map((part) =>
      part.kind === 'tool' && part.run.id === callId
        ? { kind: 'tool', run: { ...part.run, status: 'running', output: (part.run.output ?? '') + chunk } }
        : part,
    ),
  };
}

export function appendThinking(message: Message, delta: string): Message {
  const parts = [...message.parts];
  const last = parts[parts.length - 1];
  if (last && last.kind === 'thinking' && !last.done) {
    parts[parts.length - 1] = { ...last, text: last.text + delta };
  } else {
    parts.push({ kind: 'thinking', text: delta, done: false });
  }
  return { ...message, parts };
}

export function finishThinking(message: Message): Message {
  return {
    ...message,
    parts: message.parts.map((part) =>
      part.kind === 'thinking' && !part.done ? { ...part, done: true } : part,
    ),
  };
}

export function finishTool(
  message: Message,
  id: string,
  status: 'ok' | 'error',
  rows?: string[],
  artifacts?: string[],
): Message {
  return {
    ...message,
    parts: message.parts.map((part) =>
      part.kind === 'tool' && part.run.id === id
        ? { kind: 'tool', run: { ...part.run, status, rows: rows ?? part.run.rows, artifacts: artifacts ?? part.run.artifacts } }
        : part,
    ),
  };
}

export function pushDiff(message: Message, diff: DiffFile): Message {
  return { ...message, parts: [...message.parts, { kind: 'diff', diff }] };
}

export function settle(message: Message): Message {
  return { ...message, streaming: false };
}

export function deriveStatus(messages: Message[], current?: TaskStatus): TaskStatus {
  const last = messages[messages.length - 1];
  if (!last) return current === 'failed' || current === 'stopped' ? current : 'idle';
  if (last.streaming) return 'running';
  const pending = messages.some((m) =>
    m.parts.some((p) => p.kind === 'diff' && p.diff.state === 'pending'),
  );
  if (pending) return 'waiting';
  // 失败/中止是终局：消息里没有可推导的线索，保留原值
  if (current === 'failed' || current === 'stopped') return current;
  return 'done';
}
