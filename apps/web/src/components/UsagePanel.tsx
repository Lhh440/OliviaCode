import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  costOf,
  formatTokens,
  formatUsd,
  resolvePricing,
  usageTotalsOf,
  type ContextKey,
  type PricingFile,
  type TaskMemoryFile,
  type UsageRecord,
  type UsageStep,
  type UsageTotals,
} from '@olivia/core';
import { Icon } from '../icons';

const PART_META: Record<ContextKey, { label: string; color: string }> = {
  system: { label: '系统提示', color: 'bg-sky-400' },
  skills: { label: '技能目录', color: 'bg-cyan-400' },
  history: { label: '历史消息', color: 'bg-emerald-400' },
  memory: { label: '任务记忆', color: 'bg-teal-400' },
  turn: { label: '本轮对话', color: 'bg-amber-400' },
  toolResults: { label: '工具结果', color: 'bg-rose-400' },
  toolSchemas: { label: '工具定义', color: 'bg-violet-400' },
  images: { label: '图片', color: 'bg-fuchsia-400' },
};

export interface UsagePanelProps {
  steps: UsageStep[];
  model: string;
  providerId?: string;
  taskId: string;
  pricing: PricingFile;
  windowSize: number;
  onClose: () => void;
}

function aggregateLedger(records: UsageRecord[], pricing: PricingFile): UsageTotals {
  let totals: UsageTotals = { input: 0, output: 0, cached: 0, steps: 0 };
  const seen = new Set<string>();
  let cost: number | null = null;
  for (const record of records) {
    // 同一回合只算一次，避免账本与视图重复计费
    const key = `${record.taskId}|${record.turnId}|${record.step}`;
    if (seen.has(key)) continue;
    seen.add(key);
    totals = {
      input: totals.input + record.input,
      output: totals.output + record.output,
      cached: totals.cached + (record.cached ?? 0),
      steps: totals.steps + 1,
    };
    const price = costOf(record, resolvePricing(record.model, pricing.models));
    if (price !== null) cost = (cost ?? 0) + price;
  }
  if (cost !== null) totals.costUsd = Number(cost.toFixed(6));
  return totals;
}

