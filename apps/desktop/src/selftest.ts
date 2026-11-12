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

  await fs.rm(workspace, { recursive: true, force: true });
  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) process.exitCode = 1;
}

void main();
