import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, shell } from 'electron';
import path from 'node:path';
import type {
  ApprovalDecision,
  GitProvider,
  PatchDecision,
  RunRecord,
  ScheduleRecord,
  SchedulerEvent,
  TurnEnvelope,
  TurnEvent,
  TurnStartArgs,
  UnattendedPolicy,
  WorkflowRunArgs,
  WorkflowRunEvent,
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
import { Scheduler } from './scheduler';
import { SchedulerStore } from './scheduler-store';
import type { SyncInput } from './schedule-sync';
import { SessionStore } from './sessions';
import { checkWorkspace } from './workspace';
import * as vault from './vault';
import { runWorkflow } from './workflow-runner';

const isDev = process.env.OLIVIA_DEV === '1';
const headless = process.env.OLIVIA_HEADLESS === '1';
const devUrl = process.env.OLIVIA_DEV_URL || 'http://127.0.0.1:5273';

let mainWindow: BrowserWindow | null = null;
let sessions: SessionStore;
let snapshots: SnapshotStore;
let scheduler: Scheduler | null = null;

const reportsDir = (): string => path.join(app.getPath('userData'), 'reports');

interface TurnContext {
  abort: AbortController;
  approvals: Map<string, (decision: ApprovalDecision) => void>;
  patches: Map<string, (decision: PatchDecision) => void>;
  taskId: string;
}

const turns = new Map<string, TurnContext>();

interface WorkflowRunContext {
  abort: AbortController;
  gates: Map<string, (approved: boolean) => void>;
}

const workflowRuns = new Map<string, WorkflowRunContext>();

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

/** 渲染层的皮肤明暗同步给原生控件（select / 滚动条 / 菜单） */
ipcMain.on('olivia:theme', (_event, mode: 'light' | 'dark') => {
  nativeTheme.themeSource = mode === 'dark' ? 'dark' : 'light';
});

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#f2efe8',
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
    if (!check.ok) return { ok: false, paths: [], message: check.message, remaining: 0, skipped: [] };
    const policy: Policy = { mode: 'workspace-write', root: args.workspace };
    const snapshot = args.snapshotId
      ? await snapshots.get(args.taskId, args.snapshotId)
      : await snapshots.latest(args.taskId);
    if (!snapshot) {
      return { ok: false, paths: [], message: '这个任务还没有可撤销的写入', remaining: 0, skipped: [] };
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
    if (paths.paths.length === 0) {
      return {
        ok: false,
        paths: [],
        remaining,
        skipped: paths.skipped,
        message: paths.skipped.length
          ? `这些文件的内容没有存进快照（二进制或超过 2MB），无法还原：${paths.skipped.join('、')}`
          : '快照里没有可还原的文件',
      };
    }
    return {
      ok: true,
      paths: paths.paths,
      remaining,
      skipped: paths.skipped,
      message: paths.skipped.length
        ? `有 ${paths.skipped.length} 个文件内容未存进快照，已跳过：${paths.skipped.join('、')}`
        : undefined,
    };
  },
);

