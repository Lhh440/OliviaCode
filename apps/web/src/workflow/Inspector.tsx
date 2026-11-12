import type { ReactNode } from 'react';
import { KINDS, MODELS, STATUS_LABEL, TOOL_NAMES, type WfNode } from '@olivia/core';
import { Icon } from '../icons';

interface Props {
  node: WfNode | null;
  onPatch: (patch: Partial<WfNode>) => void;
  onDelete: () => void;
  onInsert: () => void;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

export function Inspector({ node, onPatch, onDelete, onInsert }: Props) {
  if (!node) {
    return (
      <aside className="wf-inspector empty">
        <div className="inspector-empty">
          <Icon name="layers" size={20} />
          <p>选中一个节点查看与修改配置</p>
          <span>拖拽节点可移动，从节点右侧圆点拖出连线</span>
        </div>
      </aside>
    );
  }

  const meta = KINDS[node.kind];
  const tools = node.tools ?? [];
  const isAgentLike = node.kind === 'agent' || node.kind === 'reviewer';

  return (
    <aside className="wf-inspector">
      <header className="inspector-head">
        <span className="inspector-glyph" style={{ color: meta.accent, background: `${meta.accent}14` }}>
          <Icon name={meta.icon} size={16} />
        </span>
        <div className="inspector-head-text">
          <b>{node.title}</b>
          <span>
            {meta.label} · {STATUS_LABEL[node.status]}
          </span>
        </div>
      </header>

      <div className="inspector-body">
        <Field label="名称">
          <input
            className="input"
            value={node.title}
            onChange={(event) => onPatch({ title: event.target.value })}
          />
        </Field>

        {node.kind === 'trigger' && (
          <>
            <Field label="触发频率">
              <select
                className="input"
                value={node.schedule ?? '每晚 22:00'}
                onChange={(event) => onPatch({ schedule: event.target.value })}
              >
                {['每晚 22:00', '每天 09:00', '每 6 小时', '每周一 10:00'].map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </Field>
            <Field label="时区">
              <select className="input" defaultValue="Asia/Shanghai">
                <option>Asia/Shanghai</option>
                <option>UTC</option>
              </select>
            </Field>
          </>
        )}

        {isAgentLike && (
          <>
            <Field label="模型">
              <select
                className="input"
                value={node.model ?? MODELS[1]}
                onChange={(event) => onPatch({ model: event.target.value })}
              >
                {MODELS.map((model) => (
                  <option key={model}>{model}</option>
                ))}
              </select>
            </Field>

            {node.kind === 'reviewer' && (
              <Field label="评审上下文">
                <select
                  className="input"
                  value={node.context ?? 'clean'}
                  onChange={(event) => onPatch({ context: event.target.value as 'clean' | 'history' })}
                >
                  <option value="clean">干净上下文（只看 diff）</option>
                  <option value="history">带变更历史</option>
                </select>
              </Field>
            )}

            <Field label="提示词">
              <textarea
                className="input textarea"
                rows={6}
                value={node.prompt ?? ''}
                placeholder="写清边界、验收标准与禁止事项"
                onChange={(event) => onPatch({ prompt: event.target.value })}
              />
            </Field>

            <div className="field">
              <span className="field-label">工具</span>
              <div className="tool-chips">
                {TOOL_NAMES.map((tool) => {
                  const enabled = tools.includes(tool);
                  return (
                    <button
                      key={tool}
                      className={`tool-chip ${enabled ? 'on' : ''}`}
                      onClick={() =>
                        onPatch({
                          tools: enabled ? tools.filter((item) => item !== tool) : [...tools, tool],
                        })
                      }
                    >
                      {tool}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="field-row">
              <Field label="失败重试">
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={5}
                  value={node.retries ?? 2}
                  onChange={(event) => onPatch({ retries: Number(event.target.value) })}
                />
              </Field>
              <Field label="超时（分钟）">
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={120}
                  value={node.timeout ?? 10}
                  onChange={(event) => onPatch({ timeout: Number(event.target.value) })}
                />
              </Field>
            </div>
          </>
        )}

        {node.kind === 'gate' && (
          <>
            <Field label="审批人">
              <input className="input" defaultValue="我" />
            </Field>
            <Field label="超时（分钟）">
              <input
                className="input"
                type="number"
                min={1}
                value={node.timeout ?? 30}
                onChange={(event) => onPatch({ timeout: Number(event.target.value) })}
              />
            </Field>
            <Field label="阻断条件">
              <textarea
                className="input textarea"
                rows={4}
                defaultValue="评审有未解决的高危问题，或测试未全部通过时，不允许合并。"
              />
            </Field>
          </>
        )}

        {node.kind === 'output' && (
          <>
            <Field label="产出">
              <select className="input" defaultValue="PR + 日报">
                <option>PR + 日报</option>
                <option>仅 PR</option>
                <option>仅日报</option>
              </select>
            </Field>
            <Field label="目标分支">
              <input className="input" defaultValue="main" />
            </Field>
          </>
        )}

        {isAgentLike && (
          <div className="field">
            <span className="field-label">运行隔离</span>
            <div className="isolation">
              <button
                className={`isolation-option ${node.isolation !== 'sandbox' ? 'on' : ''}`}
                onClick={() => onPatch({ isolation: 'worktree' })}
              >
                <Icon name="check" size={13} />
                <span>独立 worktree · 执行后自动回收</span>
              </button>
              <button
                className={`isolation-option ${node.isolation === 'sandbox' ? 'on' : ''}`}
                onClick={() => onPatch({ isolation: 'sandbox' })}
              >
                <Icon name="shield" size={13} />
                <span>仅沙箱内运行 · 不可写磁盘</span>
              </button>
            </div>
          </div>
        )}

        <div className="field">
          <span className="field-label">最近一次</span>
          <div className="last-run">
            <Icon name="file" size={14} />
            <span>还没有执行记录</span>
          </div>
        </div>
      </div>

      <footer className="inspector-foot">
        <button className="btn" onClick={onInsert}>
          <Icon name="plus" size={14} />
          插入下游
        </button>
        <button className="btn danger" onClick={onDelete}>
          <Icon name="trash" size={14} />
          删除
        </button>
      </footer>
    </aside>
  );
}
