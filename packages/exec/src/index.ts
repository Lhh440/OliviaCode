import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Stats } from 'node:fs';

/**
 * OliviaCode 执行层。
 *
 * 约束（M0 定死，M1 只加不改）：
 * 1. 一切路径都相对于工作区根目录解析，越界直接拒绝；
 *    围栏按 **真实路径** 判断（解析符号链接 / Windows junction），
 *    否则工作区里放一个指向外部的链接就能读写任意位置；
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

/** 单文件写入上限：超过它宁可拒绝，也不做「截断后写回」这种静默破坏。 */
export const MAX_EDIT_BYTES = 4 * 1024 * 1024;

export type Nonexistent = 'absent' | 'parent-missing' | 'error';

async function statOrNull(target: string): Promise<Stats | null> {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await fs.realpath(target);
  } catch {
    return null;
  }
}

/**
 * 解析真实路径；不存在的部分（待创建文件）保留字面量，
 * 但要求最近的已存在祖先位于根目录内。
 */
async function canonical(target: string): Promise<string> {
  const absolute = path.resolve(target);
  const direct = await realpathOrNull(absolute);
  if (direct) return direct;

  const rest: string[] = [];
  let cursor = absolute;
  while (true) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return absolute;
    rest.unshift(path.basename(cursor));
    cursor = parent;
    const real = await realpathOrNull(cursor);
    if (real) return path.join(real, ...rest);
  }
}

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 真实路径是否仍在（已解析的）根目录内。 */
async function contained(realRoot: string, target: string): Promise<boolean> {
  return inside(realRoot, await canonical(target));
}

async function assertRoot(policy: Policy): Promise<string> {
  const root = await realpathOrNull(path.resolve(policy.root));
  if (!root) throw new DeniedError(`工作区不存在：${policy.root}`);
  return root;
}

/**
 * 把相对路径解析成真实绝对路径。
 *
 * `create: true` 用于「待写入 / 待创建」，允许末级不存在；
 * 其余情况（读取、列出）要求目标已经存在。
 */
async function resolvePath(policy: Policy, rel: string, create = false): Promise<string> {
  const realRoot = await assertRoot(policy);
  const target = path.resolve(realRoot, rel || '.');
  const real = (await realpathOrNull(target)) ?? (create ? await canonical(target) : null);
  if (!real) throw new DeniedError(`路径不存在：${rel || '.'}`);
  if (!inside(realRoot, real)) {
    throw new DeniedError(`拒绝访问工作区之外的路径：${rel}`);
  }
  return real;
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
  const realRoot = await assertRoot(policy);
  const base = await resolvePath(policy, rel);
  const out: DirEntry[] = [];

  async function walk(dir: string, level: number): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      // 符号链接 / junction 若指向围栏外，一律跳过，避免泄露或顺带被改
      const real = (await realpathOrNull(full)) ?? full;
      if (!inside(realRoot, real)) continue;
      const stat = await statOrNull(full);
      if (!stat) continue;
      const relPath = path.relative(realRoot, full).split(path.sep).join('/');
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
  const target = await resolvePath(policy, rel);
  const stat = await statOrNull(target);
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
    const stale = await resolvePath(policy, rel, true);
    const stat = await statOrNull(stale);
    return Boolean(stat?.isFile());
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
      text = await fs.readFile(await resolvePath(policy, file.path), 'utf8');
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
  const target = await resolvePath(policy, rel, true);
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
  const target = await resolvePath(policy, rel);

  const stat = await statOrNull(target);
  if (!stat) throw new Error(`文件不存在：${rel}`);
  if (stat.isDirectory()) throw new Error(`${rel} 是目录，请用 read_file 确认路径`);
  // 超过上限直接拒绝：readFile 会截断，若拿着截断内容写回就是静默丢数据
  if (stat.size > MAX_EDIT_BYTES) {
    const mb = (stat.size / 1024 / 1024).toFixed(1);
    throw new Error(`文件有 ${mb}MB，超过单文件修改上限 4MB，拒绝写入以免截断丢数据`);
  }

  const before = await fs.readFile(target, 'utf8');
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
  await fs.writeFile(target, after, 'utf8');
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

/**
 * 命令不经过 shell，但进程本身仍可访问整台机器——这是已知边界（见 README「已知限制」）。
 * 这里能做的是：把工作目录钉死在围栏内、禁止 git 交互式索要凭据，避免「一条命令挂死整个回合」。
 */
function sandboxEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GCM_INTERACTIVE: 'never',
    LC_ALL: 'C.UTF-8',
    LANG: 'C.UTF-8',
  };
}