// —— 回合 ——
ipcMain.handle('olivia:turn.start', async (event, args: TurnStartArgs & { turnId: string }) => {
  const check = await checkWorkspace(args.workspace);
  if (!check.ok) return { ok: false, error: check.message };
  const env = readEnv();
  const apiKey = args.apiKey?.trim() || env.apiKey;
  const baseUrl = args.baseUrl?.trim() || env.baseUrl || 'https://api.deepseek.com/v1';
  if (!apiKey) return { ok: false, error: '还没有配置模型密钥' };

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
        baseUrl,
        apiKey,
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

// —— 工作流 ——
ipcMain.handle(
  'olivia:workflow.run',
  async (event, args: WorkflowRunArgs & { model?: string; allowShell?: boolean }) => {
    const env = readEnv();
    const apiKey = args.apiKey?.trim() || env.apiKey;
    const baseUrl = args.baseUrl?.trim() || env.baseUrl || 'https://api.deepseek.com/v1';
    if (!apiKey) return { ok: false, error: '还没有配置模型密钥，工作流没法真跑' };
    const check = await checkWorkspace(args.workspace);
    if (!check.ok) return { ok: false, error: check.message };
    if (workflowRuns.has(args.runId)) return { ok: false, error: '这次运行还在进行中' };

    const controller = new AbortController();
    const gates = new Map<string, (approved: boolean) => void>();
    workflowRuns.set(args.runId, { abort: controller, gates });
    const sender = event.sender;
    const emit = (workflowEvent: WorkflowRunEvent): void => {
      if (!sender.isDestroyed()) {
        sender.send('olivia:workflow.event', { runId: args.runId, event: workflowEvent });
      }
    };

    void runWorkflow({
      runId: args.runId,
      workflow: args.workflow,
      workspace: args.workspace,
      worktreeRoot: path.join(app.getPath('userData'), 'worktrees'),
      apiKey,
      baseUrl,
      model: args.model || env.model || 'deepseek-v4.1-flash',
      allowShell: Boolean(args.allowShell),
      maxParallel: args.maxParallel,
      snapshots,
      emit,
      signal: controller.signal,
      requestGate: (node) =>
        new Promise<boolean>((resolve) => {
          // 节点上的 timeout 是分钟；默认 30 分钟，超时按拒绝处理（并留一条日志）
          const minutes = Math.max(1, Math.min(120, Number(node.gateTimeout ?? node.timeout ?? 30)));
          const timer = setTimeout(() => {
            gates.delete(node.id);
            resolve(false);
          }, minutes * 60_000);
          gates.set(node.id, (approved) => {
            clearTimeout(timer);
            gates.delete(node.id);
            resolve(approved);
          });
        }),
    })
      .catch((error: unknown) => {
        emit({
          type: 'run.done',
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        workflowRuns.delete(args.runId);
      });

    return { ok: true };
  },
);

ipcMain.on(
  'olivia:workflow.gate',
  (_event, args: { runId: string; nodeId: string; approved: boolean }) => {
    workflowRuns.get(args.runId)?.gates.get(args.nodeId)?.(args.approved);
  },
);

ipcMain.on('olivia:workflow.cancel', (_event, args: { runId: string }) => {
  const run = workflowRuns.get(args.runId);
  if (!run) return;
  run.abort.abort();
  for (const [, resolve] of run.gates) resolve(false);
  run.gates.clear();
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

// —— 无人值守模型凭据（Key 只写不读）——
ipcMain.handle('olivia:vault.model-status', async () => vault.modelStatus());
ipcMain.handle(
  'olivia:vault.model-set',
  async (_event, args: { baseUrl: string; apiKey: string; model: string }) => {
    try {
      vault.setModelCredential(args);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },
);
ipcMain.handle('olivia:vault.model-clear', async () => {
  vault.clearModelCredential();
  return { ok: true };
});

// —— 定时任务（M5）——
ipcMain.handle('olivia:schedules.list', async (): Promise<ScheduleRecord[]> =>
  scheduler ? await scheduler.list() : [],
);
ipcMain.handle('olivia:schedules.runs', async (_event, scheduleId: string): Promise<RunRecord[]> =>
  scheduler ? await scheduler.listRuns(scheduleId) : [],
);
ipcMain.handle('olivia:schedules.recent', async (): Promise<RunRecord[]> =>
  scheduler ? await scheduler.recentRuns() : [],
);
ipcMain.handle('olivia:schedules.preview', async (_event, id: string): Promise<number[]> =>
  scheduler ? await scheduler.preview(id) : [],
);
ipcMain.handle('olivia:schedules.sync', async (_event, input: SyncInput) => {
  if (!scheduler) return { ok: false, error: '调度器还没启动' };
  const result = await scheduler.syncWorkflow(input);
  return { ok: true, ...result };
});
ipcMain.handle(
  'olivia:schedules.update',
  async (
    _event,
    args: { id: string; patch: Partial<Pick<ScheduleRecord, 'enabled' | 'mode' | 'policy'>> },
  ) => {
    if (!scheduler) return { ok: false, error: '调度器还没启动' };
    try {
      const schedule = await scheduler.update(args.id, args.patch as {
        enabled?: boolean;
        mode?: ScheduleRecord['mode'];
        policy?: UnattendedPolicy;
      });
      return schedule ? { ok: true, schedule } : { ok: false, error: '计划不存在' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
);
ipcMain.handle('olivia:schedules.run-now', async (_event, id: string) => {
  if (!scheduler) return { ok: false, error: '调度器还没启动' };
  return await scheduler.runNow(id);
});
ipcMain.on('olivia:schedules.cancel', (_event, id: string) => {
  scheduler?.cancel(id);
});
ipcMain.handle('olivia:schedules.open-report', async (_event, filePath: string) => {
  // 只允许打开报告目录内的文件，避免这条通道变成任意文件打开器
  const root = path.resolve(reportsDir());
  const target = path.resolve(filePath);
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: '报告路径不在报告目录内' };
  }
  const error = await shell.openPath(target);
  return error ? { ok: false, error } : { ok: true };
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
  try {
    // 认证走 git.ts 的进程内环境变量注入（GIT_CONFIG_*），不写任何配置文件
    const output = await pull(args.dir, provider && token ? { provider, token } : null);
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

app.whenReady().then(() => {
  sessions = new SessionStore(path.join(app.getPath('userData'), 'sessions'));
  snapshots = new SnapshotStore(path.join(app.getPath('userData'), 'snapshots'));
  nativeTheme.themeSource = 'light';

  /**
   * M5 调度器：常驻主进程，关掉窗口也照跑。
   * 凭据解析顺序：保险箱里存的（无人值守需要）→ 环境变量；都没有则预检失败。
   */
  const env = readEnv();
  scheduler = new Scheduler({
    store: new SchedulerStore(app.getPath('userData')),
    snapshots,
    worktreeRoot: path.join(app.getPath('userData'), 'worktrees'),
    reportsDir: reportsDir(),
    resolveCredentials: () => {
      const saved = vault.modelCredential();
      if (saved) return saved;
      if (env.apiKey) {
        return {
          baseUrl: env.baseUrl || 'https://api.deepseek.com/v1',
          apiKey: env.apiKey,
          model: env.model || 'deepseek-v4.1-flash',
        };
      }
      return null;
    },
    gitToken: (provider) => vault.token(provider),
    emit: (event: SchedulerEvent) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('olivia:schedules.event', event);
      }
    },
    notify: (title, body) => {
      try {
        if (Notification.isSupported()) new Notification({ title, body }).show();
      } catch {
        // 通知失败不影响调度
      }
    },
  });
  void scheduler.start().catch((error) => {
    console.error('调度器启动失败：', error);
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  scheduler?.stop();
});

app.on('window-all-closed', () => {
  for (const turn of turns.values()) turn.abort.abort();
  if (process.platform !== 'darwin') app.quit();
});
