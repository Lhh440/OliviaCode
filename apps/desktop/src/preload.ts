import { contextBridge, ipcRenderer } from 'electron';
import type {
  ApprovalDecision,
  GitFileDiff,
  GitProvider,
  GitRepoState,
  GitPrResult,
  TurnEnvelope,
  TurnStartArgs,
  UndoResult,
  VaultStatus,
  WorkspaceCheck,
} from '@olivia/core';

let env = { baseUrl: '', apiKey: '', model: '', workspace: '' };
try {
  env = ipcRenderer.sendSync('olivia:env') || env;
} catch {
  // 非常规宿主（截图脚本等）没有注册 IPC，退回空配置
}

contextBridge.exposeInMainWorld('olivia', {
  version: '0.5.0',
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
    patch: (turnId: string, callId: string, accepted: number[] | null): void => {
      ipcRenderer.send('olivia:turn.patch', { turnId, callId, accepted });
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
    undo: (taskId: string, workspace: string, snapshotId?: string): Promise<UndoResult> =>
      ipcRenderer.invoke('olivia:task.undo', { taskId, workspace, snapshotId }),
  },
  vault: {
    status: (): Promise<VaultStatus> => ipcRenderer.invoke('olivia:vault.status'),
    set: (provider: GitProvider, token: string): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke('olivia:vault.set', { provider, token }),
    clear: (provider: GitProvider): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('olivia:vault.clear', provider),
  },
  git: {
    pickDir: (): Promise<string | null> => ipcRenderer.invoke('olivia:git.pick-dir'),
    state: (dir: string): Promise<GitRepoState | null> => ipcRenderer.invoke('olivia:git.state', dir),
    diff: (args: { dir: string; path: string; staged: boolean }): Promise<GitFileDiff> =>
      ipcRenderer.invoke('olivia:git.diff', args),
    stage: (dir: string, paths: string[]): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('olivia:git.stage', { dir, paths }),
    unstage: (dir: string, paths: string[]): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('olivia:git.unstage', { dir, paths }),
    stageHunks: (dir: string, path: string, indexes: number[]): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('olivia:git.stage-hunks', { dir, path, indexes }),
    commit: (dir: string, message: string): Promise<{ ok: boolean; hash: string }> =>
      ipcRenderer.invoke('olivia:git.commit', { dir, message }),
    checkout: (dir: string, branch: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('olivia:git.checkout', { dir, branch }),
    createBranch: (dir: string, branch: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('olivia:git.create-branch', { dir, branch }),
    pull: (dir: string): Promise<{ ok: boolean; output?: string; message?: string; conflicts?: string[] }> =>
      ipcRenderer.invoke('olivia:git.pull', { dir }),
    push: (dir: string): Promise<{ ok: boolean; output?: string; message?: string }> =>
      ipcRenderer.invoke('olivia:git.push', { dir }),
    pr: (args: {
      dir: string;
      title: string;
      body: string;
      base: string;
    }): Promise<GitPrResult> => ipcRenderer.invoke('olivia:git.pr', args),
    clone: (args: {
      parentDir: string;
      url: string;
      name: string;
    }): Promise<{ ok: boolean; dir?: string; message?: string }> =>
      ipcRenderer.invoke('olivia:git.clone', args),
  },
});
