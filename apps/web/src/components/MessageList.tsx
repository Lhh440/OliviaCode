import { useState } from 'react';
import type { ApprovalDecision, ApprovalRequest, DiffFile, Message, Part, ToolRun, UndoResult } from '@olivia/core';
import { Icon } from '../icons';
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

function ToolCard({ run }: { run: ToolRun }) {
  const lines = (run.output ?? '')
    .split('\n')
    .filter(Boolean)
    .slice(-8);
  return (
    <div className={`tool-card ${run.status}`}>
      <div className="tool-head">
        <span className="tool-glyph">
          <Icon name={TOOL_ICON[run.name] ?? 'terminal'} size={14} />
        </span>
        <span className="tool-name">{run.name}</span>
        <span className="tool-detail">{run.detail}</span>
        <span className="tool-state">
          {run.status === 'waiting' && <span className="state-text waiting">等待授权</span>}
          {run.status === 'running' && <span className="spinner" />}
          {run.status === 'ok' && <Icon name="check" size={14} />}
          {run.status === 'error' && <Icon name="x" size={14} />}
        </span>
      </div>
      {run.rows && run.rows.length > 0 && run.status !== 'running' && (
        <div className="tool-rows">
          {run.rows.map((row, index) => (
            <div className="tool-row" key={`${row}-${index}`}>
              {row}
            </div>
          ))}
        </div>
      )}
      {lines.length > 0 && <pre className="tool-output">{lines.join('\n')}</pre>}
    </div>
  );
}

const DIFF_STATE_LABEL: Record<DiffFile['state'], string> = {
  pending: '待确认',
  accepted: '已应用',
  rejected: '已拒绝',
  undone: '已撤销',
};

