import { randomUUID } from 'node:crypto';
import { nextOccurrence, tryParseCron, type McpToolResult, type PricingFile, type RunRecord, type ScheduleRecord, type SchedulerEvent, type ToolRegistry, type WorkflowRunState } from '@olivia/core';
import type { SnapshotStore } from '@olivia/exec';
import { git, isRepo, pushBranch, readStatus } from './git';
import { createPullRequest } from './providers';
import { writeReport } from './report';
import { syncWorkflow as syncSchedulesFromWorkflow, type SyncInput } from './schedule-sync';
import type { SchedulerStore } from './scheduler-store';
import { runWorkflow } from './workflow-runner';
import { checkWorkspace } from './workspace';

/**
 * M5 常驻调度器（主进程）。
 *
 * 语义（与 docs/M5.md 一致）：
 * - 常驻 tick：每 30s 检查一次，`now >= nextRunAt` 即触发；重启后由 nextRunAt 续跑；
 * - 错过只补最近一次：应用关机期间错过的，只跑最后一次，其余记「跳过」并写明次数；
 * - 重叠跳过：上一次还没结束就不开新的，记一条 skipped，不排队；
 * - 失败不自动重试；
 * - 无人值守边界：墙钟/步数预算 + 审批门策略，任何超限都失败关闭；
 * - 运行结束落 run 记录与 Markdown 报告；`report-pr` 模式额外推送结果分支并开 PR。
 */
export interface SchedulerCredentials {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface SchedulerDeps {
  store: SchedulerStore;
  snapshots: SnapshotStore;
  worktreeRoot: string;
  reportsDir: string;
  /** 票据解析：保险箱优先，回退环境变量；返回 null 表示没有可用凭据 */
  resolveCredentials: () => SchedulerCredentials | null;
  gitToken: (provider: 'github' | 'gitcode') => string | null;
  /** M7：当前价格/窗口表（无人值守预算与用量展示） */
  pricing?: () => PricingFile;
  emit: (event: SchedulerEvent) => void;
  notify?: (title: string, body: string) => void;
  now?: () => number;
  tickMs?: number;
  /** M6：无人值守可用的 MCP（默认策略会全禁，逐服务器放行） */
  mcp?: {
    createRegistry: () => ToolRegistry;
    callMcp: (name: string, args: Record<string, unknown>) => Promise<McpToolResult>;
  };
  /** M6：技能（工具放行由技能自身 requires 校验） */
  skills?: {
    catalog: (workspace: string) => Promise<{ name: string; description: string }[]>;
    load: (workspace: string, name: string) => Promise<{ ok: boolean; text?: string; error?: string }>;
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly running = new Set<string>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly nextAt = new Map<string, number | null>();
  /** 正在跑的运行 Promise：tick 里不 await，测试和退出时可以在这里等齐。 */
  private readonly active = new Map<string, Promise<RunRecord>>();
  private disposed = false;
  private ticking = false;

  constructor(private readonly deps: SchedulerDeps) {}

  private at(): number {
    return this.deps.now?.() ?? Date.now();
  }

  // —— 生命周期 ——

  async start(): Promise<void> {
    await this.deps.store.markInterrupted();
    await this.recompute();
    const interval = Math.max(1_000, this.deps.tickMs ?? 30_000);
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref?.();
    // 启动时先同步跑一轮：重启后的「补跑最近一次」要在 start() 返回前就已登记，
    // 否则调用方紧接着 idle() 会看到空集合并提前返回。
    await this.tick();
  }

  stop(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const abort of this.aborts.values()) abort.abort();
    this.aborts.clear();
  }

  // —— 排期读取与维护 ——

  async list(): Promise<ScheduleRecord[]> {
    return await this.deps.store.listSchedules();
  }

  async listRuns(scheduleId: string): Promise<RunRecord[]> {
    return await this.deps.store.listRuns(scheduleId);
  }

  async recentRuns(limit = 30): Promise<RunRecord[]> {
    return await this.deps.store.listAllRuns(limit);
  }

