import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron';
import path from 'node:path';
import type {
  ApprovalDecision,
  TurnEvent,
  TurnEnvelope,
  TurnStartArgs,
} from '@olivia/core';
import { SnapshotStore, type Policy } from '@olivia/exec';
import { runAgentTurn } from './agent';
import { SessionStore } from './sessions';
import { checkWorkspace } from './workspace';

const isDev = process.env.OLIVIA_DEV === '1';
const headless = process.env.OLIVIA_HEADLESS === '1';
const devUrl = process.env.OLIVIA_DEV_URL || 'http://127.0.0.1:5273';

let mainWindow: BrowserWindow | null = null;
let sessions: SessionStore;
let snapshots: SnapshotStore;

interface TurnContext {
  abort: AbortController;
  approvals: Map<string, (decision: ApprovalDecision) => void>;
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

ipcMain.handle('olivia:task.undo', async (_event, args: { taskId: string; workspace: string }) => {
  const check = await checkWorkspace(args.workspace);
  if (!check.ok) return { ok: false, paths: [], message: check.message };
  const snapshot = await snapshots.latest(args.taskId);
  if (!snapshot) return { ok: false, paths: [], message: '这个任务还没有可撤销的写入' };
  const policy: Policy = { mode: 'workspace-write', root: args.workspace };
  const paths = await snapshots.restore(snapshot, policy);
  await sessions.append(args.taskId, { at: Date.now(), type: 'undo', snapshotId: snapshot.id });
  return { ok: true, paths };
});

// —— 回合 ——
ipcMain.handle('olivia:turn.start', async (event, args: TurnStartArgs & { turnId: string }) => {
  const check = await checkWorkspace(args.workspace);
  if (!check.ok) return { ok: false, error: check.message };
  if (!readEnv().apiKey) return { ok: false, error: '还没有配置模型密钥' };

  const turnId = args.turnId;
  const sender = event.sender;
  const abort = new AbortController();
  const context: TurnContext = { abort, approvals: new Map(), taskId: args.taskId };
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
      turns.delete(turnId);
    }
  })();

  return { ok: true };
});

ipcMain.on('olivia:turn.approve', (_event, args: { turnId: string; callId: string; decision: ApprovalDecision }) => {
  const turn = turns.get(args.turnId);
  turn?.approvals.get(args.callId)?.(args.decision);
});

ipcMain.on('olivia:turn.cancel', (_event, args: { turnId: string }) => {
  const turn = turns.get(args.turnId);
  if (!turn) return;
  turn.abort.abort();
  for (const [, resolve] of turn.approvals) resolve('reject');
  turn.approvals.clear();
});

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
