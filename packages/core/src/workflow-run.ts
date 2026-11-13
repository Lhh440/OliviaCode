import type { WfNode, Workflow } from './workflow';

/**
 * 工作流运行时：主进程按 DAG 调度节点，把状态与日志流回渲染层。
 * 这里的类型双端共用，UI 只认 phase 与事件，不关心节点内部怎么跑。
 */

export type RunPhase =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'canceled';

export type RunLogKind = 'info' | 'text' | 'tool' | 'error';

export interface NodeRunState {
  nodeId: string;
  phase: RunPhase;
  attempts: number;
  startedAt?: number;
  endedAt?: number;
  /** 该节点独占的 worktree 与分支（评审/审批节点没有） */
  branch?: string;
  worktree?: string;
  summary?: string;
  error?: string;
}

export interface RunLogLine {
  at: number;
  nodeId?: string;
  kind: RunLogKind;
  text: string;
}

export interface WorkflowRunState {
  id: string;
  workflowId: string;
  workflowName: string;
  workspace: string;
  phase: RunPhase;
  startedAt: number;
  endedAt?: number;
  /** 所有 worker 分支合并后的结果分支 */
  branch?: string;
  nodes: Record<string, NodeRunState>;
  logs: RunLogLine[];
  error?: string;
}

export type WorkflowRunEvent =
  | { type: 'run.start'; run: WorkflowRunState }
  | { type: 'node.status'; nodeId: string; phase: RunPhase; summary?: string; error?: string }
  | { type: 'node.log'; nodeId?: string; kind: RunLogKind; text: string }
  | { type: 'gate.waiting'; nodeId: string; title: string; detail: string }
  | { type: 'run.done'; ok: boolean; branch?: string; error?: string };

export type WorkflowGateDecision = boolean;

export interface WorkflowRunArgs {
  runId: string;
  workflow: Workflow;
  workspace: string;
  model?: string;
  allowShell?: boolean;
  /** 设置页里填的端点与密钥，优先于环境变量 */
  baseUrl?: string;
  apiKey?: string;
  /** 同时跑的节点上限，默认 3 */
  maxParallel?: number;
}

export const RUN_PHASE_LABEL: Record<RunPhase, string> = {
  queued: '排队',
  running: '执行中',
  waiting: '等待确认',
  done: '完成',
  failed: '失败',
  skipped: '跳过',
  canceled: '已取消',
};

/** 运行态映射回画布上的节点状态。 */
export function phaseToNodeStatus(phase: RunPhase): WfNode['status'] {
  switch (phase) {
    case 'running':
      return 'running';
    case 'waiting':
      return 'waiting';
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
    default:
      return 'idle';
  }
}

/** 节点最终会改动哪些文件由模型决定，这里只做提示用的工具清单。 */
export function scopeOf(node: WfNode): string {
  return node.title;
}
