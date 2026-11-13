import {
  DEFAULT_UNATTENDED_POLICY,
  safeTimezone,
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
 * - `enabled === false` → 保留记录但停用（历史与下次时间都还在）；
 * - 触发器从画布上删掉 → 对应记录停用并标记 orphan，账本不删（运行历史还要能看）；
 * - cron 不合法 → 记录里原样保存，由调度器在预检时拒绝并解释原因。
 */
export interface SyncInput {
  workflow: Workflow;
  workspace: string;
}

export interface SyncResult {
  records: ScheduleRecord[];
  created: string[];
  disabled: string[];
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

  for (const trigger of triggers) {
    if (!trigger.schedule?.trim()) continue;
    const id = scheduleIdOf(workflow.id, trigger.id);
    const previous = existing.find((item) => item.id === id);
    // 新计划一律先暂停：无人值守必须由用户在「计划」页显式确认启用，
    // 不能因为画布上填了 cron 就默默开始定时改代码。已存在的记录由账本持有启停状态。
    const enabled = previous ? previous.enabled : false;
    const record: ScheduleRecord = {
      id,
      workflowId: workflow.id,
      triggerNodeId: trigger.id,
      workflowName: workflow.name,
      workspace,
      cron: trigger.schedule.trim(),
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
  return { records: merged, created, disabled };
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