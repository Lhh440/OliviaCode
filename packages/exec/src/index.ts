import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * OliviaCode 执行层的最小骨架。
 *
 * 设计约束（M0 就定死，后面只加不改）：
 * 1. 一切路径都相对于工作区根目录解析，越界直接拒绝；
 * 2. 权限由策略决定，调用方（UI）无权绕过；
 * 3. 命令通过参数数组执行，不拼 shell 字符串，避免注入；
 * 4. 输出统一按 UTF-8 解码，Windows 下额外兜底 GBK 乱码的常见形态。
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
  const target = path.resolve(policy.root, rel);
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

export async function listDir(policy: Policy, rel = '.', depth = 2): Promise<DirEntry[]> {
  const base = resolve(policy, rel);
  const out: DirEntry[] = [];
  async function walk(dir: string, level: number): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
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
  await walk(base, depth);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export async function readFile(policy: Policy, rel: string, maxBytes = 256 * 1024): Promise<string> {
  const target = resolve(policy, rel);
  const stat = await fs.stat(target);
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

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export async function searchText(
  policy: Policy,
  needle: string,
  options: { limit?: number; include?: RegExp } = {},
): Promise<SearchHit[]> {
  const limit = options.limit ?? 200;
  const files = (await listDir(policy, '.', 6)).filter((e) => e.kind === 'file');
  const hits: SearchHit[] = [];
  for (const file of files) {
    if (options.include && !options.include.test(file.path)) continue;
    if (file.size > 512 * 1024) continue;
    let text: string;
    try {
      text = await fs.readFile(path.resolve(policy.root, file.path), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i]!.includes(needle)) {
        hits.push({ path: file.path, line: i + 1, text: lines[i]!.slice(0, 240) });
        if (hits.length >= limit) return hits;
      }
    }
  }
  return hits;
}

export async function writeFile(policy: Policy, rel: string, content: string): Promise<void> {
  assertWritable(policy);
  const target = resolve(policy, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export async function runCommand(
  policy: Policy,
  command: string,
  args: string[] = [],
  options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<RunResult> {
  assertWritable(policy);
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
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 512 * 1024) stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      done({
        code: null,
        signal: null,
        stdout,
        stderr: `${stderr}${err.message}`,
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