export function UsagePanel({ steps, model, providerId, taskId, pricing, windowSize, onClose }: UsagePanelProps) {
  const [tab, setTab] = useState<'context' | 'usage' | 'memory'>('context');
  const [ledger, setLedger] = useState<UsageRecord[] | null>(null);
  const [memory, setMemory] = useState<TaskMemoryFile | null>(null);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [memoryNotice, setMemoryNotice] = useState<string | null>(null);

  const loadMemory = useCallback(async (): Promise<void> => {
    const bridge = window.olivia?.memory;
    if (!bridge) return;
    try {
      setMemory(await bridge.get(taskId));
    } catch {
      setMemory(null);
    }
  }, [taskId]);

  useEffect(() => {
    void loadMemory();
  }, [loadMemory]);

  useEffect(() => {
    const bridge = window.olivia?.memory;
    if (!bridge) return;
    return bridge.onEvent((payload) => {
      if (payload.taskId === taskId) setMemory(payload.file);
    });
  }, [taskId]);

  const compactNow = async (): Promise<void> => {
    const bridge = window.olivia?.memory;
    if (!bridge) return;
    setMemoryBusy(true);
    setMemoryNotice(null);
    try {
      const result = await bridge.compact({ taskId, providerId, model });
      if (!result.ok) {
        setMemoryNotice(result.error ?? '整理失败，继续用最近原文');
      } else {
        setMemory(result.file ?? null);
        setMemoryNotice('已生成检查点；下一次请求会带记忆 + 最近两轮原文');
      }
    } finally {
      setMemoryBusy(false);
    }
  };

  const revert = async (checkpointId?: string): Promise<void> => {
    const bridge = window.olivia?.memory;
    if (!bridge) return;
    setMemoryBusy(true);
    try {
      const result = await bridge.revert(taskId, checkpointId);
      if (result.file) setMemory(result.file);
      setMemoryNotice('已切换投影；原始对话不会被改写');
    } finally {
      setMemoryBusy(false);
    }
  };

  useEffect(() => {
    let alive = true;
    const bridge = window.olivia?.usage;
    if (!bridge) return;
    void bridge
      .list(7)
      .then((records) => {
        if (alive) setLedger(records);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const last = steps[steps.length - 1];
  const context = last?.context;
  const total = useMemo(
    () => usageTotalsOf(steps, (step) => costOf(step, resolvePricing(step.model ?? model, pricing.models))),
    [steps, model, pricing],
  );
  const recent = useMemo(() => (ledger ? aggregateLedger(ledger, pricing) : null), [ledger, pricing]);
  const percent = context && context.window > 0 ? Math.min(100, (context.used / context.window) * 100) : 0;
  const over80 = percent >= 80;
  const over95 = percent >= 95;

  return (
    <div className="usage-panel rounded-2xl border border-light-line dark:border-dark-line bg-light-panelStrong/95 dark:bg-dark-panelStrong/95 backdrop-blur-2xl shadow-[0_18px_50px_-24px_rgba(0,0,0,0.55)] overflow-hidden">
      <div className="flex items-center gap-2 px-4 pt-2.5 pb-1.5 border-b border-light-line/70 dark:border-dark-line/70">
        <div className="flex items-center gap-1 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] p-0.5">
          {(['context', 'usage', 'memory'] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`px-2.5 py-1 rounded-md text-[12.5px] transition-colors ${
                tab === key
                  ? 'bg-white/80 dark:bg-white/[0.12] text-light-ink dark:text-dark-ink shadow-sm'
                  : 'text-light-inkMuted dark:text-dark-inkMuted hover:text-light-ink dark:hover:text-dark-ink'
              }`}
            >
              {key === 'context' ? '上下文' : key === 'usage' ? '用量' : '记忆'}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        {context && (
          <span
            className={`text-[11.5px] px-1.5 py-0.5 rounded ${
              context.source === 'provider'
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
            }`}
            title={
              context.source === 'provider'
                ? '输入总量取自端点返回的 usage，构成按估算比例归一'
                : '端点没有返回 usage，以下为本地估算'
            }
          >
            {context.source === 'provider' ? '端点实测' : '估算'}
          </span>
        )}
        <button type="button" className="btn-ghost h-7" onClick={onClose} title="收起">
          <Icon name="x" size={12} />
        </button>
      </div>

      <div className="max-h-[42vh] overflow-y-auto px-4 py-3">
        {tab === 'context' ? (
          !context ? (
            <p className="py-4 text-center text-[13px] text-light-inkMuted dark:text-dark-inkMuted">
              还没有模型调用。发一条消息后，这里会显示每一步的上下文构成。
            </p>
          ) : (
            <div className="space-y-3">
              <div className="flex items-baseline gap-2">
                <span className="text-[22px] font-semibold tabular-nums text-light-ink dark:text-dark-ink">
                  {formatTokens(context.used)}
                </span>
                <span className="text-[12.5px] text-light-inkMuted dark:text-dark-inkMuted">
                  / {formatTokens(context.window)} · {percent.toFixed(percent < 10 ? 1 : 0)}%
                </span>
                <span className="flex-1" />
                <span className="text-[12px] text-light-inkFaint dark:text-dark-inkFaint tabular-nums">
                  第 {last?.step ?? 0} 步{last?.durationMs ? ` · ${(last.durationMs / 1000).toFixed(1)}s` : ''}
                </span>
              </div>

              <div className="h-2 rounded-full overflow-hidden flex bg-black/[0.06] dark:bg-white/[0.07]">
                {context.parts.map((part) => (
                  <span
                    key={part.key}
                    className={`${PART_META[part.key].color} h-full`}
                    style={{ width: `${context.used > 0 ? (part.tokens / context.used) * 100 : 0}%` }}
                    title={`${PART_META[part.key].label} ${formatTokens(part.tokens)}`}
                  />
                ))}
              </div>

              <div className="grid grid-cols-2 gap-x-5 gap-y-1.5">
                {context.parts.map((part) => (
                  <div key={part.key} className="flex items-center gap-2 text-[12.5px]">
                    <span className={`w-2 h-2 rounded-full ${PART_META[part.key].color}`} />
                    <span className="text-light-ink dark:text-dark-ink">{PART_META[part.key].label}</span>
                    <span className="ml-auto tabular-nums text-light-inkMuted dark:text-dark-inkMuted">
                      {formatTokens(part.tokens)}
                    </span>
                    <span className="w-10 text-right tabular-nums text-light-inkFaint dark:text-dark-inkFaint">
                      {context.used > 0 ? `${((part.tokens / context.used) * 100).toFixed(0)}%` : '0%'}
                    </span>
                  </div>
                ))}
              </div>

              <p className="text-[11.5px] leading-relaxed text-light-inkFaint dark:text-dark-inkFaint">
                这是模型实际收到的请求：没有记忆时带最近 12 条纯文本，有检查点时改为
                「记忆 + 最近两轮原文」；单个工具结果最多 12,000 字符，超过阈值会先缩短旧结果。
                思考过程只展示，不进请求。
              </p>
              {over80 && (
                <p
                  className={`text-[12px] rounded-lg px-2.5 py-1.5 ${
                    over95
                      ? 'bg-red-500/10 text-red-600 dark:text-red-300'
                      : 'bg-amber-500/10 text-amber-600 dark:text-amber-300'
                  }`}
                >
                  {over95
                    ? '上下文已超过 95%：下一次请求前会只保留最近两步工具结果；仍装不下会明确失败，请另开任务或先手动整理。'
                    : '上下文已超过 80%：到设置里的自动整理阈值（默认 85%）会把旧回合整理成任务记忆，也可以现在整理。'}
                </p>
              )}
            </div>
          )
        ) : tab === 'usage' ? (
          <div className="space-y-3">
            <div className="grid grid-cols-4 gap-2">
              {[
                { label: '输入', value: formatTokens(total.totals.input) },
                { label: '输出', value: formatTokens(total.totals.output) },
                { label: '缓存命中', value: formatTokens(total.totals.cached) },
                { label: '步数', value: String(steps.length) },
              ].map((item) => (
                <div
                  key={item.label}
                  className="rounded-lg border border-light-line/70 dark:border-dark-line/70 bg-black/[0.02] dark:bg-white/[0.03] px-2.5 py-2"
                >
                  <div className="text-[11px] text-light-inkFaint dark:text-dark-inkFaint">{item.label}</div>
                  <div className="text-[16px] font-semibold tabular-nums text-light-ink dark:text-dark-ink">
                    {item.value}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex items-center gap-2 text-[12.5px] text-light-inkMuted dark:text-dark-inkMuted">
              <Icon name="sparkle" size={11} />
              <span>
                本任务参考费用 <b className="text-light-ink dark:text-dark-ink">{formatUsd(total.totals.costUsd)}</b>
                {total.totals.costUsd === undefined
                  ? '（没有配置价格，只统计 token）'
                  : '（按当前价格表折算，非账单）'}
              </span>
            </div>
            {recent && recent.steps > 0 && (
              <div className="text-[12px] text-light-inkFaint dark:text-dark-inkFaint">
                近 7 天：输入 {formatTokens(recent.input)} · 输出 {formatTokens(recent.output)} ·{' '}
                {formatUsd(recent.costUsd)}
                {recent.costUsd === undefined
                  ? '（账本里没有可折算的价格）'
                  : '（只算配置过价格的模型，未配置的按 0 计）'}
              </div>
            )}

            {steps.length === 0 ? (
              <p className="py-3 text-center text-[13px] text-light-inkMuted dark:text-dark-inkMuted">
                还没有用量记录。
              </p>
            ) : (
              <div className="rounded-lg border border-light-line/70 dark:border-dark-line/70 overflow-hidden">
                <div className="grid grid-cols-[40px_1fr_62px_62px_62px_58px] gap-2 px-2.5 py-1.5 text-[11px] text-light-inkFaint dark:text-dark-inkFaint bg-black/[0.03] dark:bg-white/[0.03]">
                  <span>步骤</span>
                  <span>模型</span>
                  <span className="text-right">输入</span>
                  <span className="text-right">输出</span>
                  <span className="text-right">上下文</span>
                  <span className="text-right">费用</span>
                </div>
                {[...steps].reverse().slice(0, 20).map((step) => {
                  const stepPercent =
                    step.context.window > 0 ? (step.context.used / step.context.window) * 100 : 0;
                  return (
                    <div
                      key={`${step.step}-${step.at}`}
                      className="grid grid-cols-[40px_1fr_62px_62px_62px_58px] gap-2 px-2.5 py-1.5 text-[12px] border-t border-light-line/50 dark:border-dark-line/50 text-light-ink dark:text-dark-ink"
                    >
                      <span className="text-light-inkFaint dark:text-dark-inkFaint tabular-nums">{step.step}</span>
                      <span className="truncate text-light-inkMuted dark:text-dark-inkMuted">
                        {step.model ?? model}
                      </span>
                      <span className="text-right tabular-nums">{formatTokens(step.input)}</span>
                      <span className="text-right tabular-nums">{formatTokens(step.output)}</span>
                      <span className="text-right tabular-nums text-light-inkMuted dark:text-dark-inkMuted">
                        {stepPercent.toFixed(0)}%
                      </span>
                      <span className="text-right tabular-nums text-light-inkMuted dark:text-dark-inkMuted">
                        {formatUsd(costOf(step, resolvePricing(step.model ?? model, pricing.models)))}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="text-[11.5px] text-light-inkFaint dark:text-dark-inkFaint">
              输入/输出取端点报告的 usage；端点不报时按本地估算并标 ≈。价格可在「设置 → 用量与价格」覆盖。
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {!window.olivia?.memory ? (
              <p className="py-4 text-center text-[13px] text-light-inkMuted dark:text-dark-inkMuted">
                浏览器预览没有主进程，记忆只在桌面端可用。
              </p>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-light-ink dark:text-dark-ink">任务记忆</span>
                  {memory?.activeCheckpointId && (
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                      投影生效中
                    </span>
                  )}
                  <span className="flex-1" />
                  <button
                    type="button"
                    className="btn-ghost h-7"
                    onClick={() => void loadMemory()}
                    disabled={memoryBusy}
                  >
                    刷新
                  </button>
                  <button
                    type="button"
                    className="btn-outline h-7 px-2.5"
                    onClick={() => void compactNow()}
                    disabled={memoryBusy}
                  >
                    {memoryBusy ? '整理中…' : '现在整理'}
                  </button>
                </div>

                {memoryNotice && (
                  <p className="text-[12px] rounded-lg px-2.5 py-1.5 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
                    {memoryNotice}
                  </p>
                )}

                {!memory || !memory.memory.summary ? (
                  <p className="py-4 text-center text-[13px] text-light-inkMuted dark:text-dark-inkMuted">
                    还没有任务记忆。到 85% 会自动整理，也可以点「现在整理」。
                  </p>
                ) : (
                  <>
                    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] gap-3">
                    <div className="space-y-2 min-w-0">
                    <div className="rounded-lg border border-light-line/70 dark:border-dark-line/70 bg-black/[0.02] dark:bg-white/[0.03] px-3 py-2.5">
                      <div className="text-[11px] text-light-inkFaint dark:text-dark-inkFaint mb-1">摘要</div>
                      <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-light-ink dark:text-dark-ink">
                        {memory.memory.summary}
                      </p>
                    </div>

                    {[
                      { key: 'constraints', label: '用户约束', items: memory.memory.constraints },
                      { key: 'decisions', label: '已确认决定', items: memory.memory.decisions },
                      { key: 'questions', label: '待确认问题', items: memory.memory.questions },
                      {
                        key: 'todos',
                        label: '未完成事项',
                        items: memory.memory.todos.map((todo) => `${todo.status === 'done' ? '✓' : '·'} ${todo.text}`),
                      },
                      {
                        key: 'files',
                        label: '涉及文件',
                        items: memory.memory.files.map((file) => `${file.path}${file.note ? `（${file.note}）` : ''}`),
                      },
                    ]
                      .filter((section) => section.items.length > 0)
                      .map((section) => (
                        <div key={section.key}>
                          <div className="text-[11.5px] font-medium text-light-inkMuted dark:text-dark-inkMuted mb-1">
                            {section.label}
                          </div>
                          <ul className="space-y-0.5">
                            {section.items.map((item, index) => (
                              <li key={`${section.key}-${index}`} className="text-[12px] leading-relaxed text-light-ink dark:text-dark-ink">
                                · {item}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}

                    </div>
                    <div className="space-y-2 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-medium text-light-ink dark:text-dark-ink">检查点</span>
                      <span className="text-[11.5px] text-light-inkFaint dark:text-dark-inkFaint">
                        {memory.checkpoints.length} 个
                      </span>
                      <span className="flex-1" />
                      <button
                        type="button"
                        className="btn-ghost h-7"
                        disabled={memoryBusy || memory.checkpoints.length === 0}
                        onClick={() => void revert()}
                      >
                        回退到上一个
                      </button>
                    </div>
                    {memory.checkpoints.length === 0 ? (
                      <p className="text-[11.5px] text-light-inkFaint dark:text-dark-inkFaint">
                        还没有检查点；整理成功后这里会出现可回退的版本。
                      </p>
                    ) : (
                      <div className="space-y-1.5">
                        {[...memory.checkpoints].reverse().map((checkpoint) => {
                          const active = checkpoint.id === memory.activeCheckpointId;
                          return (
                            <div
                              key={checkpoint.id}
                              className={`rounded-lg border px-2.5 py-2 ${
                                active
                                  ? 'border-emerald-500/30 bg-emerald-500/[0.05]'
                                  : 'border-light-line/70 dark:border-dark-line/70 bg-black/[0.02] dark:bg-white/[0.02]'
                              }`}
                            >
                              <div className="flex items-center gap-2 text-[12px]">
                                <span className="font-medium text-light-ink dark:text-dark-ink">
                                  {checkpoint.reason === 'auto' ? '自动整理' : checkpoint.reason === 'manual' ? '手动整理' : '紧急整理'}
                                </span>
                                <span className="text-light-inkFaint dark:text-dark-inkFaint tabular-nums">
                                  {new Date(checkpoint.at).toLocaleString('zh-CN', {
                                    month: 'numeric',
                                    day: 'numeric',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })}
                                </span>
                                {active && (
                                  <span className="text-[10.5px] px-1 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                                    当前
                                  </span>
                                )}
                                <span className="flex-1" />
                                <button
                                  type="button"
                                  className="btn-ghost h-6 px-1.5"
                                  disabled={memoryBusy || active}
                                  onClick={() => void revert(checkpoint.id)}
                                >
                                  回退
                                </button>
                              </div>
                              <div className="mt-0.5 text-[11.5px] text-light-inkFaint dark:text-dark-inkFaint tabular-nums">
                                {formatTokens(checkpoint.beforeUsed)} → {formatTokens(checkpoint.afterUsed)} · 保留 {checkpoint.keptTurns} 轮 / 收纳 {checkpoint.droppedTurns} 轮
                                {checkpoint.usage
                                  ? ` · 整理费用 ${formatUsd(
                                      costOf(
                                        { input: checkpoint.usage.input, output: checkpoint.usage.output },
                                        resolvePricing(model, pricing.models),
                                      ),
                                    )}`
                                  : ''}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <p className="text-[11.5px] leading-relaxed text-light-inkFaint dark:text-dark-inkFaint">
                      压缩只改下一次请求的投影；会话日志、界面历史与 checkpoints 都不会被改写。
                    </p>
                    </div>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
