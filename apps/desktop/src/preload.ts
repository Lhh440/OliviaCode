import { contextBridge, ipcRenderer } from 'electron';
import type {
  ApprovalDecision,
  GitFileDiff,
  GitProvider,
  GitRepoState,
  GitPrResult,
  ImageAttachment,
  ModelPricing,
  PricingFile,
  PreviewState,
  ProviderConfig,
  ProviderDraft,
  ProviderModelsResult,
  ProviderSaveResult,
  ProviderTestResult,
  TaskMemoryFile,
  TurnEnvelope,
  TurnStartArgs,
  UndoResult,
  UsageRecord,
  VaultStatus,
  WorkflowRunArgs,
  WorkflowRunEvent,
  WorkspaceCheck,
} from '@olivia/core';

let env = { baseUrl: '', apiKey: '', model: '', workspace: '' };
try {
  env = ipcRenderer.sendSync('olivia:env') || env;
} catch {
  // 非常规宿主（截图脚本等）没有注册 IPC，退回空配置
}

contextBridge.exposeInMainWorld('olivia', {
  version: '0.10.0',
  platform: process.platform,
  desktop: true,
  env,
  theme: {
    /** 把当前皮肤明暗同步给原生控件，避免暗色皮肤配亮色下拉框 */
    set: (mode: 'light' | 'dark'): void => {
      ipcRenderer.send('olivia:theme', mode);
    },
  },
  // —— M7：价格表、用量账本、内置预览 ——
  pricing: {
    get: (): Promise<PricingFile> => ipcRenderer.invoke('olivia:pricing.get'),
    setWindow: (value: number): Promise<PricingFile> =>
      ipcRenderer.invoke('olivia:pricing.set-window', value),
    setModel: (args: {
      id: string;
      contextWindow?: number;
      pricing?: ModelPricing;
    }): Promise<PricingFile> => ipcRenderer.invoke('olivia:pricing.set-model', args),
    resetModel: (id: string): Promise<PricingFile> =>
      ipcRenderer.invoke('olivia:pricing.reset-model', id),
    reset: (): Promise<PricingFile> => ipcRenderer.invoke('olivia:pricing.reset'),
  },
  usage: {
    list: (days?: number): Promise<UsageRecord[]> => ipcRenderer.invoke('olivia:usage.list', days),
    clear: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('olivia:usage.clear'),
  },
  preview: {
    open: (args: {
      taskId: string;
      url: string;
      bounds: { x: number; y: number; width: number; height: number; visible?: boolean };
    }): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('olivia:preview.open', args),
    setBounds: (bounds: {
      x: number;
      y: number;
      width: number;
      height: number;
      visible?: boolean;
    }): Promise<{ ok: boolean }> => ipcRenderer.invoke('olivia:preview.set-bounds', bounds),
    navigate: (url: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('olivia:preview.navigate', url),
    back: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('olivia:preview.back'),
    forward: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('olivia:preview.forward'),
    reload: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('olivia:preview.reload'),
    setZoom: (factor: number): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('olivia:preview.zoom', factor),
    allowExternal: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('olivia:preview.allow-external'),
    capture: (): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('olivia:preview.capture'),
    clearData: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('olivia:preview.clear-data'),
    close: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('olivia:preview.close'),
    onEvent: (listener: (state: PreviewState) => void): (() => void) => {
      const handler = (_event: unknown, state: PreviewState): void => listener(state);
      ipcRenderer.on('olivia:preview.event', handler);
      return () => ipcRenderer.removeListener('olivia:preview.event', handler);
    },
  },
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
  workflow: {
    run: (
      args: WorkflowRunArgs & { model?: string; allowShell?: boolean },
    ): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('olivia:workflow.run', args),
    cancel: (runId: string): void => {
      ipcRenderer.send('olivia:workflow.cancel', { runId });
    },
    gate: (runId: string, nodeId: string, approved: boolean): void => {
      ipcRenderer.send('olivia:workflow.gate', { runId, nodeId, approved });
    },
    onEvent: (
      listener: (payload: { runId: string; event: WorkflowRunEvent }) => void,
    ): (() => void) => {
      const handler = (_event: unknown, payload: { runId: string; event: WorkflowRunEvent }): void =>
        listener(payload);
      ipcRenderer.on('olivia:workflow.event', handler);
      return () => ipcRenderer.removeListener('olivia:workflow.event', handler);
    },
  },
  vault: {
    status: (): Promise<VaultStatus> => ipcRenderer.invoke('olivia:vault.status'),
    set: (provider: GitProvider, token: string): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke('olivia:vault.set', { provider, token }),
    clear: (provider: GitProvider): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('olivia:vault.clear', provider),
    modelStatus: (): Promise<{ saved: boolean; baseUrl: string; model: string }> =>
      ipcRenderer.invoke('olivia:vault.model-status'),
    setModel: (input: {
      baseUrl: string;
      apiKey: string;
      model: string;
    }): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke('olivia:vault.model-set', input),
    clearModel: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('olivia:vault.model-clear'),
  },
  // —— M8：多提供商 ——
  provider: {
    list: (): Promise<ProviderConfig[]> => ipcRenderer.invoke('olivia:provider.list'),
    save: (draft: ProviderDraft): Promise<ProviderSaveResult> =>
      ipcRenderer.invoke('olivia:provider.save', draft),
    remove: (id: string): Promise<ProviderSaveResult> => ipcRenderer.invoke('olivia:provider.remove', id),
    enable: (id: string, enabled: boolean): Promise<ProviderSaveResult> =>
      ipcRenderer.invoke('olivia:provider.enable', { id, enabled }),
    fetchModels: (args: {
      providerId?: string;
      baseUrl: string;
      apiKey?: string;
    }): Promise<ProviderModelsResult> => ipcRenderer.invoke('olivia:provider.fetch-models', args),
    test: (draft: ProviderDraft): Promise<ProviderTestResult> =>
      ipcRenderer.invoke('olivia:provider.test', draft),
    onEvent: (listener: (providers: ProviderConfig[]) => void): (() => void) => {
      const handler = (_event: unknown, providers: ProviderConfig[]): void => listener(providers);
      ipcRenderer.on('olivia:provider.event', handler);
      return () => ipcRenderer.removeListener('olivia:provider.event', handler);
    },
  },
  // —— M8：图片附件（只落 artifacts，不把 base64 交给渲染层日志）——
  attachments: {
    save: (input: {
      dataUrl?: string;
      filePath?: string;
      source?: ImageAttachment['source'];
      name?: string;
    }): Promise<{ ok: boolean; error?: string; attachment?: ImageAttachment }> =>
      ipcRenderer.invoke('olivia:attachment.save', input),
    adopt: (
      filePath: string,
      source?: ImageAttachment['source'],
    ): Promise<{ ok: boolean; error?: string; attachment?: ImageAttachment }> =>
      ipcRenderer.invoke('olivia:attachment.adopt', { filePath, source }),
  },
  // —— M8：任务记忆与检查点 ——
  memory: {
    get: (taskId: string): Promise<TaskMemoryFile | null> => ipcRenderer.invoke('olivia:memory.get', taskId),
    compact: (args: {
      taskId: string;
      providerId?: string;
      model?: string;
    }): Promise<{ ok: boolean; error?: string; file?: TaskMemoryFile }> =>
      ipcRenderer.invoke('olivia:memory.compact', args),
    revert: (
      taskId: string,
      checkpointId?: string | null,
    ): Promise<{ ok: boolean; file?: TaskMemoryFile }> =>
      ipcRenderer.invoke('olivia:memory.revert', { taskId, checkpointId }),
    clear: (taskId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('olivia:memory.clear', taskId),
    clearAll: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('olivia:memory.clear-all'),
    onEvent: (
      listener: (payload: { taskId: string | null; file: TaskMemoryFile | null }) => void,
    ): (() => void) => {
      const handler = (
        _event: unknown,
        payload: { taskId: string | null; file: TaskMemoryFile | null },
      ): void => listener(payload);
      ipcRenderer.on('olivia:memory.event', handler);
      return () => ipcRenderer.removeListener('olivia:memory.event', handler);
    },
  },
  schedules: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke('olivia:schedules.list'),
    runs: (scheduleId: string): Promise<unknown[]> =>
      ipcRenderer.invoke('olivia:schedules.runs', scheduleId),
    recent: (): Promise<unknown[]> => ipcRenderer.invoke('olivia:schedules.recent'),
    preview: (id: string): Promise<number[]> => ipcRenderer.invoke('olivia:schedules.preview', id),
    sync: (input: unknown): Promise<unknown> => ipcRenderer.invoke('olivia:schedules.sync', input),
    update: (id: string, patch: unknown): Promise<unknown> =>
      ipcRenderer.invoke('olivia:schedules.update', { id, patch }),
    runNow: (id: string): Promise<unknown> => ipcRenderer.invoke('olivia:schedules.run-now', id),
    cancel: (id: string): void => {
      ipcRenderer.send('olivia:schedules.cancel', id);
    },
    openReport: (filePath: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('olivia:schedules.open-report', filePath),
    onEvent: (listener: (event: unknown) => void): (() => void) => {
      const handler = (_event: unknown, payload: unknown): void => listener(payload);
      ipcRenderer.on('olivia:schedules.event', handler);
      return () => ipcRenderer.removeListener('olivia:schedules.event', handler);
    },
  },
  mcp: {
    list: (): Promise<unknown> => ipcRenderer.invoke('olivia:mcp.list'),
    save: (input: unknown): Promise<unknown> => ipcRenderer.invoke('olivia:mcp.save', input),
    remove: (id: string): Promise<unknown> => ipcRenderer.invoke('olivia:mcp.remove', id),
    enable: (id: string, enabled: boolean): Promise<unknown> =>
      ipcRenderer.invoke('olivia:mcp.enable', { id, enabled }),
    connect: (id: string): Promise<unknown> => ipcRenderer.invoke('olivia:mcp.connect', id),
    refresh: (id: string): Promise<unknown> => ipcRenderer.invoke('olivia:mcp.refresh', id),
    disconnect: (id: string): Promise<unknown> => ipcRenderer.invoke('olivia:mcp.disconnect', id),
    setRisk: (id: string, tool: string, risk: string | null): Promise<unknown> =>
      ipcRenderer.invoke('olivia:mcp.risk', { id, tool, risk }),
    setSecret: (key: string, value: string): Promise<unknown> =>
      ipcRenderer.invoke('olivia:mcp.secret', { key, value }),
    onEvent: (listener: (state: unknown) => void): (() => void) => {
      const handler = (_event: unknown, state: unknown): void => listener(state);
      ipcRenderer.on('olivia:mcp.event', handler);
      return () => ipcRenderer.removeListener('olivia:mcp.event', handler);
    },
  },
  skills: {
    pick: (): Promise<string | null> => ipcRenderer.invoke('olivia:skills.pick'),
    list: (workspace: string): Promise<unknown> => ipcRenderer.invoke('olivia:skills.list', workspace),
    install: (workspace: string, dir: string): Promise<unknown> =>
      ipcRenderer.invoke('olivia:skills.install', { workspace, dir }),
    enable: (workspace: string, name: string, enabled: boolean): Promise<unknown> =>
      ipcRenderer.invoke('olivia:skills.enable', { workspace, name, enabled }),
    confirm: (workspace: string, name: string): Promise<unknown> =>
      ipcRenderer.invoke('olivia:skills.confirm', { workspace, name }),
    uninstall: (workspace: string, name: string): Promise<unknown> =>
      ipcRenderer.invoke('olivia:skills.uninstall', { workspace, name }),
    load: (workspace: string, name: string): Promise<unknown> =>
      ipcRenderer.invoke('olivia:skills.load', { workspace, name }),
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
