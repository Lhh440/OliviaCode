import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  GATE_MODE_LABEL,
  RUN_STATUS_LABEL,
  type RunRecord,
  type ScheduleRecord,
  type Workflow,
  type WorkflowRunState,
} from '@olivia/core';

/**
 * 运行报告：一次运行一份 Markdown，落在 `<userData>/reports/<scheduleId>/<runId>.md`。
 * 结构固定，便于人扫读，也便于以后接 CI / 通知机器人解析。
 */
export interface ReportInput {
  schedule: ScheduleRecord;
  run: RunRecord;
  state: WorkflowRunState | null;
  workflow: Workflow;
  /** 评审节点的文字结论（可选） */
  review?: string;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function stamp(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function duration(from: number, to: number | undefined): string {
  if (!to || to < from) return '—';
  const seconds = Math.round((to - from) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${seconds % 60}s`;
}

const PHASE_ICON: Record<string, string> = {
  done: '✅',
  failed: '❌',
  skipped: '⏭',
  canceled: '⏹',
  waiting: '⏸',
  running: '⏳',
  queued: '·',
};

export function renderReport(input: ReportInput): string {
  const { schedule, run, state, workflow } = input;
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const lines: string[] = [];

  lines.push(`# ${schedule.workflowName} · ${stamp(run.startedAt)}（无人值守）`);
  lines.push('');
  lines.push(`- 结果：**${RUN_STATUS_LABEL[run.status]}**${run.error ? `（${run.error}）` : ''}`);
  lines.push(`- 计划：\`${schedule.cron}\` · ${schedule.timezone} · 审批门 ${GATE_MODE_LABEL[schedule.policy.gate]}`);
  lines.push(`- 工作区：${run.workspace}`);
  lines.push(`- 耗时：${duration(run.startedAt, run.endedAt)}`);
  if (run.branch) lines.push(`- 结果分支：\`${run.branch}\`${run.prUrl ? '' : '（留在本地，未推送）'}`);
  if (run.prUrl) lines.push(`- Pull Request：${run.prUrl}`);
  if (run.missed && run.missed > 0) {
    lines.push(`- 补跑：错过 ${run.missed} 次，本次只补跑最近一次（其余记为跳过）`);
  }
  lines.push('');

  lines.push('## 节点');
  lines.push('');
  if (state && Object.keys(state.nodes).length > 0) {
    for (const nodeState of Object.values(state.nodes)) {
      const title = nodeState.title || nodeById.get(nodeState.nodeId)?.title || nodeState.nodeId;
      const icon = PHASE_ICON[nodeState.phase] ?? '·';
      const summary = nodeState.error ?? nodeState.summary ?? '';
      lines.push(`- ${icon} **${title}** —— ${RUN_STATUS_LABEL[nodeState.phase as keyof typeof RUN_STATUS_LABEL] ?? nodeState.phase}${summary ? `：${summary}` : ''}`);
    }
  } else {
    lines.push('- （没有拿到节点状态）');
  }
  lines.push('');

  const changed = state?.logs.filter((line) => line.kind === 'text' && line.text.startsWith('写入 ')) ?? [];
  lines.push('## 改动');
  lines.push('');
  if (changed.length > 0) {
    for (const line of changed.slice(-30)) lines.push(`- ${line.text}`);
  } else {
    lines.push('- 本次没有文件写入。');
  }
  lines.push('');

  lines.push('## 评审');
  lines.push('');
  lines.push(input.review?.trim() || '（没有评审节点，或评审没有输出文字）');
  lines.push('');

  const errors = state?.logs.filter((line) => line.kind === 'error') ?? [];
  if (errors.length > 0) {
    lines.push('## 错误与告警');
    lines.push('');
    for (const line of errors.slice(-10)) {
      const node = line.nodeId ? nodeById.get(line.nodeId)?.title ?? line.nodeId : '';
      lines.push(`- ${node ? `[${node}] ` : ''}${line.text}`);
    }
    lines.push('');
  }

  lines.push('## 日志尾部');
  lines.push('');
  lines.push('```');
  for (const line of (state?.logs ?? []).slice(-12)) {
    const node = line.nodeId ? nodeById.get(line.nodeId)?.title ?? line.nodeId : '';
    lines.push(`${node ? `[${node}] ` : ''}${line.text}`);
  }
  if (!state?.logs?.length) lines.push('（无日志）');
  lines.push('```');
  lines.push('');
  lines.push(`> 由 OliviaCode 无人值守调度生成 · runId \`${run.id}\``);

  return `${lines.join('\n')}\n`;
}

export async function writeReport(baseDir: string, input: ReportInput): Promise<string> {
  const dir = path.join(baseDir, input.schedule.id.replace(/[^a-zA-Z0-9_-]/g, '_'));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${input.run.id}.md`);
  await fs.writeFile(file, renderReport(input), 'utf8');
  return file;
}