/**
 * M7 · 用量与上下文计量（双端共用，纯函数）。
 *
 * 原则：
 * - 端点给的真实 usage 永远优先；没有时才估算，并且来源要一路带到界面。
 * - 真实 prompt_tokens 只做「总量真值」，六类构成按估算比例归一，
 *   这样总量与端点一致，构成仍能指出是谁变大了。
 * - 价格是参考价，不等于账单；计算保持纯函数，主进程与渲染层用同一套。
 */

export type UsageSource = 'provider' | 'estimate';

export type ContextKey =
  | 'system'
  | 'skills'
  | 'history'
  | 'memory'
  | 'turn'
  | 'toolResults'
  | 'toolSchemas'
  | 'images';

export interface TokenUsage {
  /** 输入 token（含缓存命中） */
  input: number;
  output: number;
  /** 命中缓存的输入 token；端点不返回则为 undefined */
  cached?: number;
  source: UsageSource;
  /** 中断/失败但已经收到部分输出 */
  partial?: boolean;
}

export interface ContextPart {
  key: ContextKey;
  tokens: number;
  chars: number;
  /** 这一块里有多少个条目（消息数 / 工具数），仅用于说明 */
  items: number;
}

export interface ContextSnapshot {
  window: number;
  used: number;
  parts: ContextPart[];
  source: UsageSource;
}

export interface UsageStep extends TokenUsage {
  step: number;
  at: number;
  durationMs?: number;
  /** 实际调用使用的模型；工作流里各节点可以不同 */
  model?: string;
  /** M8：这次调用是正常回合还是上下文整理 */
  purpose?: 'turn' | 'compaction';
  context: ContextSnapshot;
}

/** 账本里的一行：不含对话内容，便于聚合与导出。 */
export interface UsageRecord {
  at: number;
  taskId: string;
  turnId: string;
  model: string;
  step: number;
  input: number;
  output: number;
  cached?: number;
  source: UsageSource;
  /** M8：正常回合或上下文整理 */
  purpose?: 'turn' | 'compaction';
}

export interface UsageTotals {
  input: number;
  output: number;
  cached: number;
  steps: number;
  /** 只在有价格时给出；工作流/计划用 */
  costUsd?: number;
}

export interface ModelPricing {
  /** 每百万 token 的美元参考价 */
  inPerM: number;
  outPerM: number;
  /** 缓存命中价；不填则缓存 token 仍按输入价计 */
  cachedInPerM?: number;
  currency: 'USD';
  updatedAt: string;
  source: 'builtin' | 'user';
}

/** 设置页允许覆盖的模型配置；没填的字段回退模型目录。 */
export interface ModelOverride {
  contextWindow?: number;
  pricing?: ModelPricing;
}

export interface PricingFile {
  defaultContextWindow: number;
  models: Record<string, ModelOverride>;
}

export const DEFAULT_CONTEXT_WINDOW = 128_000;

/** 内置参考价（示例端点，可按设置覆盖）。 */
export const BUILTIN_PRICING: Record<string, ModelPricing> = {
  'deepseek-v4.1-flash': {
    inPerM: 0.28,
    outPerM: 0.42,
    cachedInPerM: 0.028,
    currency: 'USD',
    updatedAt: '2026-11-01',
    source: 'builtin',
  },
  'qwen3-14b': {
    inPerM: 0.2,
    outPerM: 0.6,
    cachedInPerM: 0.02,
    currency: 'USD',
    updatedAt: '2026-11-01',
    source: 'builtin',
  },
};

const CJK =
  /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f\u3040-\u30ff\uac00-\ud7af]/g;

/**
 * 粗估 token：CJK 按 1 字符 1 token，其余按 4 字符 1 token。
 * 只用于端点不报 usage 时的兜底与「真实总量」的内部构成比例，
 * 不作为账单依据；有真实值时总量一定用真实值。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK)?.length ?? 0;
  const rest = text.length - cjk;
  return Math.max(1, Math.ceil(cjk + rest / 4));
}

export interface ContextInput {
  key: ContextKey;
  text: string;
  items: number;
  /** M8：非文本部分（图片）直接给 token 数，有就加在估算上 */
  tokens?: number;
}

/**
 * 把各类上下文字符数折成 tokens。
 * providerInput 存在时按估算比例归一，保证各类之和恰好等于端点报的 prompt_tokens。
 * M8：`tokens` 是图片这类无法按字符估算的部分，归一前先并入估算。
 */
export function measureContext(input: {
  window: number;
  parts: ContextInput[];
  providerInput?: number;
}): ContextSnapshot {
  const raw = input.parts.map((part) => ({
    key: part.key,
    chars: part.text.length,
    items: part.items,
    tokens: Math.max(estimateTokens(part.text), part.tokens ?? 0),
  }));
  const estimated = raw.reduce((sum, part) => sum + part.tokens, 0);
  const provider =
    typeof input.providerInput === 'number' && Number.isFinite(input.providerInput) && input.providerInput >= 0
      ? Math.round(input.providerInput)
      : undefined;

  if (provider !== undefined && provider > 0 && estimated > 0) {
    const scaled = raw.map((part) => ({
      ...part,
      tokens: Math.max(0, Math.round((part.tokens / estimated) * provider)),
    }));
    // 取整误差补到最大的那一块，保证总和精确
    const sum = scaled.reduce((acc, part) => acc + part.tokens, 0);
    const diff = provider - sum;
    if (diff !== 0 && scaled.length > 0) {
      let target = 0;
      for (let index = 1; index < scaled.length; index += 1) {
        if (scaled[index]!.tokens > scaled[target]!.tokens) target = index;
      }
      scaled[target] = { ...scaled[target]!, tokens: Math.max(0, scaled[target]!.tokens + diff) };
    }
    return { window: input.window, used: provider, parts: scaled, source: 'provider' };
  }

  const total = raw.reduce((sum, part) => sum + part.tokens, 0);
  return { window: input.window, used: total, parts: raw, source: 'estimate' };
}

/** 每百万 token 计价；缓存命中按缓存价，没配就仍按输入价。 */
export function costOf(
  usage: { input: number; output: number; cached?: number },
  pricing: ModelPricing | undefined | null,
): number | null {
  if (!pricing) return null;
  const cached = Math.max(0, Math.min(usage.cached ?? 0, usage.input));
  const billable = Math.max(0, usage.input - cached);
  const cachedPrice = pricing.cachedInPerM ?? pricing.inPerM;
  const usd =
    (billable * pricing.inPerM + cached * cachedPrice + Math.max(0, usage.output) * pricing.outPerM) /
    1_000_000;
  return Number(usd.toFixed(6));
}

export function addUsageTotals(
  current: UsageTotals,
  usage: TokenUsage,
  costUsd?: number | null,
): UsageTotals {
  const next: UsageTotals = {
    input: current.input + Math.max(0, usage.input),
    output: current.output + Math.max(0, usage.output),
    cached: current.cached + Math.max(0, usage.cached ?? 0),
    steps: current.steps + 1,
  };
  const totalCost = (current.costUsd ?? 0) + (costUsd ?? 0);
  if (current.costUsd !== undefined || typeof costUsd === 'number') next.costUsd = Number(totalCost.toFixed(6));
  return next;
}

export function emptyUsageTotals(): UsageTotals {
  return { input: 0, output: 0, cached: 0, steps: 0 };
}

/** 一轮/一组的汇总；estm 仅当所有 step 都是估算时为 true。 */
export function usageTotalsOf(steps: UsageStep[], costOfStep?: (step: UsageStep) => number | null): {
  totals: UsageTotals;
  estimated: boolean;
} {
  let totals = emptyUsageTotals();
  let estimated = false;
  for (const step of steps) {
    const cost = costOfStep ? costOfStep(step) : null;
    totals = addUsageTotals(totals, step, cost);
    if (step.source === 'estimate') estimated = true;
  }
  return { totals, estimated };
}

/** 渲染层与主进程共用的价格查找：用户覆盖 → 内置 → 空。 */
export function resolvePricing(
  model: string,
  overrides?: Record<string, ModelOverride> | null,
): ModelPricing | null {
  const user = overrides?.[model]?.pricing;
  if (user) return user;
  return BUILTIN_PRICING[model] ?? null;
}

export function resolveContextWindow(
  model: string,
  fallback: number,
  overrides?: Record<string, ModelOverride> | null,
): number {
  const fromOverride = overrides?.[model]?.contextWindow;
  if (typeof fromOverride === 'number' && fromOverride > 0) return fromOverride;
  return fallback;
}

export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0';
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatUsd(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value > 0 && value < 0.0001) return '<$0.0001';
  return `$${value.toFixed(value >= 1 ? 2 : 4)}`;
}
