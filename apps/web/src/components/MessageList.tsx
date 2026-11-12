import type { DiffFile, Message, Part, ToolRun } from '@olivia/core';
import { Icon } from '../icons';

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
  test: 'check',
  git: 'git',
  git_diff: 'git',
  list_dir: 'folder',
};

function ToolCard({ run }: { run: ToolRun }) {
  return (
    <div className={`tool-card ${run.status}`}>
      <div className="tool-head">
        <span className="tool-glyph">
          <Icon name={TOOL_ICON[run.name] ?? 'terminal'} size={14} />
        </span>
        <span className="tool-name">{run.name}</span>
        <span className="tool-detail">{run.detail}</span>
        <span className="tool-state">
          {run.status === 'running' && <span className="spinner" />}
          {run.status === 'ok' && <Icon name="check" size={14} />}
          {run.status === 'error' && <Icon name="x" size={14} />}
        </span>
      </div>
      {run.rows && run.rows.length > 0 && (
        <div className="tool-rows">
          {run.rows.map((row) => (
            <div className="tool-row" key={row}>
              {row}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const DIFF_STATE_LABEL: Record<DiffFile['state'], string> = {
  pending: '待确认',
  accepted: '已应用',
  rejected: '已拒绝',
};

function DiffCard({
  diff,
  onAction,
}: {
  diff: DiffFile;
  onAction: (state: 'accepted' | 'rejected') => void;
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
      <div className="diff-body">
        {diff.hunks.map((hunk, index) => (
          <div className="diff-hunk" key={`${hunk.header}-${index}`}>
            <div className="hunk-head">{hunk.header}</div>
            {hunk.lines.map((line, lineIndex) => (
              <div className={`diff-line ${line.kind}`} key={lineIndex}>
                <span className="gutter">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}</span>
                <span className="code">{line.text}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      {diff.state === 'pending' ? (
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
    </div>
  );
}

interface Props {
  messages: Message[];
  onDiffAction: (messageId: string, state: 'accepted' | 'rejected') => void;
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

function renderPart(
  part: Part,
  index: number,
  message: Message,
  onDiffAction: Props['onDiffAction'],
) {
  if (part.kind === 'thinking') {
    return <ThinkingBlock key={`think-${index}`} text={part.text} done={part.done} />;
  }
  if (part.kind === 'text') {
    return (
      <p className="prose" key={`text-${index}`}>
        {part.text}
      </p>
    );
  }
  if (part.kind === 'tool') {
    return <ToolCard key={`tool-${part.run.id}`} run={part.run} />;
  }
  return (
    <DiffCard
      key={`diff-${index}`}
      diff={part.diff}
      onAction={(state) => onDiffAction(message.id, state)}
    />
  );
}

export function MessageList({ messages, onDiffAction }: Props) {
  return (
    <div className="messages">
      {messages.map((message) =>
        message.role === 'user' ? (
          <div className="msg user" key={message.id}>
            <div className="bubble">
              {message.parts.map((part, index) =>
                part.kind === 'text' ? <p key={index}>{part.text}</p> : null,
              )}
            </div>
          </div>
        ) : (
          <div className="msg assistant" key={message.id}>
            <div className="avatar">
              <Icon name="sparkle" size={15} />
            </div>
            <div className="msg-body">
              {message.parts.map((part, index) => renderPart(part, index, message, onDiffAction))}
              {message.streaming && <span className="caret" />}
            </div>
          </div>
        ),
      )}
    </div>
  );
}
