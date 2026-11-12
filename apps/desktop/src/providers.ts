import type { GitPrResult, RemoteInfo } from '@olivia/core';

/** PR 创建：GitCode 与 GitHub 各一个实现，接口保持一致。 */

export interface PrInput {
  remote: RemoteInfo;
  token: string;
  title: string;
  body: string;
  head: string;
  base: string;
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const json = JSON.parse(text) as { message?: string; error_description?: string; error?: string };
    return json.message || json.error_description || json.error || text.slice(0, 300);
  } catch {
    return text.slice(0, 300) || `HTTP ${response.status}`;
  }
}

async function createGithub(input: PrInput): Promise<GitPrResult> {
  const response = await fetch(
    `https://api.github.com/repos/${input.remote.owner}/${input.remote.repo}/pulls`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'OliviaCode',
      },
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
      }),
    },
  );
  if (!response.ok) {
    return { ok: false, message: `GitHub：${await readError(response)}` };
  }
  const json = (await response.json()) as { html_url?: string; number?: number };
  return { ok: true, url: json.html_url };
}

async function createGitcode(input: PrInput): Promise<GitPrResult> {
  const url = `https://api.gitcode.com/api/v5/repos/${input.remote.owner}/${input.remote.repo}/pulls`;
  const response = await fetch(`${url}?access_token=${encodeURIComponent(input.token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
    }),
  });
  if (!response.ok) {
    return { ok: false, message: `GitCode：${await readError(response)}` };
  }
  const json = (await response.json().catch(() => ({}))) as { html_url?: string; number?: number };
  return {
    ok: true,
    url: json.html_url ?? `${input.remote.webUrl}/pulls`,
  };
}

export async function createPullRequest(input: PrInput): Promise<GitPrResult> {
  if (!input.title.trim()) return { ok: false, message: 'PR 标题不能为空' };
  if (!input.head.trim() || !input.base.trim()) return { ok: false, message: '缺少源分支或目标分支' };
  try {
    return input.remote.provider === 'github'
      ? await createGithub(input)
      : await createGitcode(input);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
