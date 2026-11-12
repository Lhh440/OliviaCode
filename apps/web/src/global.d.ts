import type {
  ApprovalDecision,
  TurnEnvelope,
  TurnStartArgs,
  UndoResult,
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
        onEvent: (listener: (envelope: TurnEnvelope) => void) => () => void;
      };
      task: {
        load: (taskId: string) => Promise<{ taskId: string; events: unknown[] }>;
        undo: (taskId: string, workspace: string) => Promise<UndoResult>;
      };
    };
  }
}
