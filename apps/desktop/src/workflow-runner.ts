import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  phaseToNodeStatus,
  type NodeRunState,
  type RunPhase,
  type WfNode,
  type Workflow,
  type WorkflowRunEvent,
  type WorkflowRunState,
  type TurnEvent,
} from '@olivia/core';
import { SnapshotStore, type Policy } from '@olivia/exec';
import { runAgentTurn, type AgentOptions } from './agent';
import { git, isRepo } from './git';

/**
 * M4：工作流真实执行。
 *
 * 调度按 DAG 走：上游全 done 才会启动下游；agent 节点各自开一个 git worktree，
 * 互不踩文件；每个 worker 完成后把分支合进 `olivia/wf/<runId>` 集成分支，
 * 评审节点在集成分支的只读副本上看成品，审批门停下来等人。
 */

export interface WorkflowRuntimeOptions {
  runId: string;
  workflow: Workflow;
  workspace: string;
  /** worktree 的落盘根目录（应用数据目录），不能放在工作区里 */
  worktreeRoot: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  allowShell: boolean;
  maxParallel?: number;
  snapshots: SnapshotStore;
  emit: (event: WorkflowRunEvent) => void;
  requestGate: (node: WfNode, detail: string) => Promise<boolean>;
  signal: AbortSignal;
}

const KIND_LABEL: Record<WfNode['kind'], string> = {
  trigger: '触发器',
  agent: '并行 Agent',
  reviewer: '评审 Agent',
  gate: '审批门',
  output: '产出',
};

/** 节点能用的工具：把画布上的简写映射成真实工具名。 */
const TOOL_MAP: Record<string, string[]> = {
  read: ['list_dir', 'read_file', 'search', 'git_status', 'git_diff'],
  write: ['write_file', 'apply_patch'],
  patch: ['apply_patch'],
  shell: ['run_command'],
  git: ['git_status', 'git_diff', 'git_commit', 'git_push', 'git_create_pr'],
  test: ['run_command'],
};

function resolveTools(node: WfNode): string[] {
  const raw = node.tools?.length ? node.tools : ['read', 'write', 'patch', 'git'];
  const set = new Set<string>();
  for (const item of raw) {
    for (const name of TOOL_MAP[item] ?? [item]) set.add(name);
  }
  return [...set];
}

function scopePrompt(node: WfNode, workflow: Workflow): string {
  const body = (node.prompt ?? node.subtitle ?? '').replace(/\{\{scope\}\}/g, node.title);
  const lines = [
    `你在工作流「${workflow.name}」里担任「${node.title}」（${KIND_LABEL[node.kind]}）。`,
    '',
    body,
    '',
  ];
  if (node.kind === 'reviewer') {
    lines.push(
      '这是评审节点：只读，禁止修改文件。先看 diff 与仓库现状，再给出结论；不要相信实现者的自述。',
      '结论请分「必须修 / 建议修 / 可以通过」三档，直接说问题与位置。',
    );
  } else {
    lines.push(
      '只改与你职责相关的文件，不要顺手重构无关模块。改完必须自己验证（能跑测试就跑测试）。',
      '最后用一段话总结：改了什么、验证结果、有没有遗留问题。',
    );
  }
  return lines.join('\n');
}

function silentSessions(): NonNullable<AgentOptions['sessions']> {
  return {
    append: async () => undefined,
    read: async () => [],
  } as unknown as NonNullable<AgentOptions['sessions']>;
}

async function gitMust(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.code !== 0) {
    throw new Error((result.stderr || result.stdout).trim() || `git ${args[0]} 失败`);
  }
  return result.stdout;
}

function shortId(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9]/g, '').slice(-10) || 'run';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class Semaphore {
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
  }

  release(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next) next();
  }
}

