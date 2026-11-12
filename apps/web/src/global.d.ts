import type {
  ApprovalDecision,
  GitFileDiff,
  GitPrResult,
  GitProvider,
  GitRepoState,
  TurnEnvelope,
  TurnStartArgs,
  UndoResult,
  VaultStatus,
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
      vault: {
        status: () => Promise<VaultStatus>;
        set: (provider: GitProvider, token: string) => Promise<{ ok: boolean; message?: string }>;
        clear: (provider: GitProvider) => Promise<{ ok: boolean }>;
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
