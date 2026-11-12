import { spawn } from 'node:child_process';
import path from 'node:path';
import type {
  GitBranch,
  GitCommit,
  GitFile,
  GitFileDiff,
  GitFileState,
  GitHunk,
  GitProvider,
  GitStatus,
  RemoteInfo,
} from '@olivia/core';

/** Git 服务：只用 CLI，参数数组，不拼 shell；认证走进程内环境变量，不写 .git/config。 */

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface GitAuth {
  provider: GitProvider;
  token: string;
}

export function authHeader(auth: GitAuth): string {
  const user = auth.provider === 'github' ? 'x-access-token' : 'oauth2';
  const pair = Buffer.from(`${user}:${auth.token}`, 'utf8').toString('base64');
  return `Authorization: Basic ${pair}`;
}

/** 把令牌从输出里抹掉，日志与报错都过这一层。 */
export function redact(text: string, token?: string | null): string {
  let out = text.replace(/(https?:\/\/)[^@\s/]+@/g, '$1***@');
  if (token && token.length >= 8) {
    out = out.split(token).join('***');
  }
  return out;
}

function gitEnv(auth?: GitAuth | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GCM_INTERACTIVE: 'never',
  };
  if (auth) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
    env.GIT_CONFIG_VALUE_0 = authHeader(auth);
  }
  return env;
}

export async function git(
  cwd: string,
  args: string[],
  options: { auth?: GitAuth | null; timeoutMs?: number } = {},
): Promise<GitResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  return await new Promise<GitResult>((resolve) => {
    const child = spawn(
      'git',
      ['-c', 'credential.helper=', '-c', 'core.quotepath=false', ...args],
      { cwd, windowsHide: true, env: gitEnv(options.auth) },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < 2 * 1024 * 1024) stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 512 * 1024) stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout,
        stderr: redact(stderr, options.auth?.token),
      });
    });
  });
}

async function mustGit(
  cwd: string,
  args: string[],
  options: { auth?: GitAuth | null; timeoutMs?: number } = {},
): Promise<string> {
  const result = await git(cwd, args, options);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim() || `git ${args[0]} 失败`;
    throw new Error(redact(detail, options.auth?.token));
  }
  return result.stdout;
}

export async function isRepo(dir: string): Promise<boolean> {
  const result = await git(dir, ['rev-parse', '--show-toplevel']);
  return result.code === 0;
}

export function parseRemote(url: string): RemoteInfo | null {
  const cleaned = url
    .trim()
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  const https = cleaned.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)$/);
  const ssh = cleaned.match(/^git@([^:]+):([^/]+)\/([^/]+)$/);
  const match = https ?? ssh;
  if (!match) return null;
  const host = match[1]!.toLowerCase();
  const owner = match[2]!;
  const repo = match[3]!;
  const provider: GitProvider = host.includes('github') ? 'github' : 'gitcode';
  return {
    provider,
    host: match[1]!,
    owner,
    repo,
    webUrl: `https://${match[1]}/${owner}/${repo}`,
  };
}

function statusFromCode(code: string): GitFileState {
  switch (code) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'renamed';
    case 'U':
      return 'conflicted';
    default:
      return 'modified';
  }
}

export async function readStatus(dir: string): Promise<GitStatus> {
  const result = await git(dir, ['status', '--porcelain=v2', '--branch', '--untracked-files=all']);
  if (result.code !== 0) {
    return {
      ok: false,
      message: result.stderr || '不是 git 仓库',
      branch: '',
      upstream: null,
      ahead: 0,
      behind: 0,
      files: [],
      remote: null,
    };
  }

  let branch = '';
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: GitFile[] = [];

  for (const line of result.stdout.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      branch = line.slice('# branch.head '.length).trim();
      if (branch === '(detached)') branch = 'HEAD (detached)';
      continue;
    }
    if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length).trim();
      continue;
    }
    if (line.startsWith('# branch.ab ')) {
      const [, plus, minus] = line.replace('# branch.ab ', '').split(' ');
      ahead = Number((plus ?? '+0').replace('+', '')) || 0;
      behind = Number((minus ?? '-0').replace('-', '')) || 0;
      continue;
    }
    if (line.startsWith('? ')) {
      files.push({ path: line.slice(2).trim(), state: 'untracked', staged: false });
      continue;
    }
    if (line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u ')) {
      const parts = line.split(' ');
      const xy = parts[1] ?? '..';
      const indexCode = xy[0] ?? '.';
      const workCode = xy[1] ?? '.';
      const rest = line.startsWith('2 ') ? parts.slice(9).join(' ') : parts.slice(8).join(' ');
      const [filePath, original] = rest.split('\t');
      const file = filePath ?? rest;
      const staged = indexCode !== '.' && indexCode !== ' ';
      const state =
        line.startsWith('u ')
          ? 'conflicted'
          : staged
            ? statusFromCode(indexCode)
            : statusFromCode(workCode);
      files.push({
        path: original ? `${file} ← ${original}` : file,
        state,
        staged,
      });
    }
  }

  const remoteUrl = await mustGit(dir, ['remote', 'get-url', 'origin'], {}).catch(() => '');
  return {
    ok: true,
    branch,
    upstream,
    ahead,
    behind,
    files,
    remote: remoteUrl ? parseRemote(remoteUrl) : null,
  };
}

