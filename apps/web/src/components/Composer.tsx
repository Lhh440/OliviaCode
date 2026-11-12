import { useEffect, useRef, useState } from 'react';
import { APPROVALS, MODELS, type ApprovalMode } from '@olivia/core';
import { Icon } from '../icons';

export interface ComposerStats {
  turns: number;
  steps: number;
  tokens: number;
  context: number;
}

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onModel: (model: string) => void;
  onApproval: (mode: ApprovalMode) => void;
  onWorkspace: () => void;
  onNewTask: () => void;
  onOpenGit: () => void;
  model: string;
  approval: ApprovalMode;
  workspace?: string;
  streaming: boolean;
  stats: ComposerStats;
}

function basename(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function Composer(props: ComposerProps) {
  const {
    value,
    onChange,
    onSend,
    onStop,
    onModel,
    onApproval,
    onWorkspace,
    onNewTask,
    onOpenGit,
    model,
    approval,
    workspace,
    streaming,
    stats,
  } = props;

  const ref = useRef<HTMLTextAreaElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(220, Math.max(56, el.scrollHeight))}px`;
  }, [value]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuOpen]);

  return (
    <div className="composer-wrap">
      <div className={`composer ${streaming ? 'busy' : ''}`}>
        <textarea
          ref={ref}
          rows={1}
          value={value}
          spellCheck={false}
          placeholder="发消息或创建任务，/ 调用指令，@ 文件或对话"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (!streaming) onSend();
            }
          }}
        />

        <div className="composer-bar">
          <div className="composer-left">
            <button
              type="button"
              className={`composer-plus ${menuOpen ? 'open' : ''}`}
              title="更多"
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen((open) => !open);
              }}
            >
              <Icon name="plus" size={15} />
            </button>
            {menuOpen && (
              <div className="composer-menu" onClick={(event) => event.stopPropagation()}>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onNewTask();
                  }}
                >
                  <Icon name="message" size={14} />
                  新建任务
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onWorkspace();
                  }}
                >
                  <Icon name="folder" size={14} />
                  切换工作区
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenGit();
                  }}
                >
                  <Icon name="git" size={14} />
                  打开 Git
                </button>
              </div>
            )}

            <label className="composer-chip" title="审批策略">
              <Icon name="info" size={13} />
              <select
                value={approval}
                onChange={(event) => onApproval(event.target.value as ApprovalMode)}
              >
                {APPROVALS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <Icon name="chevron" size={12} className="chip-caret" />
            </label>

            <button
              type="button"
              className={`composer-chip project ${workspace ? '' : 'unbound'}`}
              onClick={onWorkspace}
              title={workspace ?? '绑定工作区'}
            >
              <Icon name="folder" size={13} />
              <span>{workspace ? basename(workspace) : '项目位置'}</span>
            </button>
          </div>

          <div className="composer-right">
            <label className="composer-chip model" title="模型">
              <select value={model} onChange={(event) => onModel(event.target.value)}>
                {MODELS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.short}
                  </option>
                ))}
              </select>
              <Icon name="chevron" size={12} className="chip-caret" />
            </label>
            <button
              type="button"
              className={`send-btn ${streaming ? 'stop' : ''}`}
              onClick={streaming ? onStop : onSend}
              disabled={!streaming && !value.trim()}
              title={streaming ? '停止' : '发送'}
            >
              <Icon name={streaming ? 'stop' : 'send'} size={15} />
            </button>
          </div>
        </div>
      </div>

      {stats.turns > 0 && (
        <div className="composer-stats">
          <span>
            <Icon name="message" size={12} />
            {stats.turns} 轮 · {stats.steps} 步
          </span>
          <span>
            <Icon name="layers" size={12} />≈ {formatTokens(stats.tokens)} tok
          </span>
          <span>
            <Icon name="cpu" size={12} />
            上下文 {stats.context}%
          </span>
        </div>
      )}
    </div>
  );
}