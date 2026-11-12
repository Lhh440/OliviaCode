import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  type Dispatch,
  type ReactNode,
} from 'react';
import type { Message, Settings, Task, TaskStatus, ToolRun, DiffFile } from '@olivia/core';
import { uid } from '@olivia/core';
import { seedTasks } from './seed';

export interface State {
  tasks: Task[];
  activeId: string | null;
  settings: Settings;
}

export const defaultSettings: Settings = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'DeepSeek-V4.1-Flash',
  approval: 'ask',
  demo: true,
};

const STORAGE_KEY = 'olivia.state.v1';

function initState(): State {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<State>;
      if (Array.isArray(parsed.tasks) && parsed.tasks.length >= 0) {
        return {
          tasks: parsed.tasks,
          activeId: parsed.activeId ?? parsed.tasks[0]?.id ?? null,
          settings: { ...defaultSettings, ...(parsed.settings ?? {}), apiKey: '' },
        };
      }
    }
  } catch {
    // 损坏的本地状态直接丢弃，用种子数据
  }
  return { tasks: seedTasks, activeId: seedTasks[0]?.id ?? null, settings: defaultSettings };
}

export type Action =
  | { type: 'addTask'; task: Task }
  | { type: 'selectTask'; id: string }
  | { type: 'deleteTask'; id: string }
  | { type: 'addMessage'; taskId: string; message: Message }
  | { type: 'patchMessage'; taskId: string; messageId: string; patch: (message: Message) => Message }
  | { type: 'patchTask'; taskId: string; patch: Partial<Task> }
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
    approval: settings.approval,
    status: 'idle',
    at: Date.now(),
    messages: [],
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

export function finishTool(message: Message, id: string, status: 'ok' | 'error', rows?: string[]): Message {
  return {
    ...message,
    parts: message.parts.map((part) =>
      part.kind === 'tool' && part.run.id === id
        ? { kind: 'tool', run: { ...part.run, status, rows: rows ?? part.run.rows } }
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

export function deriveStatus(messages: Message[]): TaskStatus {
  const last = messages[messages.length - 1];
  if (!last) return 'idle';
  if (last.streaming) return 'running';
  const pending = messages.some((m) =>
    m.parts.some((p) => p.kind === 'diff' && p.diff.state === 'pending'),
  );
  return pending ? 'waiting' : 'done';
}