  /** 渲染层保存画布时同步触发节点 → 账本。 */
  async syncWorkflow(input: SyncInput): Promise<{
    schedules: ScheduleRecord[];
    created: string[];
    disabled: string[];
    invalid: string[];
  }> {
    const existing = await this.deps.store.listSchedules();
    const now = this.at();
    const result = syncSchedulesFromWorkflow(existing, input, now);
    await this.deps.store.saveSchedules(result.records);
    await this.recompute();
    for (const record of result.records) {
      if (record.workflowId === input.workflow.id) this.deps.emit({ type: 'schedule.changed', schedule: record });
    }
    return {
      schedules: result.records,
      created: result.created,
      disabled: result.disabled,
      invalid: result.invalid,
    };
  }

  async update(
    id: string,
    patch: Partial<Pick<ScheduleRecord, 'enabled' | 'mode' | 'policy'>>,
  ): Promise<ScheduleRecord | null> {
    const record = await this.deps.store.getSchedule(id);
    if (!record) return null;
    if (patch.policy) {
      const problem = validatePolicyNumbers(patch.policy);
      if (problem) throw new Error(problem);
    }
    const next: ScheduleRecord = {
      ...record,
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.mode === undefined ? {} : { mode: patch.mode }),
      ...(patch.policy === undefined ? {} : { policy: patch.policy }),
      updatedAt: this.at(),
    };
    if (next.enabled && !next.nextRunAt) {
      const parsed = tryParseCron(next.cron);
      next.nextRunAt = parsed.ok ? nextOccurrence(parsed.cron, this.at(), next.timezone) ?? undefined : undefined;
    }
    if (!next.enabled) next.nextRunAt = undefined;
    this.nextAt.delete(next.id);
    await this.deps.store.putSchedule(next);
    await this.recompute();
    this.deps.emit({ type: 'schedule.changed', schedule: next });
    return next;
  }

  /** 立即运行（不算补跑，也不改变排期节奏）。 */
  async runNow(id: string): Promise<{ ok: boolean; error?: string; run?: RunRecord }> {
    const record = await this.deps.store.getSchedule(id);
    if (!record) return { ok: false, error: '计划不存在' };
    if (this.running.has(id)) return { ok: false, error: '这个计划正在运行' };
    const run = await this.execute(record, { missed: 0, manual: true });
    return { ok: run.status === 'done', error: run.error, run };
  }

  cancel(id: string): boolean {
    const abort = this.aborts.get(id);
    if (!abort) return false;
    abort.abort();
    return true;
  }

