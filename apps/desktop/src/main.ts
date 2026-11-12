import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron';
import path from 'node:path';
import type {
  ApprovalDecision,
  GitProvider,
  PatchDecision,
  TurnEnvelope,
  TurnEvent,
  TurnStartArgs,
} from '@olivia/core';
import { SnapshotStore, type Policy } from '@olivia/exec';
import { runAgentTurn } from './agent';
import {
  checkout,
  clone,
  commit,
  createBranch,
  conflicts,
  isRepo,
  parseRemote,
  pull,
  push,
  readBranches,
  readFileDiff,
  readLog,
  readStatus,
  stageHunks,
  stagePaths,
  unstagePaths,
} from './git';
import { createPullRequest } from './providers';
import { SessionStore } from './sessions';
import { checkWorkspace } from './workspace';
import * as vault from './vault';

const isDev = process.env.OLIVIA_DEV === '1';
const headless = process.env.OLIVIA_HEADLESS === '1';
const devUrl = process.env.OLIVIA_DEV_URL || 'http://127.0.0.1:5273';

let mainWindow: BrowserWindow | null = null;
let sessions: SessionStore;
let snapshots: SnapshotStore;

interface TurnContext {
  abort: AbortController;
  approvals: Map<string, (decision: ApprovalDecision) => void>;
  patches: Map<string, (decision: PatchDecision) => void>;
  taskId: string;
}

const turns = new Map<string, TurnContext>();

function readEnv(): { baseUrl: string; apiKey: string; model: string; workspace: string } {
  return {
    baseUrl: process.env.OLIVIA_BASE_URL || '',
    apiKey: process.env.OLIVIA_API_KEY || '',
    model: process.env.OLIVIA_MODEL || '',
    workspace: process.env.OLIVIA_WORKSPACE || '',
  };
}

ipcMain.on('olivia:env', (event) => {
  event.returnValue = readEnv();
});

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#fbfbfc',
    autoHideMenuBar: true,
    title: 'OliviaCode',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  mainWindow = win;

  win.once('ready-to-show', () => {
    if (!headless) win.show();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, '..', '..', 'web', 'dist', 'index.html'));
  }

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
}

