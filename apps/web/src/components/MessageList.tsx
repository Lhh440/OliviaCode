import { useState, type JSX } from 'react';
import { motion } from 'framer-motion';
import {
  modelLabel,
  type ApprovalDecision,
  type ApprovalRequest,
  type DiffFile,
  type Message,
  type Part,
  type TaskStatus,
  type ToolRun,
  type UndoResult,
} from '@olivia/core';
import { Icon, Mark } from '../icons';
import { Markdown } from './Markdown';

const TOOL_ICON: Record<string, string> = {
  read_file: 'file',
  read: 'file',
  search: 'search',
  grep: 'search',
  apply_patch: 'file',
  write: 'file',
  write_file: 'file',
  run_command: 'terminal',
  shell: 'terminal',
  list_dir: 'folder',
  git_status: 'git',
  git_diff: 'git',
  git_commit: 'git',
  git_push: 'git',
  git_create_pr: 'git',
};

const STATUS_TONE: Record<string, string> = {
  ok: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10',
  error: 'text-red-600 dark:text-red-400 bg-red-500/10',
  running: 'text-blue-600 dark:text-blue-400 bg-blue-500/10',
  waiting: 'text-amber-600 dark:text-amber-400 bg-amber-500/10',
};

function hhmm(at?: number): string {
  if (!at) return '';
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function dayLabel(at?: number): string {
  if (!at) return '今天';
  const date = new Date(at);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return '今天';
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

/* ───────────────────────── 工具卡 ───────────────────────── */

function ToolCard({ run }: { run: ToolRun }) {
  const lines = (run.output ?? '').split('\n').filter(Boolean).slice(-8);
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-light-line/80 dark:border-dark-line bg-white/45 dark:bg-white/[0.03] backdrop-blur-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors"
      >
        <span className={`w-6 h-6 rounded-md grid place-items-center shrink-0 ${STATUS_TONE[run.status] ?? ''}`}>
          <Icon name={TOOL_ICON[run.name] ?? 'terminal'} size={12} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-mono text-light-ink dark:text-dark-ink truncate">{run.name}</span>
          <span className="block text-[11px] text-light-inkFaint dark:text-dark-inkFaint truncate">{run.detail}</span>
        </span>
        <span className="shrink-0 flex items-center gap-2">
          {run.status === 'waiting' && (
            <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400">
              等待授权
            </span>
          )}
          {run.status === 'running' && (
            <span className="w-3 h-3 rounded-full border-[1.5px] border-blue-500 border-t-transparent animate-spin" />
          )}
          {run.status === 'ok' && <Icon name="check" size={13} className="text-emerald-600 dark:text-emerald-400" />}
          {run.status === 'error' && <Icon name="x" size={13} className="text-red-600 dark:text-red-400" />}
        </span>
      </button>

      {run.rows && run.rows.length > 0 && run.status !== 'running' && (
        <div className="px-3 pb-2 space-y-0.5">
          {run.rows.map((row, index) => (
            <div key={`${row}-${index}`} className="text-[11px] font-mono text-light-inkMuted dark:text-dark-inkMuted">
              {row}
            </div>
          ))}
        </div>
      )}

      {lines.length > 0 && open && (
        <pre className="px-3 py-2 text-[11px] font-mono leading-relaxed overflow-x-auto border-t border-light-line/70 dark:border-dark-line bg-black/[0.03] dark:bg-black/25 text-light-inkMuted dark:text-dark-inkMuted">
          {lines.join('\n')}
        </pre>
      )}
    </div>
  );
}

/* ───────────────────────── diff ───────────────────────── */

const DIFF_STATE_LABEL: Record<DiffFile['state'], string> = {
  pending: '待确认',
  accepted: '已应用',
  rejected: '已拒绝',
  undone: '已撤销',
};

function HunkLines({ diff }: { diff: DiffFile }) {
  return (
    <div className="divide-y divide-light-line/60 dark:divide-dark-line/60">
      {diff.hunks.map((hunk, index) => (
        <div key={`${hunk.header}-${index}`}>
          <div className="px-3 py-1 text-[10.5px] font-mono text-light-inkFaint dark:text-dark-inkFaint bg-black/[0.03] dark:bg-white/[0.03]">
            {hunk.header}
          </div>
          {hunk.lines.map((line, lineIndex) => (
            <div
              key={lineIndex}
              className={
                line.kind === 'add'
                  ? 'flex bg-emerald-500/[0.09]'
                  : line.kind === 'del'
                    ? 'flex bg-red-500/[0.09]'
                    : 'flex'
              }
            >
              <span
                className={`w-6 shrink-0 text-center select-none text-[10.5px] font-mono pt-[3px] ${
                  line.kind === 'add'
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : line.kind === 'del'
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-light-inkFaint dark:text-dark-inkFaint'
                }`}
              >
                {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
              </span>
              <span className="flex-1 px-2 py-[3px] text-[11px] font-mono whitespace-pre-wrap break-all text-light-ink dark:text-dark-ink">
                {line.text}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function ProposalCard({
  diff,
  onDecide,
}: {
  diff: DiffFile;
  onDecide: (accepted: number[] | null) => void;
}) {
  const edits = diff.edits ?? [];
  const [selected, setSelected] = useState<number[]>(() => edits.map((edit) => edit.index));
  const toggle = (index: number): void => {
    setSelected((current) =>
      current.includes(index) ? current.filter((item) => item !== index) : [...current, index].sort((a, b) => a - b),
    );
  };

  return (
    <div className="rounded-xl overflow-hidden border border-amber-500/35 dark:border-amber-400/30 bg-white/55 dark:bg-white/[0.04] backdrop-blur-sm">
      <div className="flex items-center gap-2.5 px-3 py-2 border-b border-light-line/70 dark:border-dark-line bg-amber-500/[0.07]">
        <Icon name="file" size={12} className="text-amber-600 dark:text-amber-400" />
        <span className="flex-1 min-w-0 text-[12px] font-medium font-mono truncate text-light-ink dark:text-dark-ink">
          {diff.file}
        </span>
        <span className="text-[10.5px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
          +{diff.adds}
        </span>
        <span className="text-[10.5px] font-mono px-1.5 py-0.5 rounded bg-red-500/10 text-red-600 dark:text-red-400">
          −{diff.dels}
        </span>
        <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400">
          {edits.length} 处
        </span>
      </div>

      <div className="p-2 space-y-1.5">
        {edits.map((edit) => {
          const on = selected.includes(edit.index);
          return (
            <div
              key={edit.index}
              className={`rounded-lg overflow-hidden border transition-colors ${
                on
                  ? 'border-amber-500/40 dark:border-amber-400/35 bg-amber-500/[0.05]'
                  : 'border-light-line/70 dark:border-dark-line bg-black/[0.02] dark:bg-white/[0.02] opacity-65'
              }`}
            >
              <button
                type="button"
                onClick={() => toggle(edit.index)}
                className="w-full flex items-center gap-2.5 px-2.5 py-1.5 text-left hover:bg-black/[0.02] dark:hover:bg-white/[0.03] transition-colors"
              >
                <span
                  className={`w-3.5 h-3.5 shrink-0 rounded grid place-items-center border transition-colors ${
                    on ? 'bg-amber-500 border-amber-500 text-white' : 'border-light-lineStrong dark:border-dark-lineStrong'
                  }`}
                >
                  {on && <Icon name="check" size={9} />}
                </span>
                <span className="min-w-0 flex-1 text-[11.5px] text-light-ink dark:text-dark-ink">
                  第 {edit.index + 1} 处
                </span>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                  +{edit.adds}
                </span>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-red-500/10 text-red-600 dark:text-red-400">
                  −{edit.dels}
                </span>
              </button>
              {on && <HunkLines diff={{ ...diff, hunks: edit.hunks }} />}
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2 px-3 py-2 border-t border-light-line/70 dark:border-dark-line bg-black/[0.02] dark:bg-black/20">
        <span className="flex-1 text-[10.5px] text-light-inkFaint dark:text-dark-inkFaint flex items-center gap-1.5">
          <Icon name="shield" size={10} />
          只应用勾选的改动，写入前自动快照
        </span>
        <button className="btn-ghost" onClick={() => onDecide(null)}>
          全部拒绝
        </button>
        <button className="btn-solid" disabled={selected.length === 0} onClick={() => onDecide(selected)}>
          应用选中（{selected.length}）
        </button>
      </div>
    </div>
  );
}

function DiffCard({
  diff,
  onAction,
  onUndo,
}: {
  diff: DiffFile;
  onAction?: (state: 'accepted' | 'rejected') => void;
  onUndo?: () => void;
}) {
  const tone =
    diff.state === 'pending'
      ? 'border-amber-500/35 dark:border-amber-400/30'
      : diff.state === 'accepted'
        ? 'border-emerald-500/30 dark:border-emerald-400/25'
        : diff.state === 'rejected'
          ? 'border-red-500/30 dark:border-red-400/25'
          : 'border-light-line dark:border-dark-line';

  const badge =
    diff.state === 'pending'
      ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
      : diff.state === 'accepted'
        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
        : diff.state === 'rejected'
          ? 'bg-red-500/10 text-red-600 dark:text-red-400'
          : 'bg-black/5 dark:bg-white/10 text-light-inkMuted dark:text-dark-inkMuted';

  return (
    <div className={`rounded-xl overflow-hidden border ${tone} bg-white/55 dark:bg-white/[0.04] backdrop-blur-sm`}>
      <div className="flex items-center gap-2.5 px-3 py-2 border-b border-light-line/70 dark:border-dark-line">
        <Icon name="file" size={12} className="text-light-inkMuted dark:text-dark-inkMuted" />
        <span className="flex-1 min-w-0 text-[12px] font-medium font-mono truncate text-light-ink dark:text-dark-ink">
          {diff.file}
        </span>
        <span className="text-[10.5px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
          +{diff.adds}
        </span>
        <span className="text-[10.5px] font-mono px-1.5 py-0.5 rounded bg-red-500/10 text-red-600 dark:text-red-400">
          −{diff.dels}
        </span>
        <span className={`text-[10.5px] px-1.5 py-0.5 rounded ${badge}`}>{DIFF_STATE_LABEL[diff.state]}</span>
      </div>

      <HunkLines diff={diff} />

      {diff.state === 'pending' && onAction ? (
        <div className="flex items-center gap-2 px-3 py-2 border-t border-light-line/70 dark:border-dark-line bg-black/[0.02] dark:bg-black/20">
          <span className="flex-1 text-[10.5px] text-light-inkFaint dark:text-dark-inkFaint flex items-center gap-1.5">
            <Icon name="shield" size={10} />
            写入前自动快照，可随时回滚
          </span>
          <button className="btn-ghost" onClick={() => onAction('rejected')}>
            拒绝
          </button>
          <button className="btn-solid" onClick={() => onAction('accepted')}>
            接受并应用
          </button>
        </div>
      ) : null}

      {diff.state === 'accepted' && onUndo ? (
        <div className="flex items-center gap-2 px-3 py-2 border-t border-light-line/70 dark:border-dark-line bg-black/[0.02] dark:bg-black/20">
          <span className="flex-1 text-[10.5px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
            <Icon name="check" size={10} />
            已写入磁盘，快照已保存
          </span>
          <button className="btn-ghost" onClick={onUndo}>
            <Icon name="rotate" size={11} />
            回滚到此前
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ThinkingBlock({ text, done }: { text: string; done: boolean }) {
  return (
    <details className="group" open={done ? undefined : true}>
      <summary className="cursor-pointer select-none flex items-center gap-2 text-[11.5px] text-light-inkFaint dark:text-dark-inkFaint hover:text-light-ink dark:hover:text-dark-ink transition-colors">
        <Icon name="sparkle" size={10} />
        <span className="font-serif italic">{done ? '思考过程' : '正在思考…'}</span>
        <span className="text-[10px] opacity-70">{text.length} 字</span>
      </summary>
      <div className="mt-1.5 pl-3.5 border-l border-light-lineStrong dark:border-dark-lineStrong text-[12px] leading-relaxed text-light-inkMuted dark:text-dark-inkMuted italic whitespace-pre-wrap">
        {text}
      </div>
    </details>
  );
}

/* ───────────────────────── 消息列表（Hermes 排布） ───────────────────────── */

export interface MessageListProps {
  messages: Message[];
  onDiffAction: (messageId: string, state: 'accepted' | 'rejected') => void;
  onUndo: (messageId: string, snapshotId?: string) => void;
  onPatchDecide: (messageId: string, callId: string, accepted: number[] | null) => void;
  /** 当前模型，用于副标题 */
  model?: string;
  status?: TaskStatus;
  streaming?: boolean;
}

const STATUS_TEXT: Record<TaskStatus, string> = {
  idle: '待开始',
  running: '正在生成…',
  waiting: '等待确认',
  done: '已完成',
  failed: '失败',
  stopped: '已停止',
};

function renderPart(part: Part, index: number, message: Message, props: MessageListProps): JSX.Element | null {
  if (part.kind === 'thinking') {
    return <ThinkingBlock key={`think-${index}`} text={part.text} done={part.done} />;
  }
  if (part.kind === 'text') {
    return <Markdown key={`text-${index}`} text={part.text} />;
  }
  if (part.kind === 'tool') {
    return <ToolCard key={`tool-${part.run.id}`} run={part.run} />;
  }
  if (part.diff.state === 'pending' && part.diff.callId && part.diff.edits) {
    return (
      <ProposalCard
        key={`proposal-${part.diff.callId}`}
        diff={part.diff}
        onDecide={(accepted) => props.onPatchDecide(message.id, part.diff.callId!, accepted)}
      />
    );
  }
  return (
    <DiffCard
      key={`diff-${index}`}
      diff={part.diff}
      onAction={(state) => props.onDiffAction(message.id, state)}
      onUndo={part.diff.snapshotId ? () => props.onUndo(message.id, part.diff.snapshotId) : undefined}
    />
  );
}

function AgentAvatar() {
  return (
    <span
      className="w-8 h-8 shrink-0 rounded-[10px] grid place-items-center border shadow-sm overflow-hidden"
      style={{
        borderColor: 'color-mix(in srgb, var(--olivia-accent) 26%, transparent)',
        background:
          'linear-gradient(140deg, rgba(255,255,255,0.92), color-mix(in srgb, var(--olivia-accent) 16%, transparent))',
        color: 'var(--olivia-accent)',
      }}
    >
      <Mark size={18} />
    </span>
  );
}

export function MessageList(props: MessageListProps) {
  const { messages } = props;
  const first = messages[0];
  const last = messages[messages.length - 1];
  const busy = Boolean(props.streaming) || Boolean(last?.streaming);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 select-none">
        <span className="flex-1 h-px bg-light-line/70 dark:bg-dark-line/70" />
        <span className="text-[10.5px] tracking-[0.12em] text-light-inkFaint dark:text-dark-inkFaint">
          {dayLabel(first?.at)}
        </span>
        <span className="flex-1 h-px bg-light-line/70 dark:bg-dark-line/70" />
      </div>

      {messages.map((message) => {
        const plain = message.parts
          .filter((part) => part.kind === 'text')
          .map((part) => (part.kind === 'text' ? part.text : ''))
          .join('\n')
          .trim();

        if (message.role === 'user') {
          return (
            <motion.div
              key={message.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22 }}
              className="flex flex-col items-end gap-1"
            >
              <div className="max-w-[72%] rounded-2xl rounded-br-[6px] px-3.5 py-2 bg-black/[0.055] dark:bg-white/[0.09] border border-black/[0.04] dark:border-white/[0.06]">
                {message.parts.map((part, index) =>
                  part.kind === 'text' ? <Markdown key={index} text={part.text} /> : null,
                )}
              </div>
              <div className="flex items-center gap-2 pr-0.5 text-[10.5px] text-light-inkFaint dark:text-dark-inkFaint">
                <span className="tabular-nums">{hhmm(message.at)}</span>
                {plain && (
                  <button
                    onClick={() => copyText(plain)}
                    className="hover:text-light-ink dark:hover:text-dark-ink transition-colors"
                  >
                    复制
                  </button>
                )}
              </div>
            </motion.div>
          );
        }

        return (
          <motion.div
            key={message.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22 }}
            className="flex gap-3"
          >
            <AgentAvatar />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[13px] font-semibold text-light-ink dark:text-dark-ink">Olivia</span>
                <span className="flex items-center gap-1.5 text-[11px] text-light-inkFaint dark:text-dark-inkFaint">
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      busy ? 'bg-emerald-500 animate-pulse' : 'bg-light-inkFaint dark:bg-dark-inkFaint'
                    }`}
                  />
                  {STATUS_TEXT[props.status ?? 'idle']}
                  {props.model && (
                    <>
                      <span className="opacity-50">·</span>
                      <span className="font-mono">{modelLabel(props.model)}</span>
                    </>
                  )}
                </span>
              </div>
              <div className="mt-0.5 text-[10.5px] text-light-inkFaint dark:text-dark-inkFaint tabular-nums">
                {hhmm(message.at)}
              </div>

              <div className="mt-2.5 space-y-2.5">
                {message.parts.map((part, index) => renderPart(part, index, message, props))}
                {message.streaming && (
                  <span
                    className="inline-block w-[7px] h-[14px] align-[-2px] rounded-[2px] animate-caret"
                    style={{ background: 'var(--olivia-accent)' }}
                  />
                )}
              </div>

              {plain && !message.streaming && (
                <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-light-inkFaint dark:text-dark-inkFaint">
                  <button
                    onClick={() => copyText(plain)}
                    className="hover:text-light-ink dark:hover:text-dark-ink transition-colors"
                  >
                    复制
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}

/* ───────────────────────── 审批 / 撤销 ───────────────────────── */

export function ApprovalBar({
  request,
  onDecision,
}: {
  request: ApprovalRequest;
  onDecision: (decision: ApprovalDecision) => void;
}) {
  const riskLabel = request.risk === 'exec' ? '执行命令' : '写入文件';

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      className="mb-3 rounded-xl overflow-hidden border border-amber-500/35 dark:border-amber-400/30 bg-amber-500/[0.07] dark:bg-amber-400/[0.06] backdrop-blur-md"
    >
      <div className="flex items-start gap-3 p-3">
        <span className="w-7 h-7 shrink-0 rounded-lg grid place-items-center bg-amber-500/15">
          <Icon
            name={request.risk === 'exec' ? 'terminal' : 'file'}
            size={14}
            className="text-amber-600 dark:text-amber-400"
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 mb-1.5">
            <h4 className="font-serif text-[13px] font-semibold text-light-ink dark:text-dark-ink">
              模型请求{riskLabel}
            </h4>
            <span className="text-[9.5px] tracking-wider uppercase text-amber-700 dark:text-amber-400">
              {request.name}
            </span>
          </div>
          <code className="block text-[10.5px] font-mono p-2 rounded-lg bg-black/[0.04] dark:bg-black/30 overflow-x-auto text-light-ink dark:text-dark-ink mb-2 max-h-28 whitespace-pre-wrap break-all">
            {request.detail}
          </code>
          <div className="flex items-center gap-2">
            <button className="btn-ghost" onClick={() => onDecision('reject')}>
              拒绝
            </button>
            <button className="btn-outline" onClick={() => onDecision('always')} title="写入 .olivia/policy.json">
              始终允许
            </button>
            <button className="btn-solid" onClick={() => onDecision('once')}>
              允许一次
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

export function UndoToast({ result }: { result: UndoResult }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 10, scale: 0.98 }}
      className={`flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl border backdrop-blur-md text-[12px] ${
        result.ok
          ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          : 'border-red-500/35 bg-red-500/10 text-red-700 dark:text-red-300'
      }`}
    >
      <Icon name={result.ok ? 'rotate' : 'alert'} size={12} />
      <span>
        {result.ok
          ? `已撤销：${result.paths.join('、') || '文件已恢复'}${
              typeof result.remaining === 'number' ? ` · 还能回退 ${result.remaining} 步` : ''
            }`
          : result.message}
      </span>
    </motion.div>
  );
}