  /** 等当前正在跑的无人值守运行全部结束（测试用；优雅退出也可以等它）。 */
  async idle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.all([...this.active.values()]);
    }
  }

  /** 界面用：接下来 n 次触发时间。 */
  async preview(id: string, count = 5): Promise<number[]> {
    const record = await this.deps.store.getSchedule(id);
    if (!record) return [];
    const parsed = tryParseCron(record.cron);
    if (!parsed.ok) return [];
    const out: number[] = [];
    let cursor = this.at();
    for (let index = 0; index < count; index += 1) {
      const next = nextOccurrence(parsed.cron, cursor, record.timezone);
      if (next === null) break;
      out.push(next);
      cursor = next;
    }
    return out;
  }

  // —— 调度核心 ——

  /**
   * 给所有启用的计划补上 nextRunAt 缓存。
   *
   * 关键：优先沿用账本里存着的 nextRunAt（哪怕它已经过期）——
   * 过期的值正是「应用关机期间错过的那次」，交给 tick 去补跑；
   * 只有压根没有下次时间的（刚创建）才从当前时间往后算，并顺手落盘。
   */
  private async recompute(): Promise<void> {
    const records = await this.deps.store.listSchedules();
    let dirty = false;
    for (const record of records) {
      if (!record.enabled) {
        this.nextAt.set(record.id, null);
        continue;
      }
      if (this.nextAt.has(record.id)) continue;
      if (typeof record.nextRunAt === 'number') {
        this.nextAt.set(record.id, record.nextRunAt);
        continue;
      }
      const parsed = tryParseCron(record.cron);
      const next = parsed.ok ? nextOccurrence(parsed.cron, this.at(), record.timezone) : null;
      this.nextAt.set(record.id, next);
      if (next !== null) {
        record.nextRunAt = next;
        dirty = true;
      }
    }
    if (dirty) await this.deps.store.saveSchedules(records);
  }

  /** 一次调度检查；测试里用虚拟时钟直接调用。 */
  async tick(): Promise<void> {
    if (this.disposed || this.ticking) return;
    this.ticking = true;
    try {
      const records = await this.deps.store.listSchedules();
      const now = this.at();
      for (const record of records) {
        if (!record.enabled) continue;
        const parsed = tryParseCron(record.cron);
        if (!parsed.ok) {
          if (record.nextRunAt !== undefined) {
            await this.deps.store.putSchedule({ ...record, nextRunAt: undefined, lastStatus: 'failed' });
            this.nextAt.set(record.id, null);
            this.deps.emit({ type: 'schedule.changed', schedule: { ...record, nextRunAt: undefined } });
          }
          continue;
        }
        let pending = this.nextAt.get(record.id);
        if (pending === undefined) {
          pending = record.nextRunAt ?? nextOccurrence(parsed.cron, now, record.timezone);
          this.nextAt.set(record.id, pending);
        }
        if (pending === null || pending > now) continue;

        // 数一下从 pending 到 now 之间错过了几次（含这一次）
        let count = 0;
        let cursor: number | null = pending;
        while (cursor !== null && cursor <= now && count < 100) {
          count += 1;
          cursor = nextOccurrence(parsed.cron, cursor, record.timezone);
        }
        const missed = Math.max(0, count - 1);
        // 推进到「现在之后」的下一次，避免补跑后原地再触发
        const nextFuture = nextOccurrence(parsed.cron, now, record.timezone);
        this.nextAt.set(record.id, nextFuture);

        if (this.running.has(record.id)) {
          const skipped: RunRecord = {
            id: `run_${now.toString(36)}${randomUUID().slice(0, 4)}`,
            scheduleId: record.id,
            workflowName: record.workflowName,
            workspace: record.workspace,
            startedAt: now,
            endedAt: now,
            status: 'skipped',
            error: '上一次运行还没结束，本次跳过（不排队）',
            missed,
            nodes: {},
          };
          await this.deps.store.saveRuns(skipped);
          await this.deps.store.putSchedule({
            ...record,
            nextRunAt: nextFuture ?? undefined,
            lastStatus: 'skipped',
            updatedAt: now,
          });
          this.deps.emit({ type: 'run.end', run: skipped });
          continue;
        }

        await this.deps.store.putSchedule({
          ...record,
          nextRunAt: nextFuture ?? undefined,
          updatedAt: now,
        });
        const promise = this.execute(record, { missed, manual: false });
        this.active.set(record.id, promise);
        void promise.finally(() => {
          if (this.active.get(record.id) === promise) this.active.delete(record.id);
        });
      }
    } finally {
      this.ticking = false;
    }
  }

  // —— 单次无人值守运行 ——

  private async execute(
    record: ScheduleRecord,
    options: { missed: number; manual: boolean },
  ): Promise<RunRecord> {
    const startedAt = this.at();
    const run: RunRecord = {
      id: `run_${startedAt.toString(36)}${randomUUID().slice(0, 4)}`,
      scheduleId: record.id,
      workflowName: record.workflowName,
      workspace: record.workspace,
      startedAt,
      status: 'running',
      missed: options.missed,
      nodes: {},
    };
    // 先占位再落盘：tick 的下一轮必须立刻看到「这个计划在跑」，否则会并发开跑
    this.running.add(record.id);
    await this.deps.store.saveRuns(run);
    const abort = new AbortController();
    this.aborts.set(record.id, abort);
    this.deps.emit({ type: 'run.start', run });

    let state: WorkflowRunState | null = null;
    const settle = async (patch: Partial<RunRecord>): Promise<RunRecord> => {
      const finished: RunRecord = {
        ...run,
        ...patch,
        endedAt: this.at(),
        nodes: state?.nodes
          ? Object.fromEntries(
              Object.values(state.nodes).map((item) => [
                item.nodeId,
                { title: item.title ?? item.nodeId, phase: item.phase, summary: item.summary, error: item.error },
              ]),
            )
          : patch.nodes ?? run.nodes,
        usage: state?.usage ?? patch.usage,
      };
      await this.deps.store.saveRuns(finished);
      const current = await this.deps.store.getSchedule(record.id);
      if (current) {
        const parsed = tryParseCron(current.cron);
        const next = parsed.ok ? nextOccurrence(parsed.cron, this.at(), current.timezone) : null;
        this.nextAt.set(current.id, next);
        await this.deps.store.putSchedule({
          ...current,
          lastRunAt: startedAt,
          lastStatus: finished.status,
          nextRunAt: next ?? undefined,
          updatedAt: this.at(),
        });
      }
      this.running.delete(record.id);
      this.aborts.delete(record.id);
      this.deps.emit({ type: 'run.end', run: finished });
      this.deps.notify?.(
        `OliviaCode · ${record.workflowName}`,
        finished.status === 'done'
          ? `无人值守运行完成${finished.branch ? `，结果在 ${finished.branch}` : ''}`
          : `运行${finished.status === 'failed' ? '失败' : finished.status}：${finished.error ?? ''}`,
      );
      return finished;
    };

    try {
      const problem = await this.preflight(record);
      if (problem) return await settle({ status: 'failed', error: problem });

      const credentials = this.deps.resolveCredentials();
      if (!credentials?.apiKey) {
        return await settle({ status: 'failed', error: '没有可用的模型密钥：请到设置保存，或预置 OLIVIA_API_KEY' });
      }

      const gateTimeoutMs = Math.max(1, record.policy.gateTimeout) * 60_000;
      state = await runWorkflow({
        runId: run.id,
        workflow: record.workflow,
        workspace: record.workspace,
        worktreeRoot: this.deps.worktreeRoot,
        baseUrl: credentials.baseUrl,
        apiKey: credentials.apiKey,
        model: credentials.model,
        allowShell: true,
        maxParallel: 3,
        snapshots: this.deps.snapshots,
        emit: () => undefined,
        signal: abort.signal,
        budget: {
          maxWallMinutes: record.policy.maxWallMinutes,
          maxSteps: record.policy.maxSteps,
          maxTokens: record.policy.maxTokens,
          maxCost: record.policy.maxCost,
        },
        pricing: this.deps.pricing?.(),
        gatePolicy: record.policy.gate,
        // M6：无人值守默认禁止 MCP，只有计划里逐服务器放行的才可用
        registry: this.deps.mcp?.createRegistry(),
        callMcp: this.deps.mcp?.callMcp,
        skillCatalog: this.deps.skills ? await this.deps.skills.catalog(record.workspace) : [],
        loadSkill: this.deps.skills
          ? (name) => this.deps.skills!.load(record.workspace, name)
          : undefined,
        mcpServers: record.policy.allowedMcpServers ?? [],
        // pause-and-notify：没人应答，等到 TTL 后按未通过处理
        requestGate: async () => {
          this.deps.notify?.(
            `OliviaCode · 审批门等待`,
            `「${record.workflowName}」停在审批门，${Math.round(gateTimeoutMs / 60_000)} 分钟内无人处理将按未通过结束`,
          );
          await sleep(gateTimeoutMs);
          return false;
        },
      });

      const status = state.phase === 'done' ? 'done' : state.phase === 'canceled' ? 'canceled' : 'failed';
      let prUrl: string | undefined;
      let prError: string | undefined;
      const branch = state.branch;

      // 先落一份报告：即使后面 PR 失败，报告也在
      const reportPath = await writeReport(this.deps.reportsDir, {
        schedule: record,
        run: { ...run, status, branch, error: state.error },
        state,
        workflow: record.workflow,
        review: reviewerText(state),
      });

      if (status === 'done' && record.mode === 'report-pr' && branch) {
        const pr = await this.openPullRequest(record, branch, reportPath);
        if (pr.ok) prUrl = pr.url;
        else prError = pr.message;
      }

      return await settle({
        status,
        branch,
        reportPath,
        prUrl,
        error: prError ?? state.error,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reportPath = await writeReport(this.deps.reportsDir, {
        schedule: record,
        run: { ...run, status: 'failed', error: message },
        state,
        workflow: record.workflow,
      }).catch(() => undefined);
      return await settle({ status: 'failed', error: message, reportPath });
    }
  }

  private async preflight(record: ScheduleRecord): Promise<string | null> {
    const workspace = await checkWorkspace(record.workspace);
    if (!workspace.ok) return workspace.message;
    if (!(await isRepo(record.workspace).catch(() => false))) {
      return '工作区不是 git 仓库：并行隔离依赖 worktree';
    }
    const head = await git(record.workspace, ['rev-parse', '--verify', 'HEAD']);
    if (head.code !== 0) return '仓库还没有任何提交，先提交一次再排期';

    const parsed = tryParseCron(record.cron);
    if (!parsed.ok) return `cron 不合法：${parsed.error}`;
    if (record.workflow.nodes.length === 0) return '画布是空的';
    if (record.workflow.nodes.length > record.policy.maxNodes) {
      return `节点数 ${record.workflow.nodes.length} 超过上限 ${record.policy.maxNodes}`;
    }
    return null;
  }

  /** 成功后推送结果分支并开 PR（仅 report-pr 模式）。失败不影响报告。 */
  private async openPullRequest(
    record: ScheduleRecord,
    branch: string,
    reportPath: string,
  ): Promise<{ ok: boolean; url?: string; message?: string }> {
    const status = await readStatus(record.workspace);
    if (!status.remote) return { ok: false, message: '没有识别出远程仓库，跳过 PR' };
    const token = this.deps.gitToken(status.remote.provider);
    if (!token) return { ok: false, message: `没有保存 ${status.remote.provider} 令牌，跳过 PR` };

    try {
      await pushBranch(record.workspace, branch, { provider: status.remote.provider, token });
    } catch (error) {
      return { ok: false, message: `推送结果分支失败：${error instanceof Error ? error.message : String(error)}` };
    }

    const outputNode = record.workflow.nodes.find((node) => node.kind === 'output');
    const base = outputNode?.targetBranch?.trim() || 'main';
    const { readFile } = await import('node:fs/promises');
    const body = await readFile(reportPath, 'utf8').catch(() => `由 OliviaCode 无人值守运行生成。\n\n分支：${branch}`);
    return await createPullRequest({
      remote: status.remote,
      token,
      title: `[OliviaCode] ${record.workflowName} · 无人值守结果`,
      body: body.slice(0, 8000),
      head: branch,
      base,
    });
  }
}

/** 从运行态里取评审节点的文字结论。 */
function reviewerText(state: WorkflowRunState | null): string | undefined {
  if (!state) return undefined;
  for (const node of Object.values(state.nodes)) {
    if (node.summary && /评审|review/i.test(node.title ?? '')) return node.summary;
  }
  return Object.values(state.nodes).find((node) => /评审|review/i.test(node.title ?? ''))?.summary;
}

function validatePolicyNumbers(policy: ScheduleRecord['policy']): string | null {
  if (!Number.isFinite(policy.gateTimeout) || policy.gateTimeout < 1 || policy.gateTimeout > 1440) {
    return '审批门超时要在 1–1440 分钟之间';
  }
  if (!Number.isFinite(policy.maxWallMinutes) || policy.maxWallMinutes < 1 || policy.maxWallMinutes > 1440) {
    return '单次运行上限要在 1–1440 分钟之间';
  }
  if (!Number.isFinite(policy.maxNodes) || policy.maxNodes < 1 || policy.maxNodes > 500) {
    return '节点数上限要在 1–500 之间';
  }
  if (!Number.isFinite(policy.maxSteps) || policy.maxSteps < 1 || policy.maxSteps > 1000) {
    return '步数上限要在 1–1000 之间';
  }
  if (
    policy.maxTokens !== undefined &&
    (!Number.isFinite(policy.maxTokens) || policy.maxTokens < 1000 || policy.maxTokens > 100_000_000)
  ) {
    return 'token 上限要在 1,000–100,000,000 之间';
  }
  if (policy.maxCost !== undefined && (!Number.isFinite(policy.maxCost) || policy.maxCost < 0 || policy.maxCost > 10_000)) {
    return '费用上限要在 0–10,000 美元之间（0 = 不设）';
  }
  if (policy.allowedMcpServers !== undefined && !Array.isArray(policy.allowedMcpServers)) {
    return '允许的 MCP 服务器必须是数组';
  }
  return null;
}