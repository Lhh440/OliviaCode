import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * OliviaCode 执行层。
 *
 * 约束（M0 定死，M1 只加不改）：
 * 1. 一切路径都相对于工作区根目录解析，越界直接拒绝；
 * 2. 权限由策略决定，调用方（UI / 模型）无权绕过；
 * 3. 命令通过参数数组执行，不拼 shell 字符串；
 * 4. 写入前由上层快照，执行层只负责「安全地改」。
 */
export type PermissionMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface Policy {
  mode: PermissionMode;
  root: string;
}

export class DeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeniedError';
  }
}

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolve(policy: Policy, rel: string): string {
  const target = path.resolve(policy.root, rel || '.');
  if (!inside(policy.root, target)) {
    throw new DeniedError(`拒绝访问工作区之外的路径：${rel}`);
  }
  return target;
}

function assertWritable(policy: Policy): void {
  if (policy.mode === 'read-only') {
    throw new DeniedError('当前是只读模式，写入被拒绝');
  }
}

export interface DirEntry {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  size: number;
}

const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', '__pycache__']);

export async function listDir(policy: Policy, rel = '.', depth = 2): Promise<DirEntry[]> {
  const base = resolve(policy, rel);
  const out: DirEntry[] = [];
  async function walk(dir: string, level: number): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const relPath = path.relative(policy.root, full).split(path.sep).join('/');
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) continue;
      out.push({
        name: entry.name,
        path: relPath,
        kind: entry.isDirectory() ? 'dir' : 'file',
        size: stat.size,
      });
      if (entry.isDirectory() && level > 1) await walk(full, level - 1);
      if (out.length > 4000) return;
    }
  }
  await walk(base, Math.max(1, Math.min(4, depth)));
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export async function readFile(policy: Policy, rel: string, maxBytes = 256 * 1024): Promise<string> {
  const target = resolve(policy, rel);
  const stat = await fs.stat(target).catch(() => null);
  if (!stat) throw new Error(`文件不存在：${rel}`);
  if (stat.isDirectory()) throw new Error(`${rel} 是目录，请用 list_dir`);
  if (stat.size > maxBytes) {
    const handle = await fs.open(target, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      await handle.read(buf, 0, maxBytes, 0);
      return `${buf.toString('utf8')}\n…（已截断，文件共 ${stat.size} 字节）`;
    } finally {
      await handle.close();
    }
  }
  return fs.readFile(target, 'utf8');
}

export async function fileExists(policy: Policy, rel: string): Promise<boolean> {
  try {
    const stat = await fs.stat(resolve(policy, rel));
    return stat.isFile();
  } catch {
    return false;
  }
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export async function searchText(
  policy: Policy,
  needle: string,
  options: { limit?: number; include?: string } = {},
): Promise<SearchHit[]> {
  if (!needle.trim()) throw new Error('搜索词不能为空');
  const limit = options.limit ?? 200;
  const include = options.include?.trim();
  const files = (await listDir(policy, '.', 6)).filter((entry) => entry.kind === 'file');
  const hits: SearchHit[] = [];
  for (const file of files) {
    if (include && !file.path.endsWith(include)) continue;
    if (file.size > 512 * 1024) continue;
    let text: string;
    try {
      text = await fs.readFile(path.resolve(policy.root, file.path), 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index]!.includes(needle)) {
        hits.push({ path: file.path, line: index + 1, text: lines[index]!.slice(0, 240) });
        if (hits.length >= limit) return hits;
      }
    }
  }
  return hits;
}

export async function writeText(policy: Policy, rel: string, content: string): Promise<void> {
  assertWritable(policy);
  const target = resolve(policy, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

export interface PatchEdit {
  old: string;
  new: string;
}

export interface PatchResult {
  before: string;
  after: string;
}

/**
 * 严格替换：old 必须在文件中唯一出现。
 * 不匹配就报错让模型重读，绝不模糊套用。
 */
export async function applyEdits(policy: Policy, rel: string, edits: PatchEdit[]): Promise<PatchResult> {
  assertWritable(policy);
  if (!Array.isArray(edits) || edits.length === 0) throw new Error('edits 不能为空');
  const before = await readFile(policy, rel, 4 * 1024 * 1024);
  let after = before;
  for (const [index, edit] of edits.entries()) {
    const old = String(edit?.old ?? '');
    const replacement = String(edit?.new ?? '');
    if (!old.trim()) throw new Error(`第 ${index + 1} 条修改的 old 为空`);
    const occurrences = after.split(old).length - 1;
    if (occurrences === 0) {
      throw new Error(`第 ${index + 1} 条修改找不到原文，请先 read_file 确认内容与缩进完全一致`);
    }
    if (occurrences > 1) {
      throw new Error(`第 ${index + 1} 条修改的原文出现了 ${occurrences} 次，请补足上下文让它唯一`);
    }
    after = after.replace(old, replacement);
  }
  if (after === before) throw new Error('修改前后内容一致，没有产生变化');
  await writeText(policy, rel, after);
  return { before, after };
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

export async function runCommand(
  policy: Policy,
  command: string,
  args: string[] = [],
  options: RunOptions = {},
): Promise<RunResult> {
  assertWritable(policy);
  return spawnAndCollect(policy, command, args, options);
}

async function spawnAndCollect(
  policy: Policy,
  command: string,
  args: string[],
  options: RunOptions,
): Promise<RunResult> {
  const cwd = options.cwd ? resolve(policy, options.cwd) : policy.root;
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 120_000;

  return await new Promise<RunResult>((done) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, ...options.env, LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < 512 * 1024) stdout += chunk;
      options.onOutput?.(chunk, 'stdout');
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 256 * 1024) stderr += chunk;
      options.onOutput?.(chunk, 'stderr');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      done({
        code: null,
        signal: null,
        stdout,
        stderr: `${stderr}${error.message}`,
        durationMs: Date.now() - started,
        timedOut,
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      done({ code, signal, stdout, stderr, durationMs: Date.now() - started, timedOut });
    });
  });
}

/** git 只读查询：只读模式也允许。 */
export async function gitQuery(policy: Policy, args: string[]): Promise<string> {
  const result = await spawnAndCollect(policy, 'git', args, { timeoutMs: 20_000 });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} 失败：${(result.stderr || result.stdout).trim() || '未知错误'}`);
  }
  return result.stdout;
}

// —— 快照 ——

export interface SnapshotFile {
  path: string;
  /** null 表示这个文件在快照前不存在 */
  content: string | null;
}

export interface Snapshot {
  id: string;
  at: number;
  taskId: string;
  files: SnapshotFile[];
  /** 已经被撤销过的快照不再参与「最近一次」 */
  undone?: boolean;
}

/**
 * 快照独立于 Git：写入前把受影响文件按原样存进应用数据目录。
 * M1 只支持「撤销最近一次」，多步回滚留给 M2。
 */
export class SnapshotStore {
  constructor(private readonly dir: string) {}

  private taskDir(taskId: string): string {
    return path.join(this.dir, taskId.replace(/[^a-zA-Z0-9_-]/g, '_'));
  }

  async create(taskId: string, policy: Policy, paths: string[]): Promise<Snapshot> {
    const files: SnapshotFile[] = [];
    for (const rel of [...new Set(paths)]) {
      const absolute = path.resolve(policy.root, rel);
      if (!inside(policy.root, absolute)) continue;
      let content: string | null = null;
      try {
        const stat = await fs.stat(absolute);
        if (stat.isFile() && stat.size <= 2 * 1024 * 1024) {
          const buffer = await fs.readFile(absolute);
          content = buffer.includes(0) ? null : buffer.toString('utf8');
        }
      } catch {
        content = null;
      }
      files.push({ path: rel.split(path.sep).join('/'), content });
    }
    const snapshot: Snapshot = {
      id: `snap_${Date.now().toString(36)}`,
      at: Date.now(),
      taskId,
      files,
    };
    await fs.mkdir(this.taskDir(taskId), { recursive: true });
    await fs.writeFile(
      path.join(this.taskDir(taskId), `${snapshot.id}.json`),
      JSON.stringify(snapshot),
      'utf8',
    );
    return snapshot;
  }

  async list(taskId: string): Promise<Snapshot[]> {
    const dir = this.taskDir(taskId);
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    const snapshots: Snapshot[] = [];
    for (const name of names.filter((item) => item.endsWith('.json')).sort()) {
      try {
        const raw = await fs.readFile(path.join(dir, name), 'utf8');
        snapshots.push(JSON.parse(raw) as Snapshot);
      } catch {
        // 损坏的快照跳过
      }
    }
    return snapshots;
  }

  async get(taskId: string, id: string): Promise<Snapshot | null> {
    const snapshots = await this.list(taskId);
    return snapshots.find((snapshot) => snapshot.id === id) ?? null;
  }

  /** 最近一次「还没被撤销」的快照 */
  async latest(taskId: string): Promise<Snapshot | null> {
    const snapshots = (await this.list(taskId)).filter((snapshot) => !snapshot.undone);
    return snapshots[snapshots.length - 1] ?? null;
  }

  /** 还能回退几步 */
  async remaining(taskId: string): Promise<number> {
    return (await this.list(taskId)).filter((snapshot) => !snapshot.undone).length;
  }

  async markUndone(taskId: string, id: string): Promise<void> {
    const snapshot = await this.get(taskId, id);
    if (!snapshot) return;
    const next: Snapshot = { ...snapshot, undone: true };
    await fs.writeFile(
      path.join(this.taskDir(taskId), `${snapshot.id}.json`),
      JSON.stringify(next),
      'utf8',
    );
  }

  /** 还原快照里的文件，返回被恢复的路径。 */
  async restore(snapshot: Snapshot, policy: Policy): Promise<string[]> {
    const restored: string[] = [];
    for (const file of snapshot.files) {
      const absolute = path.resolve(policy.root, file.path);
      if (!inside(policy.root, absolute)) continue;
      if (file.content === null) {
        await fs.rm(absolute, { force: true });
      } else {
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.writeFile(absolute, file.content, 'utf8');
      }
      restored.push(file.path);
    }
    return restored;
  }
}