function HunkLines({ diff }: { diff: DiffFile }) {
  return (
    <div className="diff-body">
      {diff.hunks.map((hunk, index) => (
        <div className="diff-hunk" key={`${hunk.header}-${index}`}>
          <div className="hunk-head">{hunk.header}</div>
          {hunk.lines.map((line, lineIndex) => (
            <div className={`diff-line ${line.kind}`} key={lineIndex}>
              <span className="gutter">
                {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
              </span>
              <span className="code">{line.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** 逐处接受：apply_patch 的每条 edits 一个勾选项，应用后再落盘。 */
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
    <div className="diff-card pending proposal">
      <div className="diff-head">
        <Icon name="file" size={14} />
        <span className="diff-file">{diff.file}</span>
        <span className="diff-stat">
          <b className="add">+{diff.adds}</b>
          <b className="del">−{diff.dels}</b>
        </span>
        <span className="diff-state pending">{edits.length} 处待接受</span>
      </div>
      <div className="proposal-body">
        {edits.map((edit) => (
          <label className="proposal-edit" key={edit.index}>
            <div className="proposal-edit-head">
              <input
                type="checkbox"
                checked={selected.includes(edit.index)}
                onChange={() => toggle(edit.index)}
              />
              <span className="proposal-index">第 {edit.index + 1} 处</span>
              <span className="diff-stat">
                <b className="add">+{edit.adds}</b>
                <b className="del">−{edit.dels}</b>
              </span>
            </div>
            <HunkLines diff={{ ...diff, hunks: edit.hunks }} />
          </label>
        ))}
      </div>
      <div className="diff-foot">
        <span className="diff-note">
          <Icon name="shield" size={13} />
          只应用勾选的改动，写入前自动快照
        </span>
        <div className="diff-actions">
          <button className="btn ghost" onClick={() => onDecide(null)}>
            全部拒绝
          </button>
          <button
            className="btn primary"
            disabled={selected.length === 0}
            onClick={() => onDecide(selected)}
          >
            应用选中（{selected.length}）
          </button>
        </div>
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
  return (
    <div className={`diff-card ${diff.state}`}>
      <div className="diff-head">
        <Icon name="file" size={14} />
        <span className="diff-file">{diff.file}</span>
        <span className="diff-stat">
          <b className="add">+{diff.adds}</b>
          <b className="del">−{diff.dels}</b>
        </span>
        <span className={`diff-state ${diff.state}`}>{DIFF_STATE_LABEL[diff.state]}</span>
      </div>
      <HunkLines diff={diff} />
      {diff.state === 'pending' && onAction ? (
        <div className="diff-foot">
          <span className="diff-note">
            <Icon name="shield" size={13} />
            写入前自动快照，可随时回滚
          </span>
          <div className="diff-actions">
            <button className="btn ghost" onClick={() => onAction('rejected')}>
              拒绝
            </button>
            <button className="btn primary" onClick={() => onAction('accepted')}>
              接受并应用
            </button>
          </div>
        </div>
      ) : null}
      {diff.state === 'accepted' && onUndo ? (
        <div className="diff-foot">
          <span className="diff-note">
            <Icon name="check" size={13} />
            已写入磁盘，快照已保存
          </span>
          <div className="diff-actions">
            <button className="btn ghost" onClick={onUndo}>
              <Icon name="rotate" size={13} />
              回滚到这一步之前
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ThinkingBlock({ text, done }: { text: string; done: boolean }) {
  return (
    <details className="thinking" open={done ? undefined : true}>
      <summary>
        <Icon name="sparkle" size={12} />
        <span>{done ? '思考过程' : '正在思考…'}</span>
        <span className="thinking-meta">{text.length} 字</span>
      </summary>
      <div className="thinking-body">{text}</div>
    </details>
  );
}

export interface MessageListProps {
  messages: Message[];
  onDiffAction: (messageId: string, state: 'accepted' | 'rejected') => void;
  onUndo: (messageId: string, snapshotId?: string) => void;
  onPatchDecide: (messageId: string, callId: string, accepted: number[] | null) => void;
}

function renderPart(
  part: Part,
  index: number,
  message: Message,
  props: MessageListProps,
): JSX.Element | null {
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
      onUndo={
        part.diff.snapshotId
          ? () => props.onUndo(message.id, part.diff.snapshotId)
          : undefined
      }
    />
  );
}

export function MessageList(props: MessageListProps) {
  const { messages } = props;
  return (
    <div className="messages">
      {messages.map((message) =>
        message.role === 'user' ? (
          <div className="msg user" key={message.id}>
            <div className="bubble">
              {message.parts.map((part, index) =>
                part.kind === 'text' ? <Markdown key={index} text={part.text} /> : null,
              )}
            </div>
          </div>
        ) : (
          <div className="msg assistant" key={message.id}>
            <div className="avatar">
              <Icon name="sparkle" size={15} />
            </div>
            <div className="msg-body">
              {message.parts.map((part, index) => renderPart(part, index, message, props))}
              {message.streaming && <span className="caret" />}
            </div>
          </div>
        ),
      )}
    </div>
  );
}

export function ApprovalBar({
  request,
  onDecision,
}: {
  request: ApprovalRequest;
  onDecision: (decision: ApprovalDecision) => void;
}) {
  const riskLabel = request.risk === 'exec' ? '执行命令' : '写入文件';
  return (
    <div className="approval-bar">
      <span className="approval-icon">
        <Icon name={request.risk === 'exec' ? 'terminal' : 'file'} size={15} />
      </span>
      <div className="approval-text">
        <b>模型请求{riskLabel}</b>
        <code>{request.detail}</code>
      </div>
      <div className="approval-actions">
        <button className="btn ghost" onClick={() => onDecision('reject')}>
          拒绝
        </button>
        <button className="btn" onClick={() => onDecision('always')} title="写入 .olivia/policy.json">
          始终允许
        </button>
        <button className="btn primary" onClick={() => onDecision('once')}>
          允许一次
        </button>
      </div>
    </div>
  );
}

export function UndoToast({ result }: { result: UndoResult }) {
  return (
    <div className={`undo-toast ${result.ok ? '' : 'error'}`}>
      <Icon name={result.ok ? 'rotate' : 'alert'} size={13} />
      {result.ok
        ? `已撤销：${result.paths.join('、') || '文件已恢复'}${
            typeof result.remaining === 'number' ? ` · 还能回退 ${result.remaining} 步` : ''
          }`
        : result.message}
    </div>
  );
}
