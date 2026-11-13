/**
 * M5 · 排期内核（双端共用，纯函数，无 IO）。
 *
 * 只支持标准 5 段 cron（分 时 日 月 周），保留通配符、步进（＊／n）、区间、逗号列表
 * 与月份/星期英文缩写。时区用 IANA 名称，通过 Intl 换算，不引入日期库。
 *
 * 调度语义由两条约定保证：
 * - nextOccurrence 严格返回 after 之后的下一次，不会原地返回，所以「每秒 tick」也不会重复触发；
 * - 大月/小月、闰年、夏令时都由 Intl 的本地时间换算兜底，不做手工日历运算。
 */
import type { Workflow } from './workflow';

// —— 无人值守策略 ——

export type GateMode = 'pause-and-notify' | 'auto-approve' | 'auto-reject';
export type UnattendedMode = 'report' | 'report-pr';

export interface UnattendedPolicy {
  /** 无人应答时审批门怎么处理 */
  gate: GateMode;
  /** 审批门最多等多久（分钟），超时按未通过 */
  gateTimeout: number;
  /** 单次运行墙钟上限（分钟） */
  maxWallMinutes: number;
  /** 单次运行最多节点数 */
  maxNodes: number;
  /** 单次运行模型步数上限 */
  maxSteps: number;
}

export const DEFAULT_UNATTENDED_POLICY: UnattendedPolicy = {
  gate: 'pause-and-notify',
  gateTimeout: 30,
  maxWallMinutes: 30,
  maxNodes: 24,
  maxSteps: 80,
};

export type RunStatus = 'running' | 'done' | 'failed' | 'canceled' | 'skipped' | 'interrupted';

export interface NodeRunSummary {
  title: string;
  phase: string;
  summary?: string;
  error?: string;
}

export interface ScheduleRecord {
  /** 形如 workflowId:triggerNodeId */
  id: string;
  workflowId: string;
  triggerNodeId: string;
  workflowName: string;
  workspace: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  mode: UnattendedMode;
  policy: UnattendedPolicy;
  /** 运行所需的画布快照：渲染层不在场时也要能跑 */
  workflow: Workflow;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastStatus?: RunStatus;
  nextRunAt?: number;
}

export interface RunRecord {
  id: string;
  scheduleId: string;
  workflowName: string;
  workspace: string;
  startedAt: number;
  endedAt?: number;
  status: RunStatus;
  branch?: string;
  reportPath?: string;
  prUrl?: string;
  error?: string;
  /** 错过的运行次数（本 tick 只补最近一次） */
  missed?: number;
  nodes: Record<string, NodeRunSummary>;
}

export interface SchedulerEvent {
  type: 'schedule.changed' | 'run.start' | 'run.end';
  schedule?: ScheduleRecord;
  run?: RunRecord;
}

export const GATE_MODE_LABEL: Record<GateMode, string> = {
  'pause-and-notify': '暂停并通知',
  'auto-approve': '自动批准',
  'auto-reject': '自动拒绝',
};

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  running: '运行中',
  done: '成功',
  failed: '失败',
  canceled: '已取消',
  skipped: '跳过',
  interrupted: '中断',
};

// —— cron 解析 ——

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
  /** 该段是否写成通配符或步进：决定「日」与「周」是 AND 还是 OR */
  dayAny: boolean;
  weekdayAny: boolean;
}

export interface CronExpression extends CronFields {
  source: string;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const WEEKDAYS: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronError';
  }
}

interface RangeSpec {
  min: number;
  max: number;
  names?: Record<string, number>;
}

function parseField(
  raw: string,
  spec: RangeSpec,
  label: string,
): { values: Set<number>; any: boolean } {
  const text = raw.trim().toLowerCase();
  if (!text) throw new CronError(`${label}不能为空`);

  let any = text === '*';
  let body = text;
  // */n 是「从最小值起每 n 个」，语义上仍算「不限定取值」，所以 dayAny/weekdayAny 为 true
  if (text.startsWith('*/')) {
    any = true;
    body = `*${text.slice(1)}`;
  }

  const values = new Set<number>();
  for (const part of body.split(',')) {
    if (!part) throw new CronError(`${label}有空的片段`);

    const [rangePart, stepPart] = part.split('/');
    if (stepPart !== undefined) {
      const step = Number(stepPart);
      if (!Number.isInteger(step) || step <= 0) throw new CronError(`${label}的步长必须是正整数：${part}`);
      if (stepPart.includes('.') || !/^\d+$/.test(stepPart)) throw new CronError(`${label}的步长必须是整数：${part}`);
    }
    const step = stepPart === undefined ? 1 : Number(stepPart);

    let from: number;
    let to: number;
    if (rangePart === '*') {
      from = spec.min;
      to = spec.max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      from = resolveValue(a ?? '', spec, label);
      to = resolveValue(b ?? '', spec, label);
      if (from > to) throw new CronError(`${label}的区间起点大于终点：${part}`);
    } else {
      from = resolveValue(rangePart, spec, label);
      to = stepPart === undefined ? from : spec.max;
    }

    if (from < spec.min || to > spec.max) {
      throw new CronError(`${label}超出范围 ${spec.min}-${spec.max}：${part}`);
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }

  return { values, any };
}

function resolveValue(raw: string, spec: RangeSpec, label: string): number {
  const text = raw.trim();
  if (!text) throw new CronError(`${label}缺少数值`);
  if (spec.names && spec.names[text] !== undefined) return spec.names[text]!;
  if (!/^\d+$/.test(text)) throw new CronError(`${label}不是合法数字：${raw}`);
  return Number(text);
}

/** 解析标准 5 段 cron；不合法直接抛 CronError。 */
export function parseCron(source: string): CronExpression {
  const fields = source.trim().split(/\s+/);
  if (fields.length !== 5) throw new CronError(`cron 需要 5 段（分 时 日 月 周），现在是 ${fields.length} 段`);
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];

  const minutes = parseField(minute, { min: 0, max: 59 }, '分钟');
  const hours = parseField(hour, { min: 0, max: 23 }, '小时');
  const days = parseField(day, { min: 1, max: 31 }, '日');
  const months = parseField(month, { min: 1, max: 12, names: MONTHS }, '月');
  const weekdays = parseField(weekday, { min: 0, max: 6, names: WEEKDAYS }, '周');

  return {
    source: source.trim(),
    minute: minutes.values,
    hour: hours.values,
    day: days.values,
    month: months.values,
    weekday: weekdays.values,
    dayAny: days.any,
    weekdayAny: weekdays.any,
  };
}

