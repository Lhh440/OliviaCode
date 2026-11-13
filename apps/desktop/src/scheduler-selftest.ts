import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  makeNode,
  nextOccurrence,
  nextOccurrences,
  parseCron,
  tryParseCron,
  uid,
  type ScheduleRecord,
  type Workflow,
} from '@olivia/core';
import { SnapshotStore } from '@olivia/exec';
import { Scheduler } from './scheduler';
import { SchedulerStore } from './scheduler-store';

/**
 * M5 排期自检：虚拟时钟 + mock 模型 + 临时仓库，不依赖真实时间与外部服务。
 *
 * 覆盖：
 * - cron 解析与「下一次」的边界（非法表达式、时区、递增不重复）；
 * - 账本落盘与崩溃恢复（运行中被判中断）；
 * - 到点触发且只触发一次；关机错过只补最近一次（其余记跳过）；
 * - 上一次没跑完时不并发开跑，而是记一条 skipped；
 * - 无人值守预算（节点数上限）与缺凭据都失败关闭；
 * - 无人值守审批门：自动拒绝 → 失败，自动批准 → 成功；
 * - 报告落盘且结构可读。
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

function buildWorkflow(options: { withGate: boolean; withOutput?: boolean }): Workflow {
  const trigger = makeNode({
    kind: 'trigger',
    title: '每分钟触发',
    subtitle: '触发器',
    schedule: '* * * * *',
    x: 0,
    y: 0,
  });
  const agent = makeNode({
    kind: 'agent',
    title: '写 a.txt',
    subtitle: 'worker',
    model: 'mock-wf',
    tools: ['read', 'write'],
    prompt: '把 a.txt 写成 HELLO。[[WRITE:a.txt:HELLO]]',
    x: 220,
    y: 0,
  });
  const nodes = [trigger, agent];
  const edges = [{ id: uid('edge'), from: trigger.id, to: agent.id }];

  if (options.withGate) {
    const gate = makeNode({ kind: 'gate', title: '审批门', subtitle: 'Policy', x: 440, y: 0 });
    nodes.push(gate);
    edges.push({ id: uid('edge'), from: agent.id, to: gate.id });
    if (options.withOutput) {
      const output = makeNode({ kind: 'output', title: '汇总', subtitle: 'Output', x: 660, y: 0 });
      nodes.push(output);
      edges.push({ id: uid('edge'), from: gate.id, to: output.id });
    }
  }
  return { id: uid('wf'), name: 'M5 自检工作流', nodes, edges, updatedAt: Date.now() };
}

async function main(): Promise<void> {
  // —— A. cron 纯函数 ——
  const base = Date.parse('2026-11-13T01:00:00Z'); // 上海 09:00
  check('A1 cron 每天 09:00 下一次', nextOccurrence(parseCron('0 9 * * *'), base, 'Asia/Shanghai') === Date.parse('2026-11-14T01:00:00Z'));
  check('A2 cron */5 推进', nextOccurrence(parseCron('*/5 * * * *'), base, 'Asia/Shanghai') === base + 5 * 60_000);
  const bad = tryParseCron('0 9 * *');
  check('A3 非法 cron 被拒', bad.ok === false, bad.ok ? '' : bad.error);
  const preview = nextOccurrences(parseCron('0 9 * * *'), base, 'Asia/Shanghai', 5);
  check('A4 预览 5 次且递增', preview.length === 5 && preview.every((at, index) => index === 0 || at > preview[index - 1]!));

  // —— B. 环境 ——
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'olivia-sched-'));
  const repo = path.join(root, 'repo');
  const storeDir = path.join(root, 'store');
  const worktrees = path.join(root, 'worktrees');
  const reports = path.join(root, 'reports');
  await fs.mkdir(repo, { recursive: true });
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.name', 'OliviaCode Test');
  await git(repo, 'config', 'user.email', 'test@olivia.local');
  await fs.writeFile(path.join(repo, 'README.md'), '# sched repo\n', 'utf8');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'init');

  const port = await freePort();
  const mock = spawn(process.execPath, [path.join(process.cwd(), 'scripts', 'mock-llm.cjs'), String(port)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  mock.stdout?.setEncoding('utf8');
  mock.stdout?.on('data', () => undefined);

  const store = new SchedulerStore(storeDir);
  let now = base;
  let credentialsAvailable = true;
  const runsStarted: string[] = [];
  const scheduler = new Scheduler({
    store,
    snapshots: new SnapshotStore(path.join(root, 'snapshots')),
    worktreeRoot: worktrees,
    reportsDir: reports,
    resolveCredentials: () =>
      credentialsAvailable
        ? { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-mock', model: 'mock-wf' }
        : null,
    gitToken: () => null,
    emit: (event) => {
      if (event.type === 'run.start' && event.run) runsStarted.push(event.run.id);
    },
    now: () => now,
    tickMs: 10 * 60_000,
  });

  try {
    await waitForPort(port);

    // —— C. 账本 ——
    const workflow = buildWorkflow({ withGate: false });
    const synced = await scheduler.syncWorkflow({ workflow, workspace: repo });
    const schedule = synced.schedules.find((item) => item.workflowId === workflow.id) ?? null;
    check('C1 触发器派生出计划', Boolean(schedule) && synced.created.length === 1, `${synced.created.join(',')}`);
    check('C1b 新计划默认暂停', schedule?.enabled === false, `enabled=${schedule?.enabled}`);
    const reloaded = await new SchedulerStore(storeDir).listSchedules();
    check('C2 计划已落盘', reloaded.some((item) => item.id === schedule?.id));

    // 显式启用（等价于界面上确认启用）
    await scheduler.update(schedule!.id, { enabled: true });

    // —— D. 立即运行（完整链路 + 报告）——
    const firstRun = await scheduler.runNow(schedule!.id);
    check('D1 立即运行成功', firstRun.ok && firstRun.run?.status === 'done', firstRun.run?.error ?? '');
    check('D2 结果分支', Boolean(firstRun.run?.branch?.startsWith('olivia/wf-')), firstRun.run?.branch ?? '');
    const report = firstRun.run?.reportPath
      ? await fs.readFile(firstRun.run.reportPath, 'utf8')
      : '';
    check('D3 报告落盘', Boolean(firstRun.run?.reportPath) && report.length > 200, firstRun.run?.reportPath ?? '');
    check('D4 报告结构完整', report.includes('## 节点') && report.includes('## 改动') && report.includes('无人值守'), '');
    check('D5 报告含写入记录', report.includes('写入 a.txt'), '');
    const afterRun = await store.getSchedule(schedule!.id);
    check('D6 运行状态回写', afterRun?.lastStatus === 'done', afterRun?.lastStatus ?? '');

    // —— E. 到点触发且只触发一次 ——
    const nextAt = afterRun?.nextRunAt ?? 0;
    check('E0 nextRunAt 已排到将来', nextAt > now, new Date(nextAt).toISOString());
    now = nextAt + 1_000;
    await scheduler.tick();
    await scheduler.idle();
    const runsAfterTick = await scheduler.listRuns(schedule!.id);
    check('E1 到点触发一次', runsAfterTick.filter((run) => run.startedAt >= nextAt).length === 1, `${runsAfterTick.length} 条历史`);
    await scheduler.tick();
    await scheduler.idle();
    const runsAfterSecondTick = await scheduler.listRuns(schedule!.id);
    check('E2 同一分钟内不重复触发', runsAfterSecondTick.length === runsAfterTick.length, `${runsAfterSecondTick.length}`);

    // —— F. 关机错过：只补最近一次 ——
    const beforeMissed = runsAfterSecondTick.length;
    const currentNext = (await store.getSchedule(schedule!.id))?.nextRunAt ?? now;
    now = currentNext + 5 * 60_000 + 5_000;
    await scheduler.tick();
    await scheduler.idle();
    const runsMissed = await scheduler.listRuns(schedule!.id);
    const newest = runsMissed[0];
    check('F1 只补跑最近一次', runsMissed.length === beforeMissed + 1, `${beforeMissed} → ${runsMissed.length}`);
    check('F2 记录错过次数', (newest?.missed ?? 0) >= 4, `missed=${newest?.missed}`);

    // —— G. 重叠：上一次没结束时跳过 ——
    const overlapSchedule = (await store.getSchedule(schedule!.id))!;
    const dueAt = overlapSchedule.nextRunAt ?? now;
    now = dueAt + 1_000;
    await scheduler.tick(); // 第一次到点：真的开跑（不 await 完成）
    now = dueAt + 61_000; // 下一分钟又到点，但上一次还在跑
    await scheduler.tick();
    await scheduler.idle();
    const overlapRuns = await scheduler.listRuns(schedule!.id);
    check('G1 重叠被跳过', overlapRuns.some((run) => run.status === 'skipped'), `${overlapRuns.filter((run) => run.status === 'skipped').length} 条跳过`);

    // —— H. 无人值守预算：节点数上限 ——
    const gateWorkflow = buildWorkflow({ withGate: true, withOutput: true });
    const gateSync = await scheduler.syncWorkflow({ workflow: gateWorkflow, workspace: repo });
    const gateSchedule = gateSync.schedules.find((item) => item.workflowId === gateWorkflow.id)!;
    await scheduler.update(gateSchedule.id, { policy: { ...gateSchedule.policy, maxNodes: 1 } });
    const budgetRun = await scheduler.runNow(gateSchedule.id);
    check('H1 超预算失败关闭', budgetRun.ok === false && (budgetRun.error ?? '').includes('上限'), budgetRun.error ?? '');

    // —— I. 自动拒绝审批门 → 失败；自动批准 → 成功 ——
    await scheduler.update(gateSchedule.id, {
      policy: { ...gateSchedule.policy, maxNodes: 24, gate: 'auto-reject' },
    });
    const rejected = await scheduler.runNow(gateSchedule.id);
    check('I1 自动拒绝导致失败', rejected.ok === false && (rejected.error ?? '').includes('审批'), rejected.error ?? '');
    await scheduler.update(gateSchedule.id, {
      policy: { ...gateSchedule.policy, maxNodes: 24, gate: 'auto-approve' },
    });
    const approved = await scheduler.runNow(gateSchedule.id);
    check('I2 自动批准可以跑通', approved.ok === true, approved.error ?? '');

    // —— J. 缺凭据：预检失败，不产生半次运行 ——
    credentialsAvailable = false;
    const noCredential = await scheduler.runNow(gateSchedule.id);
    check('J1 缺凭据失败关闭', noCredential.ok === false && (noCredential.error ?? '').includes('密钥'), noCredential.error ?? '');
    credentialsAvailable = true;

    // —— K. 非法 cron 不崩，停掉排期 ——
    const broken: ScheduleRecord = {
      ...(await store.getSchedule(gateSchedule.id))!,
      cron: '不是 cron',
      enabled: true,
      nextRunAt: now + 1_000,
    };
    await store.putSchedule(broken);
    await scheduler.tick();
    await scheduler.idle();
    check('K1 非法 cron 不崩', true, 'tick 正常返回');

    // —— L. 崩溃恢复：运行中被判中断 ——
    await store.saveRuns({
      id: 'run_crash',
      scheduleId: gateSchedule.id,
      workflowName: '崩溃现场',
      workspace: repo,
      startedAt: now - 60_000,
      status: 'running',
      nodes: {},
    });
    const interrupted = await store.markInterrupted();
    const recovered = await store.getRun('run_crash');
    check('L1 运行中被判中断', interrupted.length === 1 && recovered?.status === 'interrupted', recovered?.error ?? '');

    // —— M. 重启后补跑：账本里的过期 nextRunAt 不能被重算成「未来」 ——
    const restartTarget = (await store.getSchedule(schedule!.id))!;
    const pastDue = now + 60_000;
    await store.putSchedule({ ...restartTarget, nextRunAt: pastDue, enabled: true });
    now = pastDue + 12 * 60_000;
    const restarted = new Scheduler({
      store,
      snapshots: new SnapshotStore(path.join(root, 'snapshots')),
      worktreeRoot: worktrees,
      reportsDir: reports,
      resolveCredentials: () => ({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-mock', model: 'mock-wf' }),
      gitToken: () => null,
      emit: () => undefined,
      now: () => now,
      tickMs: 10 * 60_000,
    });
    await restarted.start();
    await restarted.idle();
    restarted.stop();
    const afterRestart = await scheduler.listRuns(schedule!.id);
    const restartRun = afterRestart.find((run) => run.startedAt >= now);
    check('M1 重启后补跑最近一次', Boolean(restartRun), restartRun ? `missed=${restartRun.missed}` : '没有新运行');
    check('M2 补跑记录了错过次数', (restartRun?.missed ?? 0) >= 10, `missed=${restartRun?.missed}`);
  } finally {
    scheduler.stop();
    mock.kill();
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }

  const passed = results.filter((item) => item.ok).length;
  console.log(`\n${passed}/${results.length} 通过`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error('自检崩溃：', error);
  process.exitCode = 1;
});