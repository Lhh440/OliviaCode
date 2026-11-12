import { useEffect, useRef, useState } from 'react';
import { APPROVALS, MODELS, uid, titleFromPrompt, type Message, type TaskStatus } from '@olivia/core';
import { runTurn, type TurnHandle } from '../agent';
import { Composer } from '../components/Composer';
import { MessageList } from '../components/MessageList';
import { Icon, Mark } from '../icons';
import {
  appendText,
  deriveStatus,
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
    desc: '先建立上下文，再告诉我它是怎么串起来的',
    prompt: '先读 apps/web/src 的目录结构，用三段话讲清楚这个应用是怎么跑起来的。',
  },
  {
    icon: 'file',
    title: '按规格改一个功能',
    desc: '小步改、出 diff、自己跑测试',
    prompt: '把侧栏的任务列表改成按状态分组，并补一条键盘可达性测试。',
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
    desc: '拆任务、并行跑、合并前人工确认',
    prompt: '帮我设计一条每晚跑的重构工作流：拆解、并行、评审、人工确认、提 PR。',
  },
];

export function ChatView() {
  const { state, dispatch } = useStore();
  const task = state.tasks.find((item) => item.id === state.activeId) ?? null;
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [pendingDiff, setPendingDiff] = useState(false);
  const turnRef = useRef<TurnHandle | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const messages = task?.messages ?? [];
  const demo = !state.settings.apiKey.trim();

  useEffect(() => {
    return () => {
      turnRef.current?.cancel();
      turnRef.current = null;
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, task?.id]);

  const stop = () => {
    turnRef.current?.cancel();
    turnRef.current = null;
    setStreaming(false);
  };

  const send = () => {
    const text = draft.trim();
    if (!text || !task || streaming) return;
    setDraft('');
    setStreaming(true);
    setPendingDiff(false);

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

    dispatch({ type: 'addMessage', taskId: task.id, message: userMessage });
    dispatch({ type: 'addMessage', taskId: task.id, message: assistant });
    dispatch({
      type: 'patchTask',
      taskId: task.id,
      patch: {
        status: 'running',
        title: task.messages.length === 0 ? titleFromPrompt(text) : task.title,
      },
    });

    let hasPendingDiff = false;
    const turn = runTurn(text, state.settings, (event) => {
      switch (event.type) {
        case 'text':
          dispatch({
            type: 'patchMessage',
            taskId: task.id,
            messageId: assistant.id,
            patch: (message) => appendText(message, event.delta),
          });
          break;
        case 'tool.start':
          dispatch({
            type: 'patchMessage',
            taskId: task.id,
            messageId: assistant.id,
            patch: (message) =>
              pushTool(message, {
                id: event.id,
                name: event.name,
                detail: event.detail,
                status: 'running',
              }),
          });
          break;
        case 'tool.finish':
          dispatch({
            type: 'patchMessage',
            taskId: task.id,
            messageId: assistant.id,
            patch: (message) => finishTool(message, event.id, event.status, event.rows),
          });
          break;
        case 'diff':
          hasPendingDiff = event.diff.state === 'pending';
          setPendingDiff(event.diff.state === 'pending');
          dispatch({
            type: 'patchMessage',
            taskId: task.id,
            messageId: assistant.id,
            patch: (message) => pushDiff(message, event.diff),
          });
          break;
        case 'done':
          dispatch({
            type: 'patchMessage',
            taskId: task.id,
            messageId: assistant.id,
            patch: settle,
          });
          setStreaming(false);
          turnRef.current = null;
          dispatch({
            type: 'patchTask',
            taskId: task.id,
            patch: { status: hasPendingDiff ? 'waiting' : 'done' },
          });
          break;
      }
    });

    turnRef.current = turn;
  };

  const onDiffAction = (messageId: string, action: 'accepted' | 'rejected') => {
    if (!task) return;
    dispatch({
      type: 'patchMessage',
      taskId: task.id,
      messageId,
      patch: (message) => ({
        ...message,
        parts: message.parts.map((part) =>
          part.kind === 'diff' && part.diff.state === 'pending'
            ? { kind: 'diff', diff: { ...part.diff, state: action } }
            : part,
        ),
      }),
    });
    setPendingDiff(false);
    dispatch({
      type: 'patchTask',
      taskId: task.id,
      patch: { status: 'done' },
    });
  };

  const changeModel = (model: string) => {
    dispatch({ type: 'settings', patch: { model } });
    if (task) dispatch({ type: 'patchTask', taskId: task.id, patch: { model } });
  };

  const changeApproval = (approval: (typeof APPROVALS)[number]['value']) => {
    dispatch({ type: 'settings', patch: { approval } });
    if (task) dispatch({ type: 'patchTask', taskId: task.id, patch: { approval } });
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
          <span className="chip static" title="当前分支">
            <Icon name="git" size={13} />
            {task.branch}
          </span>
          <select
            className="chip select"
            value={task.approval}
            onChange={(event) => changeApproval(event.target.value as (typeof APPROVALS)[number]['value'])}
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
              <option key={model} value={model}>
                {model}
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
            <p className="welcome-sub">本地执行 · 改动可回滚 · 从读代码到提 PR 一条任务走完</p>
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
          </div>
        ) : (
          <MessageList messages={messages} onDiffAction={onDiffAction} />
        )}
      </div>

      <div className="chat-dock">
        <div className="chat-dock-inner">
          {streaming && (
            <div className="run-strip">
              <span className="spinner" />
              <span>正在执行，改动会先出 diff 等你确认</span>
              <button className="link-btn" onClick={stop}>
                停止
              </button>
            </div>
          )}
          {!streaming && pendingDiff && (
            <div className="run-strip waiting">
              <Icon name="gate" size={14} />
              <span>有改动待确认，接受后才会写入工作区</span>
            </div>
          )}
          <Composer value={draft} onChange={setDraft} onSend={send} disabled={streaming} />
          <div className="chat-note">
            {demo ? '演示模式：未配置密钥，回复由本地脚本回放；在设置里填入 OpenAI 兼容端点即可走真实模型。' : `已连接 ${state.settings.model} · 密钥仅在本机内存中`}
          </div>
        </div>
      </div>
    </div>
  );
}