async function spawnAndCollect(
  policy: Policy,
  command: string,
  args: string[],
  options: RunOptions,
): Promise<RunResult> {
  const cwd = options.cwd ? await resolvePath(policy, options.cwd) : await assertRoot(policy);
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 120_000;

  return await new Promise<RunResult>((done) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: { ...sandboxEnv(), ...options.env },
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
  const result = await spawnAndCollect(policy, 'git', ['-c', 'credential.helper=', ...args], {
    timeoutMs: 20_000,
  });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} 失败：${(result.stderr || result.stdout).trim() || '未知错误'}`);
  }
  return result.stdout;
}

// —— 快照 ——

export interface SnapshotFile {
  path: string;
  /** 快照前的文本内容；null 表示「文件原本不存在」 */
  content: string | null;
  /** 文件在快照前是否已经存在 */
  existed?: boolean;
  /**
   * 内容是否已被完整捕获。
   * 二进制或超过 2MB 的文件会存成 false——这类快照只能标记、不能还原，
   * 绝不能拿 null 当「原本不存在」把文件删掉。
   */
  restorable?: boolean;
}

export interface Snapshot {
  id: string;
  at: number;
  taskId: string;
  files: SnapshotFile[];
  /** 已经被撤销过的快照不再参与「最近一次」 */
  undone?: boolean;
}

/** 单文件快照上限：超过它不存内容，只标记「不可还原」。 */
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export interface RestoreReport {
  /** 真正被还原或被删除的路径 */
  paths: string[];
  /** 无法还原的文件（二进制 / 过大），需要人工处理 */
  skipped: string[];
}

/**
 * 快照独立于 Git：写入前把受影响文件按原样存进应用数据目录。
 * 带 undone 标记，支持「回滚到这一步之前」并作废之后的快照。
 */
export class SnapshotStore {
  constructor(private readonly dir: string) {}

  private taskDir(taskId: string): string {
    return path.join(this.dir, taskId.replace(/[^a-zA-Z0-9_-]/g, '_'));
  }

  async create(taskId: string, policy: Policy, paths: string[]): Promise<Snapshot> {
    const files: SnapshotFile[] = [];
    for (const rel of [...new Set(paths)]) {
      const entry: SnapshotFile = { path: rel.split(path.sep).join('/'), content: null, existed: false, restorable: true };
      let absolute: string;
      try {
        absolute = await resolvePath(policy, rel, true);
      } catch {
        // 路径越界或不可解析：不记进快照，写操作后续同样会被围栏拒绝
        continue;
      }
      const stat = await statOrNull(absolute);
      if (stat?.isFile()) {
        entry.existed = true;
        if (stat.size <= MAX_SNAPSHOT_BYTES) {
          const buffer = await fs.readFile(absolute).catch(() => null);
          if (buffer && !buffer.includes(0)) {
            entry.content = buffer.toString('utf8');
          } else {
            entry.restorable = false;
          }
        } else {
          entry.restorable = false;
        }
      } else if (stat && !stat.isFile()) {
        entry.restorable = false;
      }
      files.push(entry);
    }
    const snapshot: Snapshot = {
      // 同一毫秒内多次写入也要拿到不同 id，否则后一份会覆盖前一份
      id: `snap_${Date.now().toString(36)}${randomUUID().slice(0, 4)}`,
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
    for (const name of names.filter((item) => item.endsWith('.json'))) {
      try {
        const raw = await fs.readFile(path.join(dir, name), 'utf8');
        snapshots.push(JSON.parse(raw) as Snapshot);
      } catch {
        // 损坏的快照跳过
      }
    }
    // 按时间排序，不依赖文件名字典序
    return snapshots.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
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

  /**
   * 还原快照里的文件。
   *
   * 关键：content === null 有两种含义——「原本不存在」（撤销时应删除）与
   * 「原本存在但内容没捕获到」（撤销时绝不能删）。用 existed / restorable 区分，
   * 对早期没有这两个字段的旧快照一律按「不可还原」处理，宁可少删也不误删。
   */
  async restore(snapshot: Snapshot, policy: Policy): Promise<RestoreReport> {
    const paths: string[] = [];
    const skipped: string[] = [];
    for (const file of snapshot.files) {
      let absolute: string;
      try {
        absolute = await resolvePath(policy, file.path, true);
      } catch {
        skipped.push(file.path);
        continue;
      }
      const legacy = file.existed === undefined && file.restorable === undefined;
      if (legacy) {
        // 旧快照：有内容才能还原；content 为 null 的文件不确定原来是否存在
        if (file.content === null) {
          skipped.push(file.path);
          continue;
        }
      } else if (file.existed && !file.restorable) {
        skipped.push(file.path);
        continue;
      }

      if (file.existed === false) {
        // 快照前确定不存在：撤销即删除
        await fs.rm(absolute, { force: true });
      } else if (file.content !== null) {
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.writeFile(absolute, file.content, 'utf8');
      }
      paths.push(file.path);
    }
    return { paths, skipped };
  }
}