import { useCallback, useEffect, useRef, useState } from 'react';
import {
  APPROVALS,
  MODELS,
  modelLabel,
  uid,
  titleFromPrompt,
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
import {
  appendText,
  appendThinking,
  appendToolOutput,
  finishThinking,
  finishTool,
  pushDiff,
  pushTool,
  settle,
  useStore,
} from '../store';

const STATUS_TEXT: Record<TaskStatus, string> = {
  idle: '待开始',
  running: '执行中',
  waiting: '等待确认',
  done: '已完成',
  failed: '失败',
  stopped: '已停止',
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

  if (!task) {
    return <div className="chat-page empty-page">先从左侧新建一个任务。</div>;
  }

  return (
    <div className="chat-page">
      <header className="chat-head">
        <div className="chat-head-left">
          <h1>{task.title}</h1>
          <span className={`status-chip ${task.status}`}>
            <span className="dot" />
            {STATUS_TEXT[task.status]}
          </span>
        </div>
        <div className="chat-head-right">
          <button
            className={`chip workspace ${task.workspace ? '' : 'unbound'}`}
            onClick={() => void bindWorkspace()}
            title={task.workspace ?? '点击绑定工作区目录'}
          >
            <Icon name="folder" size={13} />
            {task.workspace ? basename(task.workspace) : '绑定目录'}
          </button>
          <select
            className="chip select"
            value={task.approval}
            onChange={(event) =>
              changeApproval(event.target.value as (typeof APPROVALS)[number]['value'])
            }
            title="审批策略"
          >
            {APPROVALS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            className="chip select"
            value={task.model}
            onChange={(event) => changeModel(event.target.value)}
            title="模型"
          >
            {MODELS.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
          <button className="icon-btn" title="更多">
            <Icon name="dots" size={16} />
          </button>
        </div>
      </header>

      <div className={`chat-scroll ${messages.length === 0 ? 'empty' : ''}`} ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="welcome">
            <div className="welcome-mark">
              <Mark size={34} />
            </div>
            <h2>今天想让 OliviaCode 做什么？</h2>
            <p className="welcome-sub">
              {task.workspace
                ? `工作区 ${basename(task.workspace)} · 改动可回滚 · 从读代码到提 PR 一条任务走完`
                : '先绑定工作区，再让它读代码、改代码、跑测试'}
            </p>
            <div className="suggestions">
              {SUGGESTIONS.map((item) => (
                <button key={item.title} className="suggestion" onClick={() => setDraft(item.prompt)}>
                  <span className="suggestion-icon">
                    <Icon name={item.icon} size={16} />
                  </span>
                  <span className="suggestion-body">
                    <b>{item.title}</b>
                    <span>{item.desc}</span>
                  </span>
                </button>
              ))}
            </div>
            {!task.workspace && (
              <button className="bind-cta" onClick={() => void bindWorkspace()}>
                <Icon name="folder" size={14} />
                选择一个本地仓库作为工作区
              </button>
            )}
          </div>
        ) : (
          <MessageList
            messages={messages}
            onDiffAction={onDiffAction}
            onUndo={onUndo}
            onPatchDecide={onPatchDecide}
          />
        )}
      </div>

      <div className="chat-dock">
        <div className="chat-dock-inner">
          {approval && <ApprovalBar request={approval.request} onDecision={decide} />}
          {notice && (
            <div className="run-strip error">
              <Icon name="alert" size={14} />
              <span>{notice}</span>
              <button className="link-btn" onClick={() => setNotice(null)}>
                知道了
              </button>
            </div>
          )}
          {undo && <UndoToast result={undo} />}
          {streaming && (
            <div className="run-strip">
              <span className="spinner" />
              <span>
                {realMode ? '执行中：读写都会先出 diff 或等你批准' : '演示模式：正在回放脚本'}
              </span>
              <button className="link-btn" onClick={stop}>
                停止
              </button>
            </div>
          )}
          <Composer value={draft} onChange={setDraft} onSend={send} disabled={streaming} />
          <div className="chat-note">
            {realMode
              ? `已连接 ${modelLabel(state.settings.model)} · 密钥与文件操作都在主进程 · ${state.settings.allowShell ? '命令执行已开启' : '命令执行未开启'}`
              : '演示模式：未配置密钥，回复由本地脚本回放；配置后走真实工具调用与快照回滚。'}
          </div>
        </div>
      </div>
    </div>
  );
}