export async function readBranches(dir: string): Promise<GitBranch[]> {
  const current = (await mustGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
  const output = await mustGit(dir, ['branch', '--format=%(refname:short)']).catch(() => '');
  return output
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({ name, current: name === current }));
}

export async function readLog(dir: string, limit = 20): Promise<GitCommit[]> {
  const output = await mustGit(dir, [
    'log',
    `--max-count=${limit}`,
    '--format=%H%x1f%an%x1f%at%x1f%s',
  ]).catch(() => '');
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash = '', author = '', at = '0', subject = ''] = line.split('\x1f');
      return {
        hash,
        short: hash.slice(0, 7),
        author,
        at: Number(at) * 1000,
        subject,
      };
    });
}

/** 解析一个文件的 diff，按 hunk 切开，供逐 hunk 暂存。 */
export async function readFileDiff(
  dir: string,
  filePath: string,
  staged: boolean,
): Promise<GitFileDiff> {
  const args = staged
    ? ['diff', '--cached', '--no-color', '--', filePath]
    : ['diff', '--no-color', '--', filePath];
  const raw = await mustGit(dir, args).catch(() => '');
  if (!raw.trim()) {
    return { path: filePath, header: '', hunks: [], binary: false, empty: true };
  }
  const lines = raw.split('\n');
  const headerLines: string[] = [];
  const hunks: GitHunk[] = [];
  let current: { header: string; body: string[] } | null = null;
  let binary = false;

  for (const line of lines) {
    if (line.startsWith('Binary files')) binary = true;
    if (line.startsWith('@@')) {
      if (current) hunks.push({ index: hunks.length, header: current.header, body: current.body.join('\n') });
      current = { header: line, body: [] };
      continue;
    }
    if (current) current.body.push(line);
    else headerLines.push(line);
  }
  if (current) hunks.push({ index: hunks.length, header: current.header, body: current.body.join('\n') });

  return { path: filePath, header: headerLines.join('\n'), hunks, binary, empty: false };
}

function buildPatch(diff: GitFileDiff, indexes: number[]): string {
  const chosen = diff.hunks.filter((hunk) => indexes.includes(hunk.index));
  const body = chosen.map((hunk) => `${hunk.header}\n${hunk.body}`).join('\n');
  return `${diff.header}\n${body}\n`;
}

/** 用原始 diff 拼一个只含选中 hunk 的补丁，再 git apply --cached。 */
export async function stageHunks(
  dir: string,
  filePath: string,
  indexes: number[],
): Promise<void> {
  const diff = await readFileDiff(dir, filePath, false);
  if (diff.empty) {
    // 未跟踪文件：整文件暂存
    await mustGit(dir, ['add', '--', filePath]);
    return;
  }
  const patch = buildPatch(diff, indexes);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'git',
      ['-c', 'credential.helper=', 'apply', '--cached', '--whitespace=nowarn', '-'],
      { cwd: dir, windowsHide: true, env: gitEnv() },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(redact(stderr || 'git apply 失败')));
    });
    child.stdin.write(patch);
    child.stdin.end();
  });
}

export async function stagePaths(dir: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await mustGit(dir, ['add', '--', ...paths]);
}

export async function unstagePaths(dir: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await mustGit(dir, ['restore', '--staged', '--', ...paths]);
}

export async function commit(dir: string, message: string): Promise<string> {
  if (!message.trim()) throw new Error('提交信息不能为空');
  const staged = await git(dir, ['diff', '--cached', '--name-only']);
  if (!staged.stdout.trim()) throw new Error('暂存区是空的，先选择要提交的改动');
  await mustGit(dir, ['commit', '-m', message]);
  return (await mustGit(dir, ['rev-parse', '--short', 'HEAD'])).trim();
}

export async function checkout(dir: string, branch: string): Promise<void> {
  await mustGit(dir, ['checkout', branch]);
}

export async function createBranch(dir: string, branch: string): Promise<void> {
  if (!branch.trim()) throw new Error('分支名不能为空');
  await mustGit(dir, ['checkout', '-b', branch]);
}

export async function pull(dir: string): Promise<string> {
  return await mustGit(dir, ['pull', '--ff-only'], { timeoutMs: 120_000 });
}

export async function push(dir: string, auth: GitAuth | null): Promise<string> {
  return await mustGit(dir, ['push', 'origin', 'HEAD'], { auth, timeoutMs: 120_000 });
}

export async function clone(
  parentDir: string,
  url: string,
  targetName: string,
  auth: GitAuth | null,
): Promise<string> {
  const target = path.join(parentDir, targetName);
  await mustGit(parentDir, ['clone', url, target], { auth, timeoutMs: 300_000 });
  return target;
}

/** 冲突文件清单（合并/拉取后） */
export async function conflicts(dir: string): Promise<string[]> {
  const output = await mustGit(dir, ['diff', '--name-only', '--diff-filter=U']).catch(() => '');
  return output.split('\n').filter(Boolean);
}
