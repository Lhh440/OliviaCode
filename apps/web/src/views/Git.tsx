import { useCallback, useEffect, useState } from 'react';
import type { GitFileDiff, GitRepoState } from '@olivia/core';
import { Icon } from '../icons';
import { useStore } from '../store';

function basename(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

function realPath(path: string): string {
  return path.split(' ← ')[0] ?? path;
}

const STATE_LABEL: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
  conflicted: 'U',
};

export function GitView() {
  const { state, dispatch } = useStore();
  const task = state.tasks.find((item) => item.id === state.activeId) ?? null;
  const workspace = task?.workspace ?? '';

  const [repo, setRepo] = useState<GitRepoState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [openFile, setOpenFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<GitFileDiff | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [commitMessage, setCommitMessage] = useState('');
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');
  const [prBase, setPrBase] = useState('main');
  const [prUrl, setPrUrl] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const api = window.olivia;
    if (!api?.git || !workspace) {
      setRepo(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const next = await api.git.state(workspace).catch(() => null);
    setRepo(next);
    setLoading(false);
  }, [workspace]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const bindExisting = async (): Promise<void> => {
    const api = window.olivia;
    if (!api) return;
    const dir = await api.git.pickDir();
    if (!dir) return;
    if (task) dispatch({ type: 'patchTask', taskId: task.id, patch: { workspace: dir } });
  };

  const cloneRepo = async (): Promise<void> => {
    const api = window.olivia;
    if (!api || !task) return;
    const url = window.prompt('远程仓库地址（HTTPS）', 'https://github.com/');
    if (!url) return;
    const parent = await api.git.pickDir();
    if (!parent) return;
    const name = window.prompt('目标目录名', url.replace(/\.git$/, '').split('/').pop() ?? 'repo');
    if (!name) return;
    await run(async () => {
      const result = await api.git.clone({ parentDir: parent, url, name });
      if (!result.ok || !result.dir) throw new Error(result.message ?? '克隆失败');
      dispatch({ type: 'patchTask', taskId: task.id, patch: { workspace: result.dir } });
    });
  };

  const openDiff = async (path: string, staged: boolean): Promise<void> => {
    const api = window.olivia;
    if (!api?.git) return;
    const key = `${staged ? 's' : 'w'}:${path}`;
    if (openFile === key) {
      setOpenFile(null);
      setDiff(null);
      return;
    }
    const next = await api.git.diff({ dir: workspace, path, staged });
    setOpenFile(key);
    setDiff(next);
    setPicked(next.hunks.map((hunk) => hunk.index));
  };

  const toggleHunk = (index: number): void => {
    setPicked((current) =>
      current.includes(index) ? current.filter((item) => item !== index) : [...current, index].sort((a, b) => a - b),
    );
  };

  const stageSelected = async (path: string): Promise<void> => {
    const api = window.olivia;
    if (!api?.git) return;
    await run(async () => {
      if (picked.length === 0) throw new Error('至少勾选一段改动');
      if (picked.length === (diff?.hunks.length ?? 0)) {
        await api.git.stage(workspace, [path]);
      } else {
        await api.git.stageHunks(workspace, path, picked);
      }
      setOpenFile(null);
      setDiff(null);
    });
  };

  if (!workspace) {
    return (
      <div className="git-page">
        <header className="page-head">
          <h1>Git</h1>
          <p>给当前任务绑定一个仓库，才能看到改动、提交与推送。</p>
        </header>
        <div className="git-empty">
          <div className="git-empty-mark">
            <Icon name="git" size={22} />
          </div>
          <h2>还没有绑定仓库</h2>
          <p>两种方式都支持：用已有的本地仓库，或从远程克隆一份。</p>
          <div className="git-empty-actions">
            <button className="btn" onClick={() => void bindExisting()}>
              <Icon name="folder" size={14} />
              选择已有仓库
            </button>
            <button className="btn primary" onClick={() => void cloneRepo()}>
              <Icon name="download" size={14} />
              克隆远程仓库
            </button>
          </div>
        </div>
      </div>
    );
  }

  const status = repo?.status;
  const changes = status?.files ?? [];

  return (
    <div className="git-page">
      <header className="chat-head">
        <div className="chat-head-left">
          <h1>Git · {basename(workspace)}</h1>
          {status?.remote ? (
            <span className="chip static">
              {status.remote.provider === 'github' ? 'GitHub' : 'GitCode'} · {status.remote.owner}/
              {status.remote.repo}
            </span>
          ) : (
            <span className="chip static">无远程</span>
          )}
          {status && status.ahead + status.behind > 0 && (
            <span className="chip static">
              ↑{status.ahead} ↓{status.behind}
            </span>
          )}
        </div>
        <div className="chat-head-right">
          {repo?.branches && repo.branches.length > 0 && (
            <select
              className="chip select"
              value={status?.branch ?? ''}
              disabled={busy}
              onChange={(event) => {
                const branch = event.target.value;
                void run(async () => {
                  await window.olivia?.git.checkout(workspace, branch);
                });
              }}
            >
              {repo.branches.map((branch) => (
                <option key={branch.name} value={branch.name}>
                  {branch.name}
                </option>
              ))}
            </select>
          )}
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await window.olivia?.git.pull(workspace);
                if (!result?.ok) throw new Error(result?.message ?? '拉取失败');
                setNotice(result.conflicts?.length ? `有冲突：${result.conflicts.join('、')}` : '已拉取');
              })
            }
          >
            拉取
          </button>
          <button
            className="btn primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await window.olivia?.git.push(workspace);
                if (!result?.ok) throw new Error(result?.message ?? '推送失败');
                setNotice('已推送');
              })
            }
          >
            推送
          </button>
        </div>
      </header>

      <div className="git-scroll">
        {notice && (
          <div className="run-strip" style={{ marginBottom: 12 }}>
            <Icon name="alert" size={14} />
            <span>{notice}</span>
            <button className="link-btn" onClick={() => setNotice(null)}>
              知道了
            </button>
          </div>
        )}

        {loading && !repo ? (
          <div className="git-empty">
            <span className="spinner" />
            <p>正在读取仓库状态…</p>
          </div>
        ) : !repo?.isRepo ? (
          <div className="git-empty">
            <h2>这个目录还不是 git 仓库</h2>
            <p>换一个目录，或在终端里先 git init。</p>
            <button className="btn" onClick={() => void bindExisting()}>
              换一个目录
            </button>
          </div>
        ) : (
          <>
            <section className="git-card">
              <div className="git-card-head">
                <h2>改动</h2>
                <span className="muted">{changes.length} 个文件</span>
              </div>
              {changes.length === 0 && <div className="git-hint">工作区是干净的。</div>}
              {changes.map((file) => {
                const path = realPath(file.path);
                const key = `${file.staged ? 's' : 'w'}:${path}`;
                return (
                  <div className="git-file" key={key}>
                    <button className="git-file-row" onClick={() => void openDiff(path, file.staged)}>
                      <span className={`git-flag state-${file.state}`}>{STATE_LABEL[file.state] ?? 'M'}</span>
                      <span className="git-path">{file.path}</span>
                      <span className="git-file-state">{file.staged ? '已暂存' : '未暂存'}</span>
                      <Icon name={openFile === key ? 'chevron' : 'chevronRight'} size={13} />
                    </button>
                    {openFile === key && diff && !diff.empty && (
                      <div className="git-hunks">
                        {diff.hunks.map((hunk) => (
                          <label className="git-hunk" key={hunk.index}>
                            <div className="git-hunk-head">
                              <input
                                type="checkbox"
                                checked={picked.includes(hunk.index)}
                                onChange={() => toggleHunk(hunk.index)}
                              />
                              <span>{hunk.header}</span>
                            </div>
                            <pre>{hunk.body}</pre>
                          </label>
                        ))}
                        <div className="git-hunk-actions">
                          {file.staged ? (
                            <button
                              className="btn ghost"
                              onClick={() =>
                                void run(async () => {
                                  await window.olivia?.git.unstage(workspace, [path]);
                                })
                              }
                            >
                              取消暂存
                            </button>
                          ) : (
                            <button
                              className="btn primary"
                              disabled={busy || picked.length === 0}
                              onClick={() => void stageSelected(path)}
                            >
                              暂存选中（{picked.length}）
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </section>

            <section className="git-card">
              <div className="git-card-head">
                <h2>提交</h2>
                <span className="muted">只提交已暂存的改动</span>
              </div>
              <textarea
                className="input textarea"
                rows={3}
                placeholder="改了什么、为什么"
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
              />
              <div className="git-actions">
                <button
                  className="btn ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const unstaged = changes.filter((file) => !file.staged).map((file) => realPath(file.path));
                      if (unstaged.length === 0) throw new Error('没有未暂存的改动');
                      await window.olivia?.git.stage(workspace, unstaged);
                    })
                  }
                >
                  全部暂存
                </button>
                <button
                  className="btn primary"
                  disabled={busy || !commitMessage.trim()}
                  onClick={() =>
                    void run(async () => {
                      const result = await window.olivia?.git.commit(workspace, commitMessage);
                      setCommitMessage('');
                      setNotice(`已提交 ${result?.hash ?? ''}`);
                    })
                  }
                >
                  提交
                </button>
              </div>
            </section>

            <section className="git-card">
              <div className="git-card-head">
                <h2>Pull Request</h2>
                <span className="muted">草稿先自己过一遍，再创建</span>
              </div>
              <input
                className="input"
                placeholder="标题"
                value={prTitle}
                onChange={(event) => setPrTitle(event.target.value)}
              />
              <textarea
                className="input textarea"
                rows={4}
                placeholder="描述（Markdown）"
                value={prBody}
                onChange={(event) => setPrBody(event.target.value)}
              />
              <div className="git-pr-row">
                <label className="git-inline">
                  <span>目标分支</span>
                  <input
                    className="input"
                    value={prBase}
                    onChange={(event) => setPrBase(event.target.value)}
                  />
                </label>
                <button
                  className="btn primary"
                  disabled={busy || !prTitle.trim()}
                  onClick={() =>
                    void run(async () => {
                      const result = await window.olivia?.git.pr({
                        dir: workspace,
                        title: prTitle,
                        body: prBody,
                        base: prBase,
                      });
                      if (!result?.ok) throw new Error(result?.message ?? '创建失败');
                      setPrUrl(result.url ?? null);
                      setNotice('PR 已创建');
                    })
                  }
                >
                  创建 PR
                </button>
              </div>
              {prUrl && (
                <a className="git-pr-link" href={prUrl} target="_blank" rel="noreferrer">
                  {prUrl}
                </a>
              )}
            </section>

            <section className="git-card">
              <div className="git-card-head">
                <h2>最近提交</h2>
              </div>
              <div className="git-log">
                {(repo.log ?? []).map((entry) => (
                  <div className="git-log-row" key={entry.hash}>
                    <span className="git-hash">{entry.short}</span>
                    <span className="git-subject">{entry.subject}</span>
                    <span className="git-author">{entry.author}</span>
                  </div>
                ))}
                {(repo.log ?? []).length === 0 && <div className="git-hint">还没有提交。</div>}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
