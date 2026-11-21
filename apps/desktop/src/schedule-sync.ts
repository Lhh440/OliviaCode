import {
  DEFAULT_UNATTENDED_POLICY,
  safeTimezone,
  tryParseCron,
  type ScheduleRecord,
  type UnattendedMode,
  type UnattendedPolicy,
  type Workflow,
} from '@olivia/core';

/**
 * 排期从触发节点派生：画布是唯一真相，这里只负责把画布上的触发器映射成账本记录。
 *
 * 规则：
 * - trigger 节点缺 `schedule` → 不产生排期；
 * - cron 不合法 → **不生成计划**，原因回传给界面（画布上直接提示），
 *   绝不让「无效：每晚 22:00」这种记录流到计划页；
 * - 节点 id 每次重新载入画布都可能变（种子节点是新建的），所以同工作流 + 同 cron
 *   认领已有记录，避免同一条计划被派生两遍；
 * - `enabled === false` → 保留记录但停用（历史与下次时间都还在）；
 * - 触发器从画布上删掉 → 对应记录停用并标记 orphan，账本不删（运行历史还要能看）。
 */
export interface SyncInput {
  workflow: Workflow;
  workspace: string;
}

export interface SyncResult {
  records: ScheduleRecord[];
  created: string[];
  disabled: string[];
  /** 没有生成计划的原因（cron 不合法等），界面直接提示 */
  invalid: string[];
}

function policyOf(nodePolicy: Partial<UnattendedPolicy> | undefined): UnattendedPolicy {
  return { ...DEFAULT_UNATTENDED_POLICY, ...(nodePolicy ?? {}) };
}

export function scheduleIdOf(workflowId: string, triggerNodeId: string): string {
  return `${workflowId}:${triggerNodeId}`;
}

/** 把一份画布草稿同步成账本记录（不改动没出现在这份草稿里的其它工作流）。 */
export function syncWorkflow(
  existing: ScheduleRecord[],
  input: SyncInput,
  now: number,
): SyncResult {
  const { workflow, workspace } = input;
  const triggers = workflow.nodes.filter((node) => node.kind === 'trigger');
  const records: ScheduleRecord[] = [];
  const created: string[] = [];
  const disabled: string[] = [];
  const invalid: string[] = [];
  const claimed = new Set<string>();

  for (const trigger of triggers) {
    const cron = (trigger.schedule ?? '').trim();
    if (!cron) continue;

    const direct = existing.find((item) => item.id === scheduleIdOf(workflow.id, trigger.id));
    // 节点 id 变了但触发器还是那一条：按「同工作流 + 同 cron」认领旧记录，防止派生重复
    const adopted =
      direct ??
      existing.find(
        (item) =>
          item.workflowId === workflow.id &&
          item.cron === cron &&
          !claimed.has(item.id) &&
          !records.some((record) => record.triggerNodeId === item.triggerNodeId),
      );
    const previous = direct ?? adopted;

    const parsed = tryParseCron(cron);
    if (!parsed.ok) {
      invalid.push(`「${trigger.title}」的 cron 不合法（${parsed.error}），没有生成计划`);
      if (previous) {
        // 坏 cron 绝不允许自动跑：保留记录但强制停用，并回写原文便于修正
        records.push({ ...previous, cron, enabled: false, updatedAt: now });
        claimed.add(previous.id);
        if (previous.enabled) disabled.push(previous.workflowName);
      }
      continue;
    }

    const id = previous?.id ?? scheduleIdOf(workflow.id, trigger.id);
    claimed.add(id);
    // 新计划一律先暂停：无人值守必须由用户在「计划」页显式确认启用，
    // 不能因为画布上填了 cron 就默默开始定时改代码。已存在的记录由账本持有启停状态。
    const enabled = previous ? previous.enabled : false;
    const record: ScheduleRecord = {
      id,
      workflowId: workflow.id,
      triggerNodeId: trigger.id,
      workflowName: workflow.name,
      workspace,
      cron,
      timezone: safeTimezone(trigger.timezone),
      enabled,
      mode: previous?.mode ?? 'report',
      policy: previous?.policy ?? policyOf(undefined),
      workflow: structuredClone(workflow),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      lastRunAt: previous?.lastRunAt,
      lastStatus: previous?.lastStatus,
      nextRunAt: previous?.nextRunAt,
    };
    if (!previous) created.push(trigger.title);
    if (previous?.enabled && !enabled) disabled.push(trigger.title);
    records.push(record);
  }

  // 画布上已不存在的触发器：停用（保留历史）
  for (const previous of existing) {
    if (previous.workflowId !== workflow.id) continue;
    if (records.some((item) => item.id === previous.id)) continue;
    if (!previous.enabled) continue;
    records.push({ ...previous, enabled: false, updatedAt: now });
    disabled.push(previous.workflowName);
  }

  const merged = existing.map((item) => records.find((next) => next.id === item.id) ?? item);
  for (const record of records) {
    const index = merged.findIndex((item) => item.id === record.id);
    if (index >= 0) merged[index] = record;
    else merged.push(record);
  }
  return { records: merged, created, disabled, invalid };
}

export function validatePolicy(policy: UnattendedPolicy): string | null {
  if (!['pause-and-notify', 'auto-approve', 'auto-reject'].includes(policy.gate)) return '审批门策略不合法';
  if (!Number.isFinite(policy.gateTimeout) || policy.gateTimeout < 1 || policy.gateTimeout > 24 * 60) {
    return '审批门超时要在 1–1440 分钟之间';
  }
  if (!Number.isFinite(policy.maxWallMinutes) || policy.maxWallMinutes < 1 || policy.maxWallMinutes > 24 * 60) {
    return '单次运行上限要在 1–1440 分钟之间';
  }
  if (!Number.isFinite(policy.maxNodes) || policy.maxNodes < 1 || policy.maxNodes > 500) return '节点数上限不合法';
  if (!Number.isFinite(policy.maxSteps) || policy.maxSteps < 1 || policy.maxSteps > 1000) return '步数上限不合法';
  return null;
}

export function normalizeMode(mode: string | undefined): UnattendedMode {
  return mode === 'report-pr' ? 'report-pr' : 'report';
}