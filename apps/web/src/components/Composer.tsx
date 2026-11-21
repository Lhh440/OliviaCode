import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  APPROVALS,
  MAX_ATTACHMENTS_PER_MESSAGE,
  artifactUrl,
  attachmentLabel,
  type ApprovalMode,
  type ImageAttachment,
} from '@olivia/core';
import { Icon } from '../icons';
import { usePopoverExclusive } from '../hooks/usePopoverExclusive';
import { SelectMenu, type SelectOption } from './SelectMenu';

export interface ComposerStats {
  turns: number;
  steps: number;
  tokens: number;
  window: number;
  context: number;
  /** 有价格时给出的参考费用，已格式化 */
  cost?: string;
  /** 没有真实 usage 时的估算值 */
  estimated?: boolean;
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
  modelOptions: SelectOption[];
  approval: ApprovalMode;
  workspace?: string;
  streaming: boolean;
  stats: ComposerStats;
  onOpenUsage?: () => void;
  usageOpen?: boolean;
  /** 预览打开、输入区变窄时只保留一行紧凑统计 */
  compactStats?: boolean;
  /** M8：本条消息待发送的图片 */
  attachments?: ImageAttachment[];
  /** M8：当前模型是否允许图片输入 */
  canAttach?: boolean;
  attachHint?: string;
  /** 不能附图时点纸夹/粘贴图片：把原因用可见的方式说出来 */
  onAttachBlocked?: () => void;
  onAddImage?: (dataUrl: string, name: string, source: 'paste' | 'file') => void;
  onRemoveAttachment?: (id: string) => void;
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function readAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
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
    modelOptions,
    approval,
    workspace,
    streaming,
    stats,
    onOpenUsage,
    usageOpen,
    compactStats,
    attachments = [],
    canAttach = false,
    attachHint,
    onAttachBlocked,
    onAddImage,
    onRemoveAttachment,
  } = props;

  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  usePopoverExclusive(menuOpen, () => setMenuOpen(false));

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

  const canSend = (Boolean(value.trim()) || attachments.length > 0) && !streaming;

  const acceptFiles = (files: File[]): void => {
    if (!canAttach || !onAddImage) return;
    for (const file of files.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)) {
      if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) continue;
      void readAsDataUrl(file).then((dataUrl) => {
        if (dataUrl) onAddImage(dataUrl, file.name, 'file');
      });
    }
  };

  return (
    <div
      className={`composer group relative rounded-2xl border bg-light-panelStrong dark:bg-dark-panelStrong backdrop-blur-2xl shadow-[0_16px_44px_-22px_rgba(26,31,58,0.4)] transition-all duration-300 focus-within:border-light-accent/45 dark:focus-within:border-dark-accent/45 focus-within:shadow-[0_20px_54px_-22px_rgba(26,31,58,0.5)] ${
        dragActive
          ? 'border-light-accent/70 dark:border-dark-gold/60 ring-2 ring-light-accent/20 dark:ring-dark-gold/15'
          : 'border-light-line dark:border-dark-line'
      }`}
      onDragOver={(event) => {
        if (!canAttach) return;
        event.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(event) => {
        if (!canAttach) {
          if (event.dataTransfer?.types?.includes('Files')) {
            event.preventDefault();
            onAttachBlocked?.();
          }
          return;
        }
        event.preventDefault();
        setDragActive(false);
        acceptFiles([...event.dataTransfer.files]);
      }}
    >
      {/* 古典装饰顶线 */}
      <div className="absolute inset-x-5 top-0 h-px rule-ornate opacity-60 pointer-events-none" />

      <AnimatePresence initial={false}>
        {attachments.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="flex items-center gap-2 px-3 pt-2.5 pb-1">
              <span className="text-[11.5px] text-light-inkFaint dark:text-dark-inkFaint">
                将带 {attachments.length} 张图
              </span>
              <span className="flex-1" />
              <span className="text-[11px] text-light-inkFaint dark:text-dark-inkFaint">
                历史回合只留文件名，不重复上传
              </span>
            </div>
            <div className="flex gap-2 px-3 pb-2 overflow-x-auto">
              {attachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className="relative group/img shrink-0 w-24 rounded-lg overflow-hidden border border-light-line dark:border-dark-line bg-black/10"
                  title={`${attachmentLabel(attachment)} · ${attachment.width}×${attachment.height} · ${formatBytes(attachment.bytes)}`}
                >
                  <img
                    src={artifactUrl(attachment.path)}
                    alt={attachmentLabel(attachment)}
                    className="w-full h-16 object-cover"
                  />
                  <div className="px-1 py-0.5 text-[10px] truncate text-light-inkMuted dark:text-dark-inkMuted">
                    {attachmentLabel(attachment)}
                  </div>
                  <button
                    type="button"
                    className="absolute top-1 right-1 w-5 h-5 grid place-items-center rounded-full bg-black/55 text-white hover:bg-red-500 transition-colors"
                    title="移除"
                    onClick={() => onRemoveAttachment?.(attachment.id)}
                  >
                    <Icon name="x" size={10} />
                  </button>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <textarea
        ref={ref}
        rows={1}
        value={value}
        spellCheck={false}
        placeholder={
          canAttach
            ? '给 OliviaCode 发消息：Enter 发送，Shift+Enter 换行；可粘贴或拖入图片'
            : '给 OliviaCode 发消息：Enter 发送，Shift+Enter 换行'
        }
        onChange={(event) => onChange(event.target.value)}
        onPaste={(event) => {
          const images = [...event.clipboardData.items]
            .filter((item) => item.kind === 'file' && /^image\/(png|jpeg|webp)$/i.test(item.type))
            .map((item) => item.getAsFile())
            .filter((file): file is File => Boolean(file));
          if (images.length === 0) return;
          event.preventDefault();
          // 剪贴板里明明有图，界面上却什么都不发生，等于把提示藏进无障碍标签
          if (!canAttach || !onAddImage) {
            onAttachBlocked?.();
            return;
          }
          for (const file of images) {
            void readAsDataUrl(file).then((dataUrl) => {
              if (dataUrl) onAddImage(dataUrl, file.name || '粘贴的图片', 'paste');
            });
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (!streaming) onSend();
          }
        }}
        className="w-full resize-none bg-transparent border-0 outline-none px-4 pt-3.5 pb-1 text-[15px] leading-relaxed text-light-ink dark:text-dark-ink placeholder:text-light-inkFaint dark:placeholder:text-dark-inkFaint"
        style={{ minHeight: 52 }}
      />

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        className="hidden"
        onChange={(event) => {
          acceptFiles([...(event.target.files ?? [])]);
          event.target.value = '';
        }}
      />

      <div className="flex items-center gap-1.5 px-2.5 pb-2.5 pt-1">
        {/* 左：更多 / 附图 / 审批 / 工作区 */}
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
                    className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[14px] text-left text-light-ink dark:text-dark-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors"
                  >
                    <Icon name={item.icon} size={13} className="text-light-inkMuted dark:text-dark-inkMuted" />
                    {item.label}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <button
          type="button"
          className={`w-7 h-7 grid place-items-center rounded-lg transition-colors ${
            canAttach
              ? 'text-light-inkMuted dark:text-dark-inkMuted hover:bg-black/[0.05] dark:hover:bg-white/[0.08] hover:text-light-ink dark:hover:text-dark-ink'
              : 'text-light-inkFaint/60 dark:text-dark-inkFaint/60 hover:bg-black/[0.04] dark:hover:bg-white/[0.05] cursor-help'
          }`}
          title={canAttach ? '添加图片（也可以粘贴或拖入）' : attachHint ?? '当前模型未开启图片输入'}
          aria-disabled={!canAttach}
          onClick={() => {
            // 不可用时也给一句人话，而不是点下去毫无反应
            if (!canAttach) {
              onAttachBlocked?.();
              return;
            }
            fileRef.current?.click();
          }}
        >
          <Icon name="paperclip" size={14} />
        </button>

        <span className="w-px h-4 bg-light-line dark:bg-dark-line mx-0.5" />

        {/* 审批策略 */}
        <div className="flex items-center gap-1 text-[13px] text-light-inkMuted dark:text-dark-inkMuted rounded-md hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors">
          <Icon name="shield" size={11} className="ml-1.5 shrink-0" />
          <SelectMenu
            value={approval}
            options={APPROVALS.map((option) => ({
              value: option.value,
              label: option.label,
              hint: option.hint,
            }))}
            onChange={(next) => onApproval(next as ApprovalMode)}
            placement="up"
            title="审批策略"
            ariaLabel="审批策略"
            buttonClassName="flex items-center gap-1 py-1 pr-1 rounded-md text-[13px] text-light-ink dark:text-dark-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
          />
        </div>

        {/* 工作区 */}
        <button
          type="button"
          onClick={onWorkspace}
          title={workspace ?? '绑定工作区'}
          className={`flex items-center gap-1.5 h-6 px-2 rounded-md text-[13px] transition-colors max-w-[150px] ${
            workspace
              ? 'text-light-inkMuted dark:text-dark-inkMuted hover:bg-black/[0.04] dark:hover:bg-white/[0.06]'
              : 'text-amber-600 dark:text-amber-400 bg-amber-500/10 hover:bg-amber-500/15'
          }`}
        >
          <Icon name="folder" size={11} className="shrink-0" />
          <span className="truncate">{workspace ? basename(workspace) : '项目位置'}</span>
        </button>

        <span className="flex-1" />

        {/* 统计（紧凑，点开用量抽屉） */}
        {stats.turns > 0 && (
          <button
            type="button"
            onClick={onOpenUsage}
            title="查看上下文构成与逐步用量"
            className={`${
              compactStats ? 'flex' : 'hidden md:flex'
            } items-center gap-1.5 whitespace-nowrap shrink-0 text-[12.5px] text-light-inkFaint dark:text-dark-inkFaint mr-1 tabular-nums rounded-md px-1.5 py-1 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] hover:text-light-inkMuted dark:hover:text-dark-inkMuted transition-colors`}
          >
            {compactStats ? (
              <span>
                {stats.estimated ? '≈' : ''}
                {formatTokens(stats.tokens)} · {stats.context}%
              </span>
            ) : (
              <>
                <span>{stats.turns} 轮 · {stats.steps} 步</span>
                <span className="opacity-60">|</span>
                <span>
                  {stats.estimated ? '≈' : ''}
                  {formatTokens(stats.tokens)} / {formatTokens(stats.window)}
                </span>
                <span className="opacity-60">|</span>
                <span>上下文 {stats.context}%</span>
                {stats.cost && (
                  <>
                    <span className="opacity-60">|</span>
                    <span>{stats.cost}</span>
                  </>
                )}
              </>
            )}
            <Icon name="chevron" size={10} className={usageOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />
          </button>
        )}

        {/* 模型 */}
        <SelectMenu
          value={model}
          options={modelOptions}
          onChange={onModel}
          placement="up"
          align="right"
          className="shrink-0 pl-1"
          title="模型"
          ariaLabel="模型"
          disabled={modelOptions.length === 0}
          renderValue={(option) => option?.label ?? '未配置模型'}
          buttonClassName="flex items-center gap-1 py-1 px-1.5 rounded-md text-[13px] font-medium text-light-ink dark:text-dark-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors disabled:opacity-50"
        />

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
                ? 'text-[color:var(--olivia-on-accent)] shadow-md'
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
