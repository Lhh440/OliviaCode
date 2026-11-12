/**
 * M1 自检：不经过界面，直接用主进程同一套 agent 跑三条验收场景。
 * 用法：node apps/desktop/dist/selftest.cjs
 * 需要 OLIVIA_BASE_URL / OLIVIA_API_KEY / OLIVIA_MODEL。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionEvent, TurnEvent } from '@olivia/core';
import { SnapshotStore, type Policy } from '@olivia/exec';
import { runAgentTurn } from './agent';
import {
  commit,
  git,
  push,
  readBranches,
  readFileDiff,
  readStatus,
  stageHunks,
  stagePaths,
} from './git';
import { SessionStore } from './sessions';

const baseUrl = process.env.OLIVIA_BASE_URL || '';
const apiKey = process.env.OLIVIA_API_KEY || '';
const model = process.env.OLIVIA_MODEL || 'deepseek-v4.1-flash';

if (!apiKey) {
  console.error('缺少 OLIVIA_API_KEY');
  process.exit(2);
}

const results: { name: string; ok: boolean; detail: string }[] = [];
let workspace = '';

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}

async function turn(prompt: string, approval: 'ask' | 'auto' | 'never' = 'auto'): Promise<{
  text: string;
  tools: string[];
  error?: string;
}> {
  const policy: Policy = { mode: 'workspace-write', root: workspace };
  const sessions = new SessionStore(path.join(workspace, '.olivia-e2e', 'sessions'));
  const snapshots = new SnapshotStore(path.join(workspace, '.olivia-e2e', 'snapshots'));
  const tools: string[] = [];
  let text = '';
  let error: string | undefined;

  await runAgentTurn({
    taskId: 'e2e',
    turnId: `e2e_${Date.now().toString(36)}`,
    prompt,
    history: [],
    model,
    baseUrl,
    apiKey,
    approval,
    allowShell: true,
    policy,
    snapshots,
    sessions,
    signal: new AbortController().signal,
    emit: (event: TurnEvent) => {
      if (event.type === 'text') text += event.delta;
      if (event.type === 'tool.request') tools.push(event.call.name);
    },
    requestApproval: async () => 'once',
    requestPatch: async (input) => input.edits.map((edit) => edit.index),
    gitToken: () => null,
  }).catch((cause: unknown) => {
    error = cause instanceof Error ? cause.message : String(cause);
  });

  return { text, tools, error };
}

async function main(): Promise<void> {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'olivia-e2e-'));
  await fs.writeFile(
    path.join(workspace, 'README.md'),
    '# Demo Repo\n\n这是用来验证 OliviaCode 的示例仓库。\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(workspace, 'package.json'),
    JSON.stringify({ name: 'demo-repo', scripts: { test: 'node -e "console.log(1)"' } }, null, 2),
    'utf8',
  );
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'src', 'app.ts'), 'export const answer = 42;\n', 'utf8');
  console.log(`workspace: ${workspace}\n`);

  // A1：读路径
  const read = await turn('README.md 的一级标题是什么？调用 read_file 确认，只回答标题本身。', 'auto');
  record(
    'A1 读路径',
    read.tools.includes('read_file') && read.text.includes('Demo Repo'),
    `tools=${read.tools.join(',') || '无'} text=${JSON.stringify(read.text.slice(0, 40))}${read.error ? ` err=${read.error}` : ''}`,
  );

  // A2：写路径
  const before = await fs.readFile(path.join(workspace, 'README.md'), 'utf8');
  const write = await turn(
    '把 README.md 的第一行标题改成「# OliviaCode 测试仓库」，只改这一行，用 apply_patch。',
    'auto',
  );
  const after = await fs.readFile(path.join(workspace, 'README.md'), 'utf8');
  record(
    'A2 写路径',
    after !== before && after.startsWith('# OliviaCode 测试仓库'),
    `tools=${write.tools.join(',') || '无'}${write.error ? ` err=${write.error}` : ''}`,
  );

  // 撤销
  const snapshots = new SnapshotStore(path.join(workspace, '.olivia-e2e', 'snapshots'));
  const latest = await snapshots.latest('e2e');
  if (latest) {
    await snapshots.restore(latest, { mode: 'workspace-write', root: workspace });
  }
  const restored = await fs.readFile(path.join(workspace, 'README.md'), 'utf8');
  record('A2b 撤销', Boolean(latest) && restored === before, `restored=${restored.startsWith('# Demo Repo')}`);

  // A3：执行命令
  const run = await turn('跑一下 node --version，告诉我版本号。', 'auto');
  record(
    'A3 命令执行',
    run.tools.includes('run_command') && /v\d+\./.test(run.text),
    `tools=${run.tools.join(',') || '无'} text=${JSON.stringify(run.text.slice(0, 60))}${run.error ? ` err=${run.error}` : ''}`,
  );

  // A4：事件日志
  const sessions = new SessionStore(path.join(workspace, '.olivia-e2e', 'sessions'));
  const events: SessionEvent[] = await sessions.read('e2e');
  const kinds = new Set(events.map((event) => event.type));
  record(
    'A4 事件日志',
    kinds.has('user.message') &&
      kinds.has('assistant.message') &&
      kinds.has('tool.call') &&
      kinds.has('snapshot'),
    `events=${events.length} kinds=${[...kinds].join(',')}`,
  );

  // A5：多步撤销（直接打快照层，不依赖模型）
  const multiStore = new SnapshotStore(path.join(workspace, '.olivia-e2e', 'multi'));
  const multiPolicy: Policy = { mode: 'workspace-write', root: workspace };
  const target = path.join(workspace, 'multi.txt');
  await fs.writeFile(target, 'v0\n', 'utf8');
  const snap1 = await multiStore.create('multi', multiPolicy, ['multi.txt']);
  await fs.writeFile(target, 'v1\n', 'utf8');
  const snap2 = await multiStore.create('multi', multiPolicy, ['multi.txt']);
  await fs.writeFile(target, 'v2\n', 'utf8');

  const newest = await multiStore.latest('multi');
  if (newest) await multiStore.restore(newest, multiPolicy);
  await multiStore.markUndone('multi', snap2.id);
  const v1 = await fs.readFile(target, 'utf8');

  const older = await multiStore.latest('multi');
  if (older) await multiStore.restore(older, multiPolicy);
  await multiStore.markUndone('multi', snap1.id);
  const v0 = await fs.readFile(target, 'utf8');
  record(
    'A5 多步撤销',
    v1.startsWith('v1') && v0.startsWith('v0'),
    `after1=${v1.trim()} after2=${v0.trim()} remaining=${await multiStore.remaining('multi')}`,
  );

  // A6：本地 git 闭环（init → 提交 → 逐 hunk 暂存 → 推到裸仓库）
  const repoDir = path.join(workspace, 'demo-repo');
  await fs.mkdir(repoDir, { recursive: true });
  await git(repoDir, ['init', '-b', 'main']);
  await git(repoDir, ['config', 'user.name', 'Olivia E2E']);
  await git(repoDir, ['config', 'user.email', 'e2e@olivia.local']);
  await fs.writeFile(path.join(repoDir, 'notes.md'), 'alpha\n\n\n\n\nbeta\n', 'utf8');
  await git(repoDir, ['add', '-A']);
  await git(repoDir, ['commit', '-m', 'init']);

  await fs.writeFile(path.join(repoDir, 'notes.md'), 'alpha changed\n\n\n\n\nbeta\n', 'utf8');
  await fs.writeFile(path.join(repoDir, 'other.txt'), 'new file\n', 'utf8');
  const statusBefore = await readStatus(repoDir);
  const fileDiff = await readFileDiff(repoDir, 'notes.md', false);
  let hunkStageOk = false;
  if (fileDiff.hunks.length > 0) {
    await stageHunks(repoDir, 'notes.md', [0]);
    const staged = await git(repoDir, ['diff', '--cached', '--name-only']);
    hunkStageOk = staged.stdout.includes('notes.md');
  }
  await stagePaths(repoDir, ['other.txt']);
  const hash = await commit(repoDir, 'change notes + other');
  const branches = await readBranches(repoDir);
  const bare = path.join(workspace, 'bare.git');
  await git(workspace, ['init', '--bare', bare]);
  await git(repoDir, ['remote', 'add', 'origin', bare]);
  const pushOutput = await push(repoDir, null).catch((error: unknown) =>
    error instanceof Error ? error.message : String(error),
  );
  record(
    'A6 本地 git 闭环',
    hunkStageOk &&
      Boolean(hash) &&
      branches.some((branch) => branch.name === 'main' && branch.current) &&
      statusBefore.files.length > 0 &&
      typeof pushOutput === 'string',
    `hunks=${fileDiff.hunks.length} staged=${hunkStageOk} commit=${hash} branches=${branches.length} push=${String(pushOutput).slice(0, 24)}`,
  );

  await fs.rm(workspace, { recursive: true, force: true });
  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) process.exitCode = 1;
}

void main();