export function tryParseCron(source: string): { ok: true; cron: CronExpression } | { ok: false; error: string } {
  try {
    return { ok: true, cron: parseCron(source) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// —— 时区换算 ——

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  formatterCache.set(timezone, formatter);
  return formatter;
}

function zonedParts(at: number, timezone: string): ZonedParts {
  const parts = formatterFor(timezone).formatToParts(new Date(at));
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return {
    year: Number(pick('year')),
    month: Number(pick('month')),
    day: Number(pick('day')),
    hour: Number(pick('hour')) % 24,
    minute: Number(pick('minute')),
    weekday: WEEKDAY_INDEX[pick('weekday')] ?? 0,
  };
}

/** 校验 IANA 时区名；不合法回退 UTC。 */
export function safeTimezone(timezone: string | undefined): string {
  const name = (timezone ?? '').trim();
  if (!name) return 'UTC';
  try {
    formatterFor(name);
    return name;
  } catch {
    return 'UTC';
  }
}

function dateMatches(cron: CronExpression, parts: ZonedParts): boolean {
  if (!cron.month.has(parts.month)) return false;
  const dayHit = cron.day.has(parts.day);
  const weekdayHit = cron.weekday.has(parts.weekday);
  // 标准 cron：两者都受限时取「或」，否则取「与」
  if (!cron.dayAny && !cron.weekdayAny) return dayHit || weekdayHit;
  return dayHit && weekdayHit;
}

/**
 * 返回 after（毫秒）之后的下一次触发时间；400 天内没有则返回 null。
 *
 * 做法：先跳过不匹配的日期（一次跳一天，而不是逐分钟扫），
 * 命中的日期里只枚举配置过的小时/分钟偏置，所以最坏情况也只有几百次时区换算。
 */
export function nextOccurrence(cron: CronExpression, after: number, timezone: string): number | null {
  const tz = safeTimezone(timezone);
  const hours = [...cron.hour].sort((a, b) => a - b);
  const minutes = [...cron.minute].sort((a, b) => a - b);
  if (hours.length === 0 || minutes.length === 0) return null;

  let cursor = Math.floor(after / 60_000) * 60_000 + 60_000;
  for (let day = 0; day < 400; day += 1) {
    const parts = zonedParts(cursor, tz);
    if (!dateMatches(cron, parts)) {
      // 跳到这个时区日期的下一天 00:00（用当前分钟偏置换算出本地午夜的真实毫秒）
      const localMidnight = cursor - (parts.hour * 60 + parts.minute) * 60_000;
      cursor = localMidnight + 24 * 60 * 60_000;
      continue;
    }
    for (const hour of hours) {
      for (const minute of minutes) {
        const candidate = cursor + ((hour - parts.hour) * 60 + (minute - parts.minute)) * 60_000;
        if (candidate < cursor) continue;
        const at = zonedParts(candidate, tz);
        // 用真实日历回读一次，排除 DST 跳变造成的「名义时间已到、实际日期不同」
        if (at.year === parts.year && at.month === parts.month && at.day === parts.day
          && at.hour === hour && at.minute === minute) {
          return candidate;
        }
      }
    }
    const localMidnight = cursor - (parts.hour * 60 + parts.minute) * 60_000;
    cursor = localMidnight + 24 * 60 * 60_000;
  }
  return null;
}

/** 接下来 n 次触发时间，用于界面预览。 */
export function nextOccurrences(cron: CronExpression, after: number, timezone: string, count = 5): number[] {
  const out: number[] = [];
  let cursor = after;
  for (let index = 0; index < count; index += 1) {
    const next = nextOccurrence(cron, cursor, timezone);
    if (next === null) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/** 人话描述：常见的几种给中文，其余回退成 cron 原文。 */
export function describeCron(source: string): string {
  const parsed = tryParseCron(source);
  if (!parsed.ok) return `无效：${source}`;
  const { cron } = parsed;
  const minutes = [...cron.minute].sort((a, b) => a - b);
  const hours = [...cron.hour].sort((a, b) => a - b);
  const pad = (value: number): string => String(value).padStart(2, '0');

  if (cron.dayAny && cron.weekdayAny && cron.month.size === 12 && hours.length === 1 && minutes.length === 1) {
    const hour = hours[0]!;
    const minute = minutes[0]!;
    if (hour === 0 && minute === 0) return '每天 00:00';
    return `每天 ${pad(hour)}:${pad(minute)}`;
  }
  if (cron.dayAny && cron.month.size === 12 && cron.weekday.size === 7 && !cron.weekdayAny) {
    const hour = hours.length === 1 ? pad(hours[0]!) : `${hours.length} 个整点`;
    const minute = minutes.length === 1 ? pad(minutes[0]!) : '多点';
    return `每天 ${hour}:${minute}`;
  }
  if (!cron.dayAny && cron.day.size === 1) {
    const hour = hours.length === 1 ? pad(hours[0]!) : '?';
    const minute = minutes.length === 1 ? pad(minutes[0]!) : '?';
    return `每月 ${[...cron.day][0]!} 日 ${hour}:${minute}`;
  }
  if (!cron.weekdayAny && cron.weekday.size > 0 && cron.weekday.size <= 7) {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const days = [...cron.weekday].sort((a, b) => a - b).map((day) => names[day]!).join('、');
    if (hours.length === 1 && minutes.length === 1) return `每${days} ${pad(hours[0]!)}:${pad(minutes[0]!)}`;
    return `每${days}`;
  }
  return source;
}

const FALLBACK_TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** 把毫秒时间格式化成某个时区的「MM-DD HH:mm」。 */
export function formatZoned(at: number | undefined, timezone: string): string {
  if (typeof at !== 'number' || !Number.isFinite(at)) return '—';
  try {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: safeTimezone(timezone),
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(at));
    const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
    return `${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}`;
  } catch {
    return FALLBACK_TIME_FORMAT.format(new Date(at));
  }
}