import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  APPROVALS,
  MODELS,
  titleFromPrompt,
  uid,
  type ApprovalDecision,
  type ApprovalRequest,
  type Message,
  type TaskStatus,
  type TurnEvent,
  type UndoResult,
} from '@olivia/core';
import { runDemoTurn, type TurnHandle } from '../agent';
import { Composer } from '../components/Composer';
import { ApprovalBar, MessageList, UndoToast } from '../components/MessageList';
import { Icon, Mark } from '../icons';
import { navigate } from '../router';
import { createTask, useStore } from '../store';
import {
  appendText,
  appendThinking,
  appendToolOutput,
  finishThinking,
  finishTool,
  pushDiff,
  pushTool,
  settle,
} from '../store';

const STATUS_TEXT: Record<TaskStatus, string> = {
  idle: '待开始',
  running: '执行中',
  waiting: '等待确认',
  done: '已完成',
  failed: '失败',
  stopped: '已停止',
};

const STATUS_TONE: Record<TaskStatus, string> = {
  idle: 'text-light-inkMuted dark:text-dark-inkMuted bg-black/[0.05] dark:bg-white/[0.07]',
  running: 'text-blue-600 dark:text-blue-400 bg-blue-500/10',
  waiting: 'text-amber-600 dark:text-amber-400 bg-amber-500/10',
  done: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10',
  failed: 'text-red-600 dark:text-red-400 bg-red-500/10',
  stopped: 'text-light-inkMuted dark:text-dark-inkMuted bg-black/[0.05] dark:bg-white/[0.07]',
};

const SUGGESTIONS = [
  {
    icon: 'search',
    title: '读懂一个模块',
    desc: '先建上下文，再讲清它怎么串起来',
    prompt: '先读工作区结构，用三段话讲清楚这个项目是怎么跑起来的。',
  },
  {
    icon: 'file',
    title: '按规格改一个功能',
    desc: '小步改、出 diff、自己跑测试',
    prompt: '把侧栏的任务列表改成按状态分组，并自己跑一遍测试。',
  },
  {
    icon: 'shield',
    title: '评审我的改动',
    desc: '干净上下文，只挑真问题',
    prompt: '评审当前工作区的未提交改动，只报正确性和安全问题，按严重程度排序。',
  },
  {
    icon: 'workflow',
    title: '排一条工作流',
    desc: '拆任务、并行跑、合并前确认',
    prompt: '帮我设计一条每晚跑的重构工作流：拆解、并行、评审、人工确认、提 PR。',
  },
];