export async function runWorkflow(options: WorkflowRuntimeOptions): Promise<WorkflowRunState> {
  const { runId, workflow, workspace, emit, signal } = options;
  const startedAt = Date.now();
  const state: WorkflowRunState = {
    id: runId,
    workflowId: workflow.id,
    workflowName: workflow.name,
    workspace,
    phase: 'running',
    startedAt,
    nodes: {},
    logs: [],
  };
  for (const node of workflow.nodes) {
    state.nodes[node.id] = { nodeId: node.id, phase: 'queued', attempts: 0 };
  }

  const log = (text: string, kind: WorkflowRunState['logs'][number]['kind'] = 'info', nodeId?: string): void => {
    state.logs.push({ at: Date.now(), nodeId, kind, text });
    if (state.logs.length > 400) state.logs.splice(0, state.logs.length - 400);
    emit({ type: 'node.log', nodeId, kind, text });
  };

  const setPhase = (nodeId: string, phase: RunPhase, patch: Partial<NodeRunState> = {}): void => {
    const current = state.nodes[nodeId] ?? { nodeId, phase, attempts: 0 };
    const next: NodeRunState = { ...current, ...patch, phase };
    if (phase === 'running' && !next.startedAt) next.startedAt = Date.now();
    if ((phase === 'done' || phase === 'failed' || phase === 'skipped' || phase === 'canceled') && !next.endedAt) {
      next.endedAt = Date.now();
    }
    state.nodes[nodeId] = next;
    emit({
      type: 'node.status',
      nodeId,
      phase,
      summary: next.summary,
      error: next.error,
    });
  };

  emit({ type: 'run.start', run: structuredClone(state) });

  const repo = await isRepo(workspace).catch(() => false);
  if (!repo) {
    return finish({ ok: false, error: '工作流需要 git 仓库：并行 Agent 靠 worktree 隔离，请先绑定一个仓库。' });
  }
  const head = await git(workspace, ['rev-parse', '--verify', 'HEAD']);
  if (head.code !== 0) {
    return finish({ ok: false, error: '仓库还没有任何提交，先提交一次再跑工作流。' });
  }

  const short = shortId(runId);
  const baseDir = path.join(options.worktreeRoot, short);
  const integrationDir = path.join(baseDir, 'integration');
  const integrationBranch = `olivia/wf-${short}`;
  const baseRef = head.stdout.trim();
  // 仓库没配提交身份时，worker 的提交与合并提交都会失败；这里补一个工作流专用身份。
  const hasIdentity = (await git(workspace, ['config', 'user.email'])).stdout.trim() !== '';
  const identity = hasIdentity
    ? []
    : ['-c', 'user.name=OliviaCode Workflow', '-c', 'user.email=workflow@olivia.local'];

  try {
    await fs.mkdir(baseDir, { recursive: true });
    await gitMust(workspace, ['worktree', 'add', '-b', integrationBranch, integrationDir, 'HEAD']);
    state.branch = integrationBranch;
    log(`集成分支 ${integrationBranch} 就绪（worktree: ${integrationDir}）`);
  } catch (error) {
    return finish({ ok: false, error: `创建集成分支失败：${errorText(error)}` });
  }

  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const upstream = new Map<string, string[]>();
  for (const node of workflow.nodes) upstream.set(node.id, []);
  for (const edge of workflow.edges) {
    upstream.get(edge.to)?.push(edge.from);
  }

  const semaphore = new Semaphore(Math.max(1, Math.min(6, options.maxParallel ?? 3)));
  let mergeChain: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = mergeChain.then(task, task);
    mergeChain = next.catch(() => undefined);
    return next;
  };

  const removeWorktree = async (dir: string): Promise<void> => {
    await git(workspace, ['worktree', 'remove', '--force', dir]).catch(() => undefined);
  };

  const runAgentNode = async (node: WfNode): Promise<RunPhase> => {
    const branch = `olivia/wf-${short}-${node.id}`;
    const dir = path.join(baseDir, node.id);
    const attempts = 1 + Math.max(0, Math.min(1, node.retries ?? 0));
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (signal.aborted) return 'canceled';
      setPhase(node.id, 'running', { attempts: attempt, branch, worktree: dir });
      try {
        if (attempt === 1) {
          await gitMust(workspace, ['worktree', 'add', '-b', branch, dir, 'HEAD']);
        } else {
          await gitMust(dir, ['reset', '--hard', 'HEAD']);
          await gitMust(dir, ['clean', '-fd']);
        }
        log(`worker worktree 就绪：${dir}`, 'info', node.id);

        const policy: Policy = { mode: 'workspace-write', root: dir };
        let text = '';
        await runAgentTurn({
          taskId: `${runId}:${node.id}`,
          turnId: `${runId}-${node.id}-${attempt}`,
          prompt: scopePrompt(node, workflow),
          history: [],
          model: node.model || options.model,
          baseUrl: options.baseUrl,
          apiKey: options.apiKey,
          approval: 'auto',
          allowShell: options.allowShell,
          policy,
          snapshots: options.snapshots,
          sessions: silentSessions(),
          tools: resolveTools(node),
          emit: (event: TurnEvent): void => {
            if (event.type === 'text') {
              text += event.delta;
              return;
            }
            if (event.type === 'tool.request') {
              log(`${event.call.name} · ${event.call.detail}`, 'tool', node.id);
              return;
            }
            if (event.type === 'tool.result') {
              if (event.status === 'error') log(`失败：${event.summary}`, 'error', node.id);
              return;
            }
            if (event.type === 'file.changed') {
              log(`写入 ${event.path}（+${event.adds} −${event.dels}）`, 'text', node.id);
            }
          },
          requestApproval: async () => 'once',
          requestPatch: async (input) => input.edits.map((edit) => edit.index),
          gitToken: () => null,
          signal,
        });

        const status = await gitMust(dir, ['status', '--porcelain']);
        if (status.trim()) {
          await gitMust(dir, ['add', '-A']);
          await gitMust(dir, [...identity, 'commit', '-m', `wf: ${node.title}`]);
        }
        const commit = (await gitMust(dir, ['rev-parse', '--short', 'HEAD'])).trim();

        await serial(async () => {
          await gitMust(integrationDir, [
            ...identity,
            'merge',
            '--no-ff',
            branch,
            '-m',
            `wf: merge ${node.title} (${commit})`,
          ]);
        });
        await removeWorktree(dir);
        await git(workspace, ['branch', '-D', branch]).catch(() => undefined);

        const summary = text.trim().split('\n').filter(Boolean).slice(-2).join(' ') || `已合并 ${commit}`;
        setPhase(node.id, 'done', { summary: summary.slice(0, 240), endedAt: Date.now() });
        log(`合并 ${branch} → ${integrationBranch}`, 'info', node.id);
        return 'done';
      } catch (error) {
        lastError = errorText(error);
        if (signal.aborted) return 'canceled';
        log(`第 ${attempt} 次执行失败：${lastError}`, 'error', node.id);
        if (attempt === attempts) break;
        log('重试一次（worktree 会重置到 HEAD）', 'info', node.id);
      }
    }

    setPhase(node.id, 'failed', { error: lastError, endedAt: Date.now() });
    return 'failed';
  };

  const runReviewerNode = async (node: WfNode): Promise<RunPhase> => {
    setPhase(node.id, 'running', { attempts: 1 });
    try {
      const diff = await gitMust(integrationDir, ['diff', '--stat', baseRef]);
      const policy: Policy = { mode: 'read-only', root: integrationDir };
      let text = '';
      await runAgentTurn({
        taskId: `${runId}:${node.id}`,
        turnId: `${runId}-${node.id}`,
        prompt: `${scopePrompt(node, workflow)}\n\n本次改动概览（git diff --stat）：\n${diff || '（无改动）'}`,
        history: [],
        model: node.model || options.model,
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        approval: 'auto',
        allowShell: false,
        policy,
        snapshots: options.snapshots,
        sessions: silentSessions(),
        tools: resolveTools({ ...node, tools: node.tools?.length ? node.tools : ['read', 'git'] }),
        emit: (event: TurnEvent): void => {
          if (event.type === 'text') text += event.delta;
          if (event.type === 'tool.request') log(`${event.call.name} · ${event.call.detail}`, 'tool', node.id);
        },
        requestApproval: async () => 'once',
        requestPatch: async () => null,
        gitToken: () => null,
        signal,
      });
      const summary = text.trim().split('\n').filter(Boolean).slice(0, 3).join(' ');
      setPhase(node.id, 'done', { summary: summary.slice(0, 300), endedAt: Date.now() });
      return 'done';
    } catch (error) {
      const message = errorText(error);
      setPhase(node.id, 'failed', { error: message, endedAt: Date.now() });
      log(`评审失败：${message}`, 'error', node.id);
      return 'failed';
    }
  };

  const runGateNode = async (node: WfNode): Promise<RunPhase> => {
    setPhase(node.id, 'waiting');
    const detail = `集成分支 ${integrationBranch} 已有 ${(await gitMust(integrationDir, ['rev-list', '--count', `${baseRef}..HEAD`]).catch(() => '0')).trim()} 个提交待确认`;
    emit({ type: 'gate.waiting', nodeId: node.id, title: node.title, detail });
    try {
      const approved = await options.requestGate(node, detail);
      if (!approved) {
        setPhase(node.id, 'failed', { error: '人工审批未通过', endedAt: Date.now() });
        return 'failed';
      }
      setPhase(node.id, 'done', { summary: '已批准', endedAt: Date.now() });
      return 'done';
    } catch (error) {
      setPhase(node.id, 'failed', { error: errorText(error), endedAt: Date.now() });
      return 'failed';
    }
  };

  const runOutputNode = async (node: WfNode): Promise<RunPhase> => {
    setPhase(node.id, 'running', { attempts: 1 });
    try {
      const [stat, files] = await Promise.all([
        gitMust(integrationDir, ['diff', '--stat', baseRef]),
        gitMust(integrationDir, ['diff', '--name-only', baseRef]),
      ]);
      const count = files.split('\n').filter(Boolean).length;
      const summary = `分支 ${integrationBranch} · ${count} 个文件 · ${(await gitMust(integrationDir, ['rev-list', '--count', `${baseRef}..HEAD`])).trim()} 个提交`;
      log(`产出就绪：\n${stat.trim()}`, 'text', node.id);
      setPhase(node.id, 'done', { summary, endedAt: Date.now() });
      return 'done';
    } catch (error) {
      setPhase(node.id, 'failed', { error: errorText(error), endedAt: Date.now() });
      return 'failed';
    }
  };

  const execute = async (node: WfNode): Promise<RunPhase> => {
    if (signal.aborted) return 'canceled';
    switch (node.kind) {
      case 'trigger':
        setPhase(node.id, 'done', { summary: '已触发', endedAt: Date.now() });
        return 'done';
      case 'gate':
        return await runGateNode(node);
      case 'reviewer':
        return await runReviewerNode(node);
      case 'output':
        return await runOutputNode(node);
      case 'agent':
      default:
        return await runAgentNode(node);
    }
  };

  const results = new Map<string, Promise<RunPhase>>();
  const schedule = (node: WfNode): Promise<RunPhase> => {
    const cached = results.get(node.id);
    if (cached) return cached;
    const promise = (async (): Promise<RunPhase> => {
      const phases = await Promise.all((upstream.get(node.id) ?? []).map((id) => {
        const parent = nodeById.get(id);
        return parent ? schedule(parent) : Promise.resolve<RunPhase>('skipped');
      }));
      if (phases.some((phase) => phase !== 'done')) {
        setPhase(node.id, 'skipped', { summary: '上游未完成', endedAt: Date.now() });
        return 'skipped';
      }
      if (signal.aborted) return 'canceled';
      const needsSlot = node.kind === 'agent' || node.kind === 'reviewer';
      if (needsSlot) await semaphore.acquire();
      try {
        return await execute(node);
      } finally {
        if (needsSlot) semaphore.release();
      }
    })();
    results.set(node.id, promise);
    return promise;
  };

  const phases = await Promise.all(workflow.nodes.map((node) => schedule(node)));
  const ok = phases.every((phase) => phase === 'done') && !signal.aborted;

  // 收尾：集成分支留下，integration worktree 拆掉，别占着用户的仓库
  await removeWorktree(integrationDir);
  for (const node of workflow.nodes) {
    if (state.nodes[node.id]?.worktree) await removeWorktree(state.nodes[node.id]!.worktree!);
  }

  if (ok) {
    log(`工作流完成，结果在分支 ${integrationBranch}`);
    return finish({ ok: true, branch: integrationBranch });
  }
  const failed = workflow.nodes.filter((node) => state.nodes[node.id]?.phase === 'failed');
  if (signal.aborted) {
    return finish({ ok: false, error: '已取消', canceled: true });
  }
  return finish({
    ok: false,
    error: failed.length
      ? `节点失败：${failed.map((node) => `${node.title}（${state.nodes[node.id]?.error ?? '未知错误'}）`).join('；')}`
      : '有节点没有跑完',
  });

  function finish(result: { ok: boolean; error?: string; branch?: string; canceled?: boolean }): WorkflowRunState {
    state.phase = result.ok ? 'done' : result.canceled ? 'canceled' : 'failed';
    state.endedAt = Date.now();
    state.error = result.error;
    if (result.branch) state.branch = result.branch;
    emit({ type: 'run.done', ok: result.ok, branch: state.branch, error: result.error });
    return state;
  }
}

/** 画布状态 → 运行态（UI 在没接到事件前也能显示） */
export function nodePhaseOf(state: WorkflowRunState | null, nodeId: string): RunPhase {
  return state?.nodes[nodeId]?.phase ?? 'queued';
}

export { phaseToNodeStatus };
