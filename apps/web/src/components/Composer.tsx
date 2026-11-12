import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
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
    el.style.height = `${Math.min(220, Math.max(52, el.scrollHeight))}px`;
  }, [value]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuOpen]);

  const canSend = Boolean(value.trim()) && !streaming;

  return (
    <div className="group relative rounded-2xl border border-light-line dark:border-dark-line bg-light-panelStrong dark:bg-dark-panelStrong backdrop-blur-2xl shadow-[0_16px_44px_-22px_rgba(26,31,58,0.4)] transition-all duration-300 focus-within:border-light-accent/45 dark:focus-within:border-dark-accent/45 focus-within:shadow-[0_20px_54px_-22px_rgba(26,31,58,0.5)]">
      {/* 古典装饰顶线 */}
      <div className="absolute inset-x-5 top-0 h-px rule-ornate opacity-60 pointer-events-none" />

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
        className="w-full resize-none bg-transparent border-0 outline-none px-4 pt-3.5 pb-1 text-[13.5px] leading-relaxed text-light-ink dark:text-dark-ink placeholder:text-light-inkFaint dark:placeholder:text-dark-inkFaint"
        style={{ minHeight: 52 }}
      />

      <div className="flex items-center gap-1.5 px-2.5 pb-2.5 pt-1">
        {/* 左：更多 / 审批 / 工作区 */}
        <div className="relative">
          <button
            type="button"
            className="w-7 h-7 grid place-items-center rounded-lg text-light-inkMuted dark:text-dark-inkMuted hover:bg-black/[0.05] dark:hover:bg-white/[0.08] hover:text-light-ink dark:hover:text-dark-ink transition-colors"
            title="更多"
            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen((open) => !open);
            }}
          >
            <Icon name="plus" size={15} />
          </button>

          <AnimatePresence>
            {menuOpen && (
              <motion.div
                initial={{ opacity: 0, y: 6, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 6, scale: 0.97 }}
                transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                onClick={(event) => event.stopPropagation()}
                className="absolute bottom-full left-0 mb-2 w-44 p-1 rounded-xl border border-light-line dark:border-dark-line bg-light-panelStrong dark:bg-dark-panelStrong backdrop-blur-2xl shadow-2xl z-30"
              >
                {[
                  { icon: 'message', label: '新建任务', action: onNewTask },
                  { icon: 'folder', label: '切换工作区', action: onWorkspace },
                  { icon: 'git', label: '打开 Git', action: onOpenGit },
                ].map((item) => (
                  <button
                    key={item.label}
                    onClick={() => {
                      setMenuOpen(false);
                      item.action();
                    }}
                    className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[12.5px] text-left text-light-ink dark:text-dark-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors"
                  >
                    <Icon name={item.icon} size={13} className="text-light-inkMuted dark:text-dark-inkMuted" />
                    {item.label}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <span className="w-px h-4 bg-light-line dark:bg-dark-line mx-0.5" />

        {/* 审批策略 */}
        <div className="flex items-center gap-1 text-[11.5px] text-light-inkMuted dark:text-dark-inkMuted rounded-md hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors">
          <Icon name="shield" size={11} className="ml-1.5 shrink-0" />
          <select
            value={approval}
            onChange={(event) => onApproval(event.target.value as ApprovalMode)}
            className="bg-transparent border-0 outline-none cursor-pointer py-1 pr-1 text-[11.5px] text-light-ink dark:text-dark-ink"
          >
            {APPROVALS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {/* 工作区 */}
        <button
          type="button"
          onClick={onWorkspace}
          title={workspace ?? '绑定工作区'}
          className={`flex items-center gap-1.5 h-6 px-2 rounded-md text-[11.5px] transition-colors max-w-[150px] ${
            workspace
              ? 'text-light-inkMuted dark:text-dark-inkMuted hover:bg-black/[0.04] dark:hover:bg-white/[0.06]'
              : 'text-amber-600 dark:text-amber-400 bg-amber-500/10 hover:bg-amber-500/15'
          }`}
        >
          <Icon name="folder" size={11} className="shrink-0" />
          <span className="truncate">{workspace ? basename(workspace) : '项目位置'}</span>
        </button>

        <span className="flex-1" />

        {/* 统计（紧凑） */}
        {stats.turns > 0 && (
          <span className="hidden md:flex items-center gap-2.5 text-[11px] text-light-inkFaint dark:text-dark-inkFaint mr-1 tabular-nums">
            <span>{stats.turns} 轮 · {stats.steps} 步</span>
            <span className="opacity-60">|</span>
            <span>{formatTokens(stats.tokens)} tok</span>
            <span className="opacity-60">|</span>
            <span>上下文 {stats.context}%</span>
          </span>
        )}

        {/* 模型 */}
        <div className="flex items-center gap-1 pl-1 text-[11.5px]">
          <select
            value={model}
            onChange={(event) => onModel(event.target.value)}
            className="bg-transparent border-0 outline-none cursor-pointer py-1 px-1.5 rounded-md text-[11.5px] font-medium text-light-ink dark:text-dark-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
            title="模型"
          >
            {MODELS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.short}
              </option>
            ))}
          </select>
        </div>

        {/* 发送 / 停止 */}
        <motion.button
          type="button"
          onClick={streaming ? onStop : onSend}
          disabled={!canSend}
          whileHover={canSend ? { scale: 1.04 } : undefined}
          whileTap={canSend ? { scale: 0.95 } : undefined}
          className={`relative w-8 h-8 grid place-items-center rounded-lg transition-all duration-200 ${
            streaming
              ? 'bg-red-500 text-white shadow-md shadow-red-500/30'
              : canSend
                ? 'text-white shadow-md'
                : 'bg-black/[0.06] dark:bg-white/[0.07] text-light-inkFaint dark:text-dark-inkFaint cursor-not-allowed'
          }`}
          style={
            canSend && !streaming
              ? {
                  background: 'var(--olivia-accent)',
                  boxShadow: '0 6px 16px -8px color-mix(in srgb, var(--olivia-accent) 75%, transparent)',
                }
              : undefined
          }
          title={streaming ? '停止' : '发送'}
        >
          <Icon name={streaming ? 'stop' : 'send'} size={14} />
        </motion.button>
      </div>
    </div>
  );
}
