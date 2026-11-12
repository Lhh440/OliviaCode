import { contextBridge, ipcRenderer } from 'electron';
import type {
  ApprovalDecision,
  TurnEnvelope,
  TurnStartArgs,
  UndoResult,
  WorkspaceCheck,
} from '@olivia/core';

let env = { baseUrl: '', apiKey: '', model: '', workspace: '' };
try {
  env = ipcRenderer.sendSync('olivia:env') || env;
} catch {
  // 非常规宿主（截图脚本等）没有注册 IPC，退回空配置
}

contextBridge.exposeInMainWorld('olivia', {
  version: '0.4.0',
  platform: process.platform,
  desktop: true,
  env,
  workspace: {
    pick: (): Promise<string | null> => ipcRenderer.invoke('olivia:workspace.pick'),
    check: (dir: string): Promise<WorkspaceCheck> =>
      ipcRenderer.invoke('olivia:workspace.check', dir),
  },
  turn: {
    start: (args: TurnStartArgs & { turnId: string }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('olivia:turn.start', args),
    cancel: (turnId: string): void => {
      ipcRenderer.send('olivia:turn.cancel', { turnId });
    },
    approve: (turnId: string, callId: string, decision: ApprovalDecision): void => {
      ipcRenderer.send('olivia:turn.approve', { turnId, callId, decision });
    },
    onEvent: (listener: (envelope: TurnEnvelope) => void): (() => void) => {
      const handler = (_event: unknown, envelope: TurnEnvelope): void => listener(envelope);
      ipcRenderer.on('olivia:turn.event', handler);
      return () => ipcRenderer.removeListener('olivia:turn.event', handler);
    },
  },
  task: {
    load: (taskId: string): Promise<{ taskId: string; events: unknown[] }> =>
      ipcRenderer.invoke('olivia:task.load', taskId),
    undo: (taskId: string, workspace: string): Promise<UndoResult> =>
      ipcRenderer.invoke('olivia:task.undo', { taskId, workspace }),
  },
});