// —— 工作区 ——
ipcMain.handle('olivia:workspace.pick', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择任务的工作区目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('olivia:workspace.check', async (_event, dir: string) => checkWorkspace(dir));

// —— 任务日志 ——
ipcMain.handle('olivia:task.load', async (_event, taskId: string) => {
  const events = await sessions.read(taskId);
  return { taskId, events };
});

ipcMain.handle(
  'olivia:task.undo',
  async (_event, args: { taskId: string; workspace: string; snapshotId?: string }) => {
    const check = await checkWorkspace(args.workspace);
    if (!check.ok) return { ok: false, paths: [], message: check.message, remaining: 0 };
    const policy: Policy = { mode: 'workspace-write', root: args.workspace };
    const snapshot = args.snapshotId
      ? await snapshots.get(args.taskId, args.snapshotId)
      : await snapshots.latest(args.taskId);
    if (!snapshot) {
      return { ok: false, paths: [], message: '这个任务还没有可撤销的写入', remaining: 0 };
    }
    const paths = await snapshots.restore(snapshot, policy);
    await snapshots.markUndone(args.taskId, snapshot.id);
    // 比这次更新的快照一并作废，避免回退顺序错乱
    for (const item of await snapshots.list(args.taskId)) {
      if (item.id > snapshot.id && !item.undone) {
        await snapshots.markUndone(args.taskId, item.id);
      }
    }
    const remaining = await snapshots.remaining(args.taskId);
    await sessions.append(args.taskId, { at: Date.now(), type: 'undo', snapshotId: snapshot.id });
    return { ok: true, paths, remaining };
  },
);

// —— 回合 ——
ipcMain.handle('olivia:turn.start', async (event, args: TurnStartArgs & { turnId: string }) => {
  const check = await checkWorkspace(args.workspace);
  if (!check.ok) return { ok: false, error: check.message };
  if (!readEnv().apiKey) return { ok: false, error: '还没有配置模型密钥' };

  const turnId = args.turnId;
  const sender = event.sender;
  const abort = new AbortController();
  const context: TurnContext = {
    abort,
    approvals: new Map(),
    patches: new Map(),
    taskId: args.taskId,
  };
  turns.set(turnId, context);

  const emit = (turnEvent: TurnEvent): void => {
    const envelope: TurnEnvelope = { taskId: args.taskId, turnId, event: turnEvent };
    if (!sender.isDestroyed()) sender.send('olivia:turn.event', envelope);
  };

  const policy: Policy = { mode: 'workspace-write', root: args.workspace };
  const env = readEnv();

  void (async () => {
    let ok = true;
    let failure: string | undefined;
    try {
      await runAgentTurn({
        taskId: args.taskId,
        turnId,
        prompt: args.prompt,
        history: args.history,
        model: args.model,
        baseUrl: env.baseUrl || 'https://api.deepseek.com/v1',
        apiKey: env.apiKey,
        approval: args.approval,
        allowShell: args.allowShell,
        policy,
        snapshots,
        sessions,
        emit,
        gitToken: (provider) => vault.token(provider),
        signal: abort.signal,
        requestApproval: (request) =>
          new Promise<ApprovalDecision>((resolve) => {
            const timer = setTimeout(() => {
              context.approvals.delete(request.callId);
              resolve('reject');
            }, 5 * 60_000);
            context.approvals.set(request.callId, (decision) => {
              clearTimeout(timer);
              context.approvals.delete(request.callId);
              resolve(decision);
            });
          }),
        requestPatch: (input) =>
          new Promise<PatchDecision>((resolve) => {
            const timer = setTimeout(() => {
              context.patches.delete(input.callId);
              resolve(null);
            }, 5 * 60_000);
            context.patches.set(input.callId, (decision) => {
              clearTimeout(timer);
              context.patches.delete(input.callId);
              resolve(decision);
            });
          }),
      });
    } catch (error) {
      ok = false;
      failure = error instanceof Error ? error.message : String(error);
      if (abort.signal.aborted) {
        ok = true;
        failure = undefined;
      }
    } finally {
      if (!sender.isDestroyed()) {
        sender.send('olivia:turn.event', {
          taskId: args.taskId,
          turnId,
          event: { type: 'turn.done', ok, error: failure },
        } satisfies TurnEnvelope);
      }
      context.approvals.clear();
      context.patches.clear();
      turns.delete(turnId);
    }
  })();

  return { ok: true };
});

ipcMain.on(
  'olivia:turn.approve',
  (_event, args: { turnId: string; callId: string; decision: ApprovalDecision }) => {
    turns.get(args.turnId)?.approvals.get(args.callId)?.(args.decision);
  },
);

ipcMain.on(
  'olivia:turn.patch',
  (_event, args: { turnId: string; callId: string; accepted: number[] | null }) => {
    turns.get(args.turnId)?.patches.get(args.callId)?.(args.accepted);
  },
);

ipcMain.on('olivia:turn.cancel', (_event, args: { turnId: string }) => {
  const turn = turns.get(args.turnId);
  if (!turn) return;
  turn.abort.abort();
  for (const [, resolve] of turn.approvals) resolve('reject');
  for (const [, resolve] of turn.patches) resolve(null);
  turn.approvals.clear();
  turn.patches.clear();
});

// —— 凭据 ——
ipcMain.handle('olivia:vault.status', async () => vault.status());
ipcMain.handle('olivia:vault.set', async (_event, args: { provider: GitProvider; token: string }) => {
  try {
    vault.setToken(args.provider, args.token);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
});
ipcMain.handle('olivia:vault.clear', async (_event, provider: GitProvider) => {
  vault.clearToken(provider);
  return { ok: true };
});

// —— Git ——
ipcMain.handle('olivia:git.pick-dir', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('olivia:git.state', async (_event, dir: string) => {
  if (!dir) return null;
  const repo = await isRepo(dir).catch(() => false);
  if (!repo) {
    return {
      isRepo: false,
      root: dir,
      status: {
        ok: true,
        branch: '',
        upstream: null,
        ahead: 0,
        behind: 0,
        files: [],
        remote: null,
      },
      branches: [],
      log: [],
    };
  }
  const [status, branches, log] = await Promise.all([
    readStatus(dir),
    readBranches(dir),
    readLog(dir),
  ]);
  return { isRepo: true, root: dir, status, branches, log };
});

ipcMain.handle(
  'olivia:git.diff',
  async (_event, args: { dir: string; path: string; staged: boolean }) =>
    readFileDiff(args.dir, args.path, args.staged),
);

ipcMain.handle('olivia:git.stage', async (_event, args: { dir: string; paths: string[] }) => {
  await stagePaths(args.dir, args.paths);
  return { ok: true };
});

ipcMain.handle('olivia:git.unstage', async (_event, args: { dir: string; paths: string[] }) => {
  await unstagePaths(args.dir, args.paths);
  return { ok: true };
});

ipcMain.handle(
  'olivia:git.stage-hunks',
  async (_event, args: { dir: string; path: string; indexes: number[] }) => {
    await stageHunks(args.dir, args.path, args.indexes);
    return { ok: true };
  },
);

ipcMain.handle('olivia:git.commit', async (_event, args: { dir: string; message: string }) => {
  const hash = await commit(args.dir, args.message);
  return { ok: true, hash };
});

ipcMain.handle('olivia:git.checkout', async (_event, args: { dir: string; branch: string }) => {
  await checkout(args.dir, args.branch);
  return { ok: true };
});

ipcMain.handle(
  'olivia:git.create-branch',
  async (_event, args: { dir: string; branch: string }) => {
    await createBranch(args.dir, args.branch);
    return { ok: true };
  },
);

ipcMain.handle('olivia:git.pull', async (_event, args: { dir: string }) => {
  const status = await readStatus(args.dir);
  const provider = status.remote?.provider;
  const token = provider ? vault.token(provider) : null;
  if (provider && !token) return { ok: false, message: '还没有保存该平台的令牌' };
  try {
    const output = await withAuthEnv(token && provider ? { provider, token } : null, () =>
      pull(args.dir),
    );
    return { ok: true, output, conflicts: await conflicts(args.dir) };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      conflicts: await conflicts(args.dir),
    };
  }
});

ipcMain.handle('olivia:git.push', async (_event, args: { dir: string }) => {
  const status = await readStatus(args.dir);
  const provider = status.remote?.provider;
  if (!provider) return { ok: false, message: '没有识别出远程仓库' };
  const token = vault.token(provider);
  if (!token) return { ok: false, message: `还没有保存 ${provider} 的令牌` };
  try {
    const output = await push(args.dir, { provider, token });
    return { ok: true, output };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle(
  'olivia:git.pr',
  async (_event, args: { dir: string; title: string; body: string; base: string }) => {
    const status = await readStatus(args.dir);
    if (!status.remote) return { ok: false, message: '没有识别出远程仓库' };
    const token = vault.token(status.remote.provider);
    if (!token) return { ok: false, message: `还没有保存 ${status.remote.provider} 的令牌` };
    return await createPullRequest({
      remote: status.remote,
      token,
      title: args.title,
      body: args.body,
      head: status.branch,
      base: args.base || 'main',
    });
  },
);

ipcMain.handle(
  'olivia:git.clone',
  async (_event, args: { parentDir: string; url: string; name: string }) => {
    const remote = parseRemote(args.url);
    const provider = remote?.provider ?? 'gitcode';
    const token = vault.token(provider);
    try {
      const dir = await clone(
        args.parentDir,
        args.url,
        args.name,
        token ? { provider, token } : null,
      );
      return { ok: true, dir };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },
);

/** pull 需要认证时临时注入环境，避免把令牌写进任何配置。 */
async function withAuthEnv<T>(
  auth: { provider: GitProvider; token: string } | null,
  run: () => Promise<T>,
): Promise<T> {
  const previousValue = process.env.GIT_CONFIG_VALUE_0;
  const previousCount = process.env.GIT_CONFIG_COUNT;
  if (auth?.token) {
    const user = auth.provider === 'github' ? 'x-access-token' : 'oauth2';
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
    process.env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(
      `${user}:${auth.token}`,
      'utf8',
    ).toString('base64')}`;
  }
  try {
    return await run();
  } finally {
    if (previousValue === undefined) delete process.env.GIT_CONFIG_VALUE_0;
    else process.env.GIT_CONFIG_VALUE_0 = previousValue;
    if (previousCount === undefined) delete process.env.GIT_CONFIG_COUNT;
    else process.env.GIT_CONFIG_COUNT = previousCount;
  }
}

app.whenReady().then(() => {
  sessions = new SessionStore(path.join(app.getPath('userData'), 'sessions'));
  snapshots = new SnapshotStore(path.join(app.getPath('userData'), 'snapshots'));
  nativeTheme.themeSource = 'light';
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const turn of turns.values()) turn.abort.abort();
  if (process.platform !== 'darwin') app.quit();
});
