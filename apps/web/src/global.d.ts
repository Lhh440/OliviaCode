import type {
  ApprovalDecision,
  GitFileDiff,
  GitPrResult,
  GitProvider,
  GitRepoState,
  RunRecord,
  ScheduleRecord,
  TurnEnvelope,
  TurnStartArgs,
  UndoResult,
  UnattendedPolicy,
  VaultStatus,
  Workflow,
  WorkflowRunArgs,
  WorkflowRunEvent,
  WorkspaceCheck,
} from '@olivia/core';

export {};

declare global {
  interface Window {
    olivia?: {
      version: string;
      platform: string;
      desktop: boolean;
      env: { baseUrl: string; apiKey: string; model: string; workspace: string };
      theme: {
        set: (mode: 'light' | 'dark') => void;
      };
      workspace: {
        pick: () => Promise<string | null>;
        check: (dir: string) => Promise<WorkspaceCheck>;
      };
      turn: {
        start: (args: TurnStartArgs & { turnId: string }) => Promise<{ ok: boolean; error?: string }>;
        cancel: (turnId: string) => void;
        approve: (turnId: string, callId: string, decision: ApprovalDecision) => void;
        patch: (turnId: string, callId: string, accepted: number[] | null) => void;
        onEvent: (listener: (envelope: TurnEnvelope) => void) => () => void;
      };
      task: {
        load: (taskId: string) => Promise<{ taskId: string; events: unknown[] }>;
        undo: (taskId: string, workspace: string, snapshotId?: string) => Promise<UndoResult>;
      };
      workflow: {
        run: (
          args: WorkflowRunArgs & { model?: string; allowShell?: boolean },
        ) => Promise<{ ok: boolean; error?: string }>;
        cancel: (runId: string) => void;
        gate: (runId: string, nodeId: string, approved: boolean) => void;
        onEvent: (
          listener: (payload: { runId: string; event: WorkflowRunEvent }) => void,
        ) => () => void;
      };
      vault: {
        status: () => Promise<VaultStatus>;
        set: (provider: GitProvider, token: string) => Promise<{ ok: boolean; message?: string }>;
        clear: (provider: GitProvider) => Promise<{ ok: boolean }>;
        modelStatus: () => Promise<{ saved: boolean; baseUrl: string; model: string }>;
        setModel: (input: {
          baseUrl: string;
          apiKey: string;
          model: string;
        }) => Promise<{ ok: boolean; message?: string }>;
        clearModel: () => Promise<{ ok: boolean }>;
      };
      schedules: {
        list: () => Promise<ScheduleRecord[]>;
        runs: (scheduleId: string) => Promise<RunRecord[]>;
        recent: () => Promise<RunRecord[]>;
        preview: (id: string) => Promise<number[]>;
        sync: (input: { workflow: Workflow; workspace: string }) => Promise<{
          ok: boolean;
          schedules?: ScheduleRecord[];
          created?: string[];
          disabled?: string[];
          error?: string;
        }>;
        update: (
          id: string,
          patch: { enabled?: boolean; mode?: ScheduleRecord['mode']; policy?: UnattendedPolicy },
        ) => Promise<{ ok: boolean; schedule?: ScheduleRecord; error?: string }>;
        runNow: (id: string) => Promise<{ ok: boolean; error?: string; run?: RunRecord }>;
        cancel: (id: string) => void;
        openReport: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
        onEvent: (listener: (event: unknown) => void) => () => void;
      };
      git: {
        pickDir: () => Promise<string | null>;
        state: (dir: string) => Promise<GitRepoState | null>;
        diff: (args: { dir: string; path: string; staged: boolean }) => Promise<GitFileDiff>;
        stage: (dir: string, paths: string[]) => Promise<{ ok: boolean }>;
        unstage: (dir: string, paths: string[]) => Promise<{ ok: boolean }>;
        stageHunks: (dir: string, path: string, indexes: number[]) => Promise<{ ok: boolean }>;
        commit: (dir: string, message: string) => Promise<{ ok: boolean; hash: string }>;
        checkout: (dir: string, branch: string) => Promise<{ ok: boolean }>;
        createBranch: (dir: string, branch: string) => Promise<{ ok: boolean }>;
        pull: (dir: string) => Promise<{
          ok: boolean;
          output?: string;
          message?: string;
          conflicts?: string[];
        }>;
        push: (dir: string) => Promise<{ ok: boolean; output?: string; message?: string }>;
        pr: (args: {
          dir: string;
          title: string;
          body: string;
          base: string;
        }) => Promise<GitPrResult>;
        clone: (args: {
          parentDir: string;
          url: string;
          name: string;
        }) => Promise<{ ok: boolean; dir?: string; message?: string }>;
      };
    };
  }
}
