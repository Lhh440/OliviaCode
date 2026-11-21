import type { ReactNode } from 'react';
import {
  KINDS,
  MODELS,
  STATUS_LABEL,
  TOOL_NAMES,
  describeCron,
  tryParseCron,
  type WfNode,
} from '@olivia/core';
import { Icon } from '../icons';

/** 常见频率的预置：这里给的是能直接过校验器的标准 5 段 cron。 */
const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: '每晚 22:00', cron: '0 22 * * *' },
  { label: '每天 09:00', cron: '0 9 * * *' },
  { label: '每 6 小时', cron: '0 */6 * * *' },
  { label: '每周一 10:00', cron: '0 10 * * 1' },
];

interface Props {
  node: WfNode | null;
  onPatch: (patch: Partial<WfNode>) => void;
  onDelete: () => void;
  onInsert: () => void;
  /** M6：已连接的 MCP 服务器 id，节点可以按 `mcp:<id>` 整台放行 */
  mcpServers?: string[];
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

export function Inspector({ node, onPatch, onDelete, onInsert, mcpServers = [] }: Props) {
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
            <Field label="触发频率（cron · 分 时 日 月 周）">
              <input
                className="input font-mono"
                value={node.schedule ?? ''}
                placeholder="0 22 * * *"
                spellCheck={false}
                onChange={(event) => onPatch({ schedule: event.target.value })}
              />
            </Field>
            {(() => {
              const source = (node.schedule ?? '').trim();
              if (!source) return <p className="field-hint">填了 cron 才会出现在「计划」页。</p>;
              const parsed = tryParseCron(source);
              return parsed.ok ? (
                <p className="field-hint">
                  {describeCron(source)} · 这条会出现在「计划」页，新计划默认暂停。
                </p>
              ) : (
                <p className="field-hint text-red-600 dark:text-red-400">
                  cron 不合法：{parsed.error}
                </p>
              );
            })()}
            <div className="flex flex-wrap gap-1">
              {CRON_PRESETS.map((preset) => (
                <button
                  key={preset.cron}
                  type="button"
                  onClick={() => onPatch({ schedule: preset.cron, title: preset.label })}
                  className="text-[11.5px] px-1.5 py-0.5 rounded border border-light-line dark:border-dark-line text-light-inkMuted dark:text-dark-inkMuted hover:text-light-ink dark:hover:text-dark-ink transition-colors"
                  title={preset.cron}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <Field label="时区">
              <select
                className="input"
                value={node.timezone ?? 'Asia/Shanghai'}
                onChange={(event) => onPatch({ timezone: event.target.value })}
              >
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
                value={node.model ?? MODELS[0]!.id}
                onChange={(event) => onPatch({ model: event.target.value })}
              >
                {MODELS.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
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
                {mcpServers.map((serverId) => {
                  const key = `mcp:${serverId}`;
                  const enabled = tools.includes(key);
                  return (
                    <button
                      key={key}
                      className={`tool-chip ${enabled ? 'on' : ''}`}
                      title="放行这整台 MCP 服务器（工具本身还要在「扩展」页勾选）"
                      onClick={() =>
                        onPatch({
                          tools: enabled ? tools.filter((item) => item !== key) : [...tools, key],
                        })
                      }
                    >
                      {key}
                    </button>
                  );
                })}
              </div>
              {mcpServers.length === 0 && (
                <p className="field-hint">在「扩展」页连上 MCP 服务器后，这里会出现 mcp:&lt;服务器&gt; 芯片。</p>
              )}
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
            <Field label="审批超时（分钟）">
              <input
                className="input"
                type="number"
                min={1}
                max={120}
                value={node.gateTimeout ?? 30}
                onChange={(event) => onPatch({ gateTimeout: Number(event.target.value) })}
              />
            </Field>
            <Field label="阻断条件">
              <textarea
                className="input textarea"
                rows={4}
                value={
                  node.blockReason ??
                  '评审有未解决的高危问题，或测试未全部通过时，不允许合并。'
                }
                onChange={(event) => onPatch({ blockReason: event.target.value })}
              />
            </Field>
            <p className="field-hint">超时按「未通过」处理，运行会失败并把集成分支现状留给你。</p>
          </>
        )}

        {node.kind === 'output' && (
          <>
            <Field label="产出">
              <select
                className="input"
                value={node.outputKind ?? 'both'}
                onChange={(event) =>
                  onPatch({ outputKind: event.target.value as 'pr' | 'report' | 'both' })
                }
              >
                <option value="both">PR + 日报</option>
                <option value="pr">仅 PR</option>
                <option value="report">仅日报</option>
              </select>
            </Field>
            <Field label="目标分支">
              <input
                className="input"
                value={node.targetBranch ?? 'main'}
                onChange={(event) => onPatch({ targetBranch: event.target.value })}
              />
            </Field>
            <p className="field-hint">
              产出节点目前只统计结果分支（文件数 / 提交数）；推送与开 PR 仍走 Git 页或对话里的工具。
            </p>
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