function basename(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

export function ChatView() {
  const { state, dispatch } = useStore();
  const task = state.tasks.find((item) => item.id === state.activeId) ?? null;
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [approval, setApproval] = useState<{ turnId: string; request: ApprovalRequest } | null>(null);
  const [undo, setUndo] = useState<UndoResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const demoRef = useRef<TurnHandle | null>(null);
  const activeRef = useRef<{ turnId: string; messageId: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taskRef = useRef(task);
  taskRef.current = task;

  const messages = task?.messages ?? [];

  const stats = useMemo(() => {
    let steps = 0;
    let chars = 0;
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.kind === 'tool') steps += 1;
        if (part.kind === 'text') chars += part.text.length;
        if (part.kind === 'thinking') chars += part.text.length;
        if (part.kind === 'diff') {
          chars += part.diff.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0) * 32;
        }
      }
    }
    const tokens = Math.round(chars / 3.4);
    const percent = Math.min(99, (tokens / 128_000) * 100);
    return {
      turns: messages.filter((message) => message.role === 'user').length,
      steps,
      tokens,
      context: tokens === 0 ? 0 : percent < 1 ? Number(percent.toFixed(1)) : Math.round(percent),
    };
  }, [messages]);
  const realMode = Boolean(state.settings.apiKey.trim()) && Boolean(window.olivia?.turn);

  const patchMessage = useCallback(
    (messageId: string, patch: (message: Message) => Message) => {
      const current = taskRef.current;
      if (!current) return;
      dispatch({ type: 'patchMessage', taskId: current.id, messageId, patch });
    },
    [dispatch],
  );

  const handleEvent = useCallback(
    (turnId: string, event: TurnEvent) => {
      const active = activeRef.current;
      if (!active || active.turnId !== turnId) return;
      const messageId = active.messageId;
      const current = taskRef.current;

      switch (event.type) {
        case 'text':
          patchMessage(messageId, (message) => appendText(finishThinking(message), event.delta));
          break;
        case 'thinking':
          patchMessage(messageId, (message) => appendThinking(message, event.delta));
          break;
        case 'tool.request':
          patchMessage(messageId, (message) =>
            pushTool(message, {
              id: event.call.callId,
              name: event.call.name,
              detail: event.call.detail,
              status: event.needsApproval ? 'waiting' : 'running',
              risk: event.call.risk,
              args: event.call.args,
            }),
          );
          if (event.needsApproval) setApproval({ turnId, request: event.call });
          break;
        case 'tool.result':
          patchMessage(messageId, (message) =>
            finishTool(message, event.callId, event.status, event.rows),
          );
          setApproval((value) => (value?.request.callId === event.callId ? null : value));
          break;
        case 'command.output':
          patchMessage(messageId, (message) =>
            appendToolOutput(message, event.callId, event.chunk),
          );
          break;
        case 'file.proposed':
          patchMessage(messageId, (message) =>
            pushDiff(message, {
              file: event.path,
              adds: event.adds,
              dels: event.dels,
              hunks: event.edits.flatMap((edit) => edit.hunks),
              state: 'pending',
              callId: event.callId,
              edits: event.edits,
            }),
          );
          break;
        case 'file.changed':
          patchMessage(messageId, (message) => {
            const index = message.parts.findIndex(
              (part) => part.kind === 'diff' && event.callId && part.diff.callId === event.callId,
            );
            if (index >= 0) {
              const parts = [...message.parts];
              const current = parts[index];
              if (current && current.kind === 'diff') {
                parts[index] = {
                  kind: 'diff',
                  diff: {
                    ...current.diff,
                    adds: event.adds,
                    dels: event.dels,
                    hunks: event.hunks,
                    state: 'accepted',
                    snapshotId: event.snapshotId,
                  },
                };
              }
              return { ...message, parts };
            }
            return pushDiff(message, {
              file: event.path,
              adds: event.adds,
              dels: event.dels,
              hunks: event.hunks,
              state: 'accepted',
              snapshotId: event.snapshotId,
            });
          });
          break;
        case 'turn.done': {
          patchMessage(messageId, (message) => settle(finishThinking(message)));
          activeRef.current = null;
          setStreaming(false);
          setApproval(null);
          if (!event.ok && event.error) setNotice(event.error);
          if (current) {
            dispatch({
              type: 'patchTask',
              taskId: current.id,
              patch: { status: event.ok ? 'done' : 'failed' },
            });
          }
          break;
        }
        default:
          break;
      }
    },
    [dispatch, patchMessage],
  );

  useEffect(() => {
    const api = window.olivia;
    if (!api?.turn) return;
    const off = api.turn.onEvent(({ taskId, turnId, event }) => {
      if (taskId !== taskRef.current?.id) return;
      handleEvent(turnId, event);
    });
    return off;
  }, [handleEvent]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, task?.id]);

  useEffect(() => {
    return () => {
      demoRef.current?.cancel();
      demoRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), 4200);
    return () => clearTimeout(timer);
  }, [undo]);

  // 空闲时让版画显形；进入对话后退为氛围
  const hasMessages = messages.length > 0;
  useEffect(() => {
    document.documentElement.dataset.density = hasMessages ? 'work' : 'idle';
  }, [hasMessages]);

  const bindWorkspace = useCallback(async (): Promise<string | null> => {
    const api = window.olivia;
    const current = taskRef.current;
    if (!api || !current) return null;
    if (current.workspace) return current.workspace;
    const preset = api.env?.workspace;
    const picked = preset || (await api.workspace.pick());
    if (!picked) return null;
    const check = await api.workspace.check(picked);
    if (!check.ok) {
      setNotice(check.message);
      return null;
    }
    dispatch({ type: 'patchTask', taskId: current.id, patch: { workspace: picked } });
    return picked;
  }, [dispatch]);

  const startReal = async (text: string): Promise<void> => {
    const api = window.olivia;
    const current = taskRef.current;
    if (!api?.turn || !current) return;

    let workspace = current.workspace ?? '';
    if (!workspace) {
      const picked = await bindWorkspace();
      if (!picked) {
        setNotice('先给这个任务绑定一个工作区目录');
        return;
      }
      workspace = picked;
    }

    const userMessage: Message = {
      id: uid('m'),
      role: 'user',
      at: Date.now(),
      parts: [{ kind: 'text', text }],
    };
    const assistant: Message = {
      id: uid('m'),
      role: 'assistant',
      at: Date.now(),
      parts: [],
      streaming: true,
    };
    dispatch({ type: 'addMessage', taskId: current.id, message: userMessage });
    dispatch({ type: 'addMessage', taskId: current.id, message: assistant });
    dispatch({
      type: 'patchTask',
      taskId: current.id,
      patch: {
        status: 'running',
        title: current.messages.length === 0 ? titleFromPrompt(text) : current.title,
      },
    });

    const history = current.messages
      .slice(-12)
      .map((message) => ({
        role: message.role,
        content: message.parts
          .filter((part) => part.kind === 'text')
          .map((part) => (part.kind === 'text' ? part.text : ''))
          .join('\n')
          .trim(),
      }))
      .filter((message) => message.content.length > 0);

    const turnId = uid('turn');
    activeRef.current = { turnId, messageId: assistant.id };
    setStreaming(true);
    setNotice(null);

    const result = await api.turn.start({
      turnId,
      taskId: current.id,
      workspace,
      prompt: text,
      model: state.settings.model,
      approval: state.settings.approval,
      allowShell: state.settings.allowShell,
      baseUrl: state.settings.baseUrl,
      apiKey: state.settings.apiKey,
      history,
    });

    if (!result.ok) {
      activeRef.current = null;
      setStreaming(false);
      setNotice(result.error ?? '回合启动失败');
      dispatch({ type: 'patchTask', taskId: current.id, patch: { status: 'failed' } });
    }
  };

  const startDemo = (text: string): void => {
    const current = taskRef.current;
    if (!current) return;
    const userMessage: Message = {
      id: uid('m'),
      role: 'user',
      at: Date.now(),
      parts: [{ kind: 'text', text }],
    };
    const assistant: Message = {
      id: uid('m'),
      role: 'assistant',
      at: Date.now(),
      parts: [],
      streaming: true,
    };
    dispatch({ type: 'addMessage', taskId: current.id, message: userMessage });
    dispatch({ type: 'addMessage', taskId: current.id, message: assistant });
    dispatch({
      type: 'patchTask',
      taskId: current.id,
      patch: {
        status: 'running',
        title: current.messages.length === 0 ? titleFromPrompt(text) : current.title,
      },
    });
    setStreaming(true);
    let pending = false;

    const turn = runDemoTurn(text, (event) => {
      switch (event.type) {
        case 'text':
          patchMessage(assistant.id, (message) => appendText(finishThinking(message), event.delta));
          break;
        case 'thinking':
          patchMessage(assistant.id, (message) => appendThinking(message, event.delta));
          break;
        case 'tool.start':
          patchMessage(assistant.id, (message) =>
            pushTool(message, {
              id: event.id,
              name: event.name,
              detail: event.detail,
              status: 'running',
            }),
          );
          break;
        case 'tool.finish':
          patchMessage(assistant.id, (message) =>
            finishTool(message, event.id, event.status, event.rows),
          );
          break;
        case 'diff':
          pending = event.diff.state === 'pending';
          patchMessage(assistant.id, (message) => pushDiff(message, event.diff));
          break;
        case 'done':
          patchMessage(assistant.id, (message) => settle(finishThinking(message)));
          setStreaming(false);
          dispatch({
            type: 'patchTask',
            taskId: current.id,
            patch: { status: pending ? 'waiting' : 'done' },
          });
          break;
        default:
          break;
      }
    });
    demoRef.current = turn;
  };

  const send = (): void => {
    const text = draft.trim();
    if (!text || !task || streaming) return;
    setDraft('');
    if (realMode) void startReal(text);
    else startDemo(text);
  };

  const stop = (): void => {
    demoRef.current?.cancel();
    demoRef.current = null;
    const active = activeRef.current;
    if (active) window.olivia?.turn.cancel(active.turnId);
    activeRef.current = null;
    setStreaming(false);
  };

  const decide = (decision: ApprovalDecision): void => {
    if (!approval) return;
    window.olivia?.turn.approve(approval.turnId, approval.request.callId, decision);
    setApproval(null);
  };

  const onDiffAction = (messageId: string, action: 'accepted' | 'rejected'): void => {
    patchMessage(messageId, (message) => ({
      ...message,
      parts: message.parts.map((part) =>
        part.kind === 'diff' && part.diff.state === 'pending'
          ? { kind: 'diff', diff: { ...part.diff, state: action } }
          : part,
      ),
    }));
  };

  const onUndo = async (messageId: string, snapshotId?: string): Promise<void> => {
    const api = window.olivia;
    const current = taskRef.current;
    if (!api || !current || !current.workspace) {
      setNotice('这个任务还没有绑定工作区，无法撤销');
      return;
    }
    const result = await api.task.undo(current.id, current.workspace, snapshotId);
    setUndo(result);
    if (result.ok) {
      patchMessage(messageId, (message) => ({
        ...message,
        parts: message.parts.map((part) =>
          part.kind === 'diff' &&
          part.diff.state === 'accepted' &&
          (!snapshotId || part.diff.snapshotId === snapshotId)
            ? { kind: 'diff', diff: { ...part.diff, state: 'undone' } }
            : part,
        ),
      }));
    }
  };

  const onPatchDecide = (
    messageId: string,
    callId: string,
    accepted: number[] | null,
  ): void => {
    const active = activeRef.current;
    if (active) window.olivia?.turn.patch(active.turnId, callId, accepted);
    patchMessage(messageId, (message) => ({
      ...message,
      parts: message.parts.map((part) =>
        part.kind === 'diff' && part.diff.callId === callId
          ? {
              kind: 'diff',
              diff: { ...part.diff, state: accepted && accepted.length > 0 ? 'accepted' : 'rejected' },
            }
          : part,
      ),
    }));
  };

  const changeModel = (model: string): void => {
    dispatch({ type: 'settings', patch: { model } });
    if (task) dispatch({ type: 'patchTask', taskId: task.id, patch: { model } });
  };

  const changeApproval = (approvalMode: (typeof APPROVALS)[number]['value']): void => {
    dispatch({ type: 'settings', patch: { approval: approvalMode } });
    if (task) dispatch({ type: 'patchTask', taskId: task.id, patch: { approval: approvalMode } });
  };

  /* ————————————————— 空状态 ————————————————— */
  if (!task) {
    return (
      <div className="flex-1 grid place-items-center px-8">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="text-center max-w-md"
        >
          <div className="mx-auto mb-6 w-16 h-16 rounded-full grid place-items-center border border-light-lineStrong dark:border-dark-lineStrong bg-white/60 dark:bg-white/[0.06] backdrop-blur-md shadow-lg animate-floaty">
            <Mark size={30} />
          </div>
          <h1 className="text-[26px] font-semibold mb-2 text-light-ink dark:text-dark-ink">
            还没有打开的任务
          </h1>
          <p className="text-[13px] text-light-inkMuted dark:text-dark-inkMuted mb-6 leading-relaxed">
            每一段对话都是一次委托。先创建任务，
            <br />
            再让它读代码、改代码、跑测试。
          </p>
          <button
            className="btn-solid h-9 px-5 text-[13px]"
            onClick={() => {
              dispatch({ type: 'addTask', task: createTask(state.settings) });
              navigate('chat');
            }}
          >
            <Icon name="plus" size={14} />
            新建任务
          </button>
        </motion.div>
      </div>
    );
  }

  const isEmpty = messages.length === 0;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* ——— 页头 ——— */}
      <header className="shrink-0 flex items-center gap-4 px-7 py-3.5 border-b border-light-gold/20 dark:border-dark-gold/12 bg-light-bg/55 dark:bg-black/35 backdrop-blur-xl">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <h1 className="text-[17px] font-semibold leading-tight truncate text-light-ink dark:text-dark-ink">
              {task.title}
            </h1>
            <span
              className={`shrink-0 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10.5px] font-medium ${STATUS_TONE[task.status]}`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full bg-current ${task.status === 'running' ? 'animate-pulse' : ''}`}
              />
              {STATUS_TEXT[task.status]}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-3 text-[11.5px] text-light-inkFaint dark:text-dark-inkFaint">
            <span className="inline-flex items-center gap-1">
              <Icon name="git" size={11} />
              {task.branch}
            </span>
            {task.workspace && (
              <span className="inline-flex items-center gap-1 truncate">
                <Icon name="folder" size={11} />
                {basename(task.workspace)}
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-1">
          <button
            className="btn-ghost"
            title="删除任务"
            onClick={() => {
              if (window.confirm(`删除任务「${task.title}」？`)) {
                dispatch({ type: 'deleteTask', id: task.id });
              }
            }}
          >
            <Icon name="x" size={13} />
          </button>
          <button className="btn-ghost" title="更多">
            <Icon name="dots" size={15} />
          </button>
        </div>
      </header>

      {/* ——— 对话区：不设外框，内容直接浮在版画上（背景若隐若现） ——— */}
      <div className="flex-1 min-h-0 px-6 pt-3 pb-1">
        <div
          ref={scrollRef}
          className="h-full w-full max-w-[860px] mx-auto overflow-y-auto px-1 flex flex-col isolate"
        >
          {isEmpty ? (
            <div className="m-auto w-full max-w-2xl py-6">
            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="text-center mb-8">
                <span className="eyebrow block mb-4">Atelier · 古典 × 超现实</span>
                <h2 className="text-plate text-[30px] font-semibold leading-[1.15] tracking-tight mb-3">
                  今天想让 OliviaCode 做什么？
                </h2>
                <p className="text-[12.5px] leading-relaxed text-light-inkMuted dark:text-dark-inkMuted max-w-lg mx-auto">
                  {task.workspace
                    ? `工作区 ${basename(task.workspace)} · 改动可回滚 · 从读代码到提 PR 一条任务走完`
                    : '先绑定工作区，再让它读代码、改代码、跑测试'}
                </p>
                <div className="mx-auto mt-5 h-px w-28 rule-ornate" />
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                {SUGGESTIONS.map((item, index) => (
                  <motion.button
                    key={item.title}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.35, delay: 0.06 * index }}
                    whileHover={{ y: -3 }}
                    onClick={() => setDraft(item.prompt)}
                    className="group text-left p-3.5 rounded-xl border border-light-line/90 dark:border-dark-line bg-light-panelStrong dark:bg-dark-panelStrong backdrop-blur-xl shadow-[0_2px_10px_-6px_rgba(22,24,31,0.25)] hover:border-light-gold/50 dark:hover:border-dark-gold/40 hover:shadow-[0_10px_26px_-14px_rgba(22,24,31,0.35)] transition-all duration-300"
                  >
                    <span className="flex items-center gap-2 mb-1.5">
                      <span className="w-6 h-6 rounded-md grid place-items-center bg-light-accent/10 dark:bg-dark-accent/15 text-light-accent dark:text-dark-accent">
                        <Icon name={item.icon} size={12} />
                      </span>
                      <b className="font-serif text-[13px] font-semibold text-light-ink dark:text-dark-ink">
                        {item.title}
                      </b>
                    </span>
                    <span className="block text-[11.5px] leading-relaxed text-light-inkMuted dark:text-dark-inkMuted">
                      {item.desc}
                    </span>
                  </motion.button>
                ))}
              </div>

              {!task.workspace && (
                <div className="mt-6 text-center">
                  <button
                    className="btn-outline h-8 px-4"
                    onClick={() => void bindWorkspace()}
                  >
                    <Icon name="folder" size={13} />
                    选择一个本地仓库作为工作区
                  </button>
                </div>
              )}
            </motion.div>
          </div>
        ) : (
          <div className="w-full py-2">
            <MessageList
              messages={messages}
              onDiffAction={onDiffAction}
              onUndo={onUndo}
              onPatchDecide={onPatchDecide}
              model={task.model}
              status={task.status}
              streaming={streaming}
            />
          </div>
        )}
        </div>
      </div>

      {/* ——— 输入区 ——— */}
      <div className="shrink-0 px-6 pb-5 pt-2">
        <div className="max-w-[860px] mx-auto space-y-2">
          <AnimatePresence>{approval && <ApprovalBar request={approval.request} onDecision={decide} />}</AnimatePresence>

          <AnimatePresence>
            {notice && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                className="flex items-center gap-2.5 px-3 py-2 rounded-xl border border-red-500/30 bg-red-500/[0.08] backdrop-blur-md text-[12.5px] text-red-700 dark:text-red-300"
              >
                <Icon name="alert" size={13} />
                <span className="flex-1">{notice}</span>
                <button className="btn-ghost h-6" onClick={() => setNotice(null)}>
                  知道了
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>{undo && <UndoToast result={undo} />}</AnimatePresence>

          <AnimatePresence>
            {streaming && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="flex items-center gap-2.5 px-3 py-2 rounded-xl border border-light-line dark:border-dark-line bg-white/55 dark:bg-white/[0.05] backdrop-blur-md text-[12px] text-light-inkMuted dark:text-dark-inkMuted overflow-hidden"
              >
                <span className="w-3.5 h-3.5 rounded-full border-[1.5px] border-light-accent dark:border-dark-gold border-t-transparent animate-spin" />
                <span className="flex-1">
                  {realMode ? '执行中：读写都会先出 diff 或等你批准' : '演示模式：正在回放脚本'}
                </span>
                <button className="btn-ghost h-6" onClick={stop}>
                  停止
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          <Composer
            value={draft}
            onChange={setDraft}
            onSend={send}
            onStop={stop}
            onModel={changeModel}
            onApproval={changeApproval}
            onWorkspace={() => void bindWorkspace()}
            onNewTask={() => {
              dispatch({ type: 'addTask', task: createTask(state.settings) });
            }}
            onOpenGit={() => navigate('git')}
            model={task.model}
            approval={task.approval}
            workspace={task.workspace}
            streaming={streaming}
            stats={stats}
          />
        </div>
      </div>
    </div>
  );
}
