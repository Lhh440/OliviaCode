import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  makeNode,
  uid,
  type Workflow,
  type WorkflowRunEvent,
} from '@olivia/core';
import { SnapshotStore } from '@olivia/exec';
import { runWorkflow } from './workflow-runner';

/**
 * 工作流自检：不需要真实模型。
 *
 * 起一个 mock OpenAI 端点，造一个临时 git 仓库，跑「触发 → 两个并行 worker → 审批门 → 产出」。
 * 断言：并行真的重叠、worktree 隔离、分支合并、worktree 收尾干净、审批门必须被问到。
 */

const results: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

function execFile(file: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${file} ${args.join(' ')} 失败：${(stderr || stdout).trim()}`));
    });
  });
}

const git = (cwd: string, ...args: string[]): Promise<string> => execFile('git', args, cwd);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForPort(port: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error('mock 模型端点没有起来');
}

function buildWorkflow(gateTitle: string): { workflow: Workflow; ids: Record<string, string> } {
  const trigger = makeNode({
    kind: 'trigger',
    title: '手动触发',
    subtitle: '触发器',
    status: 'ready',
    x: 40,
    y: 200,
  });
  const workerA = makeNode({
    kind: 'agent',
    title: '写 a.txt',
    subtitle: 'worker a',
    model: 'mock-wf',
    tools: ['read', 'write'],
    prompt: '把仓库里的 a.txt 写成 A。[[WRITE:a.txt:A]]',
    x: 260,
    y: 140,
  });
  const workerB = makeNode({
    kind: 'agent',
    title: '写 b.txt',
    subtitle: 'worker b',
    model: 'mock-wf',
    tools: ['read', 'write'],
    prompt: '把仓库里的 b.txt 写成 B。[[WRITE:b.txt:B]]',
    x: 260,
    y: 280,
  });
  const gate = makeNode({
    kind: 'gate',
    title: gateTitle,
    subtitle: 'Policy · 合并前确认',
    x: 480,
    y: 210,
  });
  const output = makeNode({
    kind: 'output',
    title: '产出汇总',
    subtitle: 'Output · 结果分支',
    x: 700,
    y: 210,
  });

  const edge = (from: string, to: string) => ({ id: uid('edge'), from, to });
  const workflow: Workflow = {
    id: uid('wf'),
    name: 'M4 自检工作流',
    nodes: [trigger, workerA, workerB, gate, output],
    edges: [
      edge(trigger.id, workerA.id),
      edge(trigger.id, workerB.id),
      edge(workerA.id, gate.id),
      edge(workerB.id, gate.id),
      edge(gate.id, output.id),
    ],
    updatedAt: Date.now(),
  };
  return {
    workflow,
    ids: { trigger: trigger.id, a: workerA.id, b: workerB.id, gate: gate.id, output: output.id },
  };
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'olivia-wf-'));
  const repo = path.join(root, 'repo');
  const worktrees = path.join(root, 'worktrees');
  const snapshotsDir = path.join(root, 'snapshots');
  await fs.mkdir(repo, { recursive: true });
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.name', 'OliviaCode Test');
  await git(repo, 'config', 'user.email', 'test@olivia.local');
  await fs.writeFile(path.join(repo, 'README.md'), '# demo repo\n', 'utf8');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'init');

  const port = await freePort();
  const mock = spawn(process.execPath, [path.join(process.cwd(), 'scripts', 'mock-llm.cjs'), String(port)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  mock.stdout?.setEncoding('utf8');
  let mockLog = '';
  mock.stdout?.on('data', (chunk: string) => {
    mockLog += chunk;
  });

  try {
    await waitForPort(port);
    check('M1 mock 端点', true, `127.0.0.1:${port}`);

    // —— 场景一：正常跑完 ——
    const { workflow, ids } = buildWorkflow('人工审批门');
    const events: WorkflowRunEvent[] = [];
    let gateAsked = 0;
    const state = await runWorkflow({
      runId: `wf_selftest_${Date.now().toString(36)}`,
      workflow,
      workspace: repo,
      worktreeRoot: worktrees,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-mock',
      model: 'mock-wf',
      allowShell: false,
      maxParallel: 3,
      snapshots: new SnapshotStore(snapshotsDir),
      emit: (event) => events.push(event),
      requestGate: async () => {
        gateAsked += 1;
        await new Promise((resolve) => setTimeout(resolve, 120));
        return true;
      },
      signal: new AbortController().signal,
    });

    check('A1 运行结束', state.phase === 'done', `phase=${state.phase}${state.error ? ` err=${state.error}` : ''}`);
    check(
      'A2 两个 worker 都完成',
      state.nodes[ids.a!]?.phase === 'done' && state.nodes[ids.b!]?.phase === 'done',
      `${state.nodes[ids.a!]?.phase}/${state.nodes[ids.b!]?.phase}`,
    );

    const a = state.nodes[ids.a!]!;
    const b = state.nodes[ids.b!]!;
    const overlap =
      Boolean(a.startedAt && a.endedAt && b.startedAt && b.endedAt) &&
      Math.max(a.startedAt ?? 0, b.startedAt ?? 0) < Math.min(a.endedAt ?? 0, b.endedAt ?? 0);
    check('A3 并行重叠', overlap, `a=${a.startedAt}-${a.endedAt} b=${b.startedAt}-${b.endedAt}`);
    check(
      'A4 各自独立 worktree',
      Boolean(a.worktree && b.worktree && a.worktree !== b.worktree),
      `${a.worktree ? path.basename(a.worktree) : '?'} / ${b.worktree ? path.basename(b.worktree) : '?'}`,
    );

    const branch = state.branch ?? '';
    check('A5 产出集成分支', branch.startsWith('olivia/wf-'), branch);
    const fileA = await git(repo, 'show', `${branch}:a.txt`).catch(() => '');
    const fileB = await git(repo, 'show', `${branch}:b.txt`).catch(() => '');
    check('A6 两条分支都合进来', fileA === 'A' && fileB === 'B', `a.txt=${JSON.stringify(fileA)} b.txt=${JSON.stringify(fileB)}`);
    const commits = Number(await git(repo, 'rev-list', '--count', `HEAD..${branch}`).catch(() => '0'));
    check('A7 集成分支有提交', commits >= 2, `commits=${commits}`);

    const worktreeList = await git(repo, 'worktree', 'list', '--porcelain');
    const worktreeCount = worktreeList.split('\n').filter((line) => line.startsWith('worktree ')).length;
    check('A8 worktree 收尾干净', worktreeCount === 1, `worktrees=${worktreeCount}`);

    check('A9 审批门被问到一次', gateAsked === 1, `gates=${gateAsked}`);
    check('A10 完成事件', events.some((event) => event.type === 'run.done' && event.ok), `events=${events.length}`);

    const order = events.filter((event) => event.type === 'node.status');
    const firstA = order.find((event) => event.type === 'node.status' && event.nodeId === ids.a && event.phase === 'running');
    const firstB = order.find((event) => event.type === 'node.status' && event.nodeId === ids.b && event.phase === 'running');
    check('A11 状态事件按节点发出', Boolean(firstA && firstB), 'a/b 都有 running');

    // —— 场景二：审批门拒绝 ——
    const rejected = buildWorkflow('拒绝门');
    let asked2 = 0;
    const state2 = await runWorkflow({
      runId: `wf_reject_${Date.now().toString(36)}`,
      workflow: rejected.workflow,
      workspace: repo,
      worktreeRoot: path.join(worktrees, 'reject'),
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-mock',
      model: 'mock-wf',
      allowShell: false,
      snapshots: new SnapshotStore(snapshotsDir),
      emit: () => undefined,
      requestGate: async () => {
        asked2 += 1;
        return false;
      },
      signal: new AbortController().signal,
    });
    check('B1 拒绝后运行失败', state2.phase === 'failed', `phase=${state2.phase}`);
    check('B2 下游被跳过', state2.nodes[rejected.ids.output!]?.phase === 'skipped', state2.nodes[rejected.ids.output!]?.phase ?? '?');
    check('B3 门只问一次', asked2 === 1, `gates=${asked2}`);
  } finally {
    mock.kill();
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }

  const passed = results.filter((item) => item.ok).length;
  console.log(`\n${passed}/${results.length} 通过${mockLog ? '' : ''}`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error('自检崩溃：', error);
  process.exitCode = 1;
});
