import type {
  ApprovalDecision,
  GitFileDiff,
  GitPrResult,
  GitProvider,
  GitRepoState,
  McpRisk,
  McpServerConfig,
  McpServerState,
  ImageAttachment,
  ModelPricing,
  PricingFile,
  PreviewState,
  ProviderConfig,
  ProviderDraft,
  ProviderModelsResult,
  ProviderSaveResult,
  ProviderTestResult,
  RunRecord,
  ScheduleRecord,
  SkillInfo,
  TaskMemoryFile,
  TurnEnvelope,
  TurnStartArgs,
  UndoResult,
  UnattendedPolicy,
  UsageRecord,
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
      pricing: {
        get: () => Promise<PricingFile>;
        setWindow: (value: number) => Promise<PricingFile>;
        setModel: (args: {
          id: string;
          contextWindow?: number;
          pricing?: ModelPricing;
        }) => Promise<PricingFile>;
        resetModel: (id: string) => Promise<PricingFile>;
        reset: () => Promise<PricingFile>;
      };
      usage: {
        list: (days?: number) => Promise<UsageRecord[]>;
        clear: () => Promise<{ ok: boolean }>;
      };
      preview: {
        open: (args: {
          taskId: string;
          url: string;
          bounds: { x: number; y: number; width: number; height: number; visible?: boolean };
        }) => Promise<{ ok: boolean; error?: string }>;
        setBounds: (bounds: {
          x: number;
          y: number;
          width: number;
          height: number;
          visible?: boolean;
        }) => Promise<{ ok: boolean }>;
        navigate: (url: string) => Promise<{ ok: boolean }>;
        back: () => Promise<{ ok: boolean }>;
        forward: () => Promise<{ ok: boolean }>;
        reload: () => Promise<{ ok: boolean }>;
        setZoom: (factor: number) => Promise<{ ok: boolean }>;
        allowExternal: () => Promise<{ ok: boolean }>;
        capture: () => Promise<{ ok: boolean; path?: string; error?: string }>;
        clearData: () => Promise<{ ok: boolean }>;
        close: () => Promise<{ ok: boolean }>;
        onEvent: (listener: (state: PreviewState) => void) => () => void;
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
      provider: {
        list: () => Promise<ProviderConfig[]>;
        save: (draft: ProviderDraft) => Promise<ProviderSaveResult>;
        remove: (id: string) => Promise<ProviderSaveResult>;
        enable: (id: string, enabled: boolean) => Promise<ProviderSaveResult>;
        fetchModels: (args: {
          providerId?: string;
          baseUrl: string;
          apiKey?: string;
        }) => Promise<ProviderModelsResult>;
        test: (draft: ProviderDraft) => Promise<ProviderTestResult>;
        onEvent: (listener: (providers: ProviderConfig[]) => void) => () => void;
      };
      attachments: {
        save: (input: {
          dataUrl?: string;
          filePath?: string;
          source?: ImageAttachment['source'];
          name?: string;
        }) => Promise<{ ok: boolean; error?: string; attachment?: ImageAttachment }>;
        adopt: (
          filePath: string,
          source?: ImageAttachment['source'],
        ) => Promise<{ ok: boolean; error?: string; attachment?: ImageAttachment }>;
      };
      memory: {
        get: (taskId: string) => Promise<TaskMemoryFile | null>;
        compact: (args: {
          taskId: string;
          providerId?: string;
          model?: string;
        }) => Promise<{ ok: boolean; error?: string; file?: TaskMemoryFile }>;
        revert: (
          taskId: string,
          checkpointId?: string | null,
        ) => Promise<{ ok: boolean; file?: TaskMemoryFile }>;
        clear: (taskId: string) => Promise<{ ok: boolean }>;
        clearAll: () => Promise<{ ok: boolean }>;
        onEvent: (
          listener: (payload: { taskId: string | null; file: TaskMemoryFile | null }) => void,
        ) => () => void;
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
          invalid?: string[];
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
      mcp: {
        list: () => Promise<{ configs: McpServerConfig[]; states: McpServerState[] }>;
        save: (
          input: Partial<McpServerConfig> & { id?: string },
        ) => Promise<{ ok: boolean; error?: string; config?: McpServerConfig }>;
        remove: (id: string) => Promise<{ ok: boolean }>;
        enable: (id: string, enabled: boolean) => Promise<McpServerState | null>;
        connect: (id: string) => Promise<McpServerState | null>;
        refresh: (id: string) => Promise<McpServerState | null>;
        disconnect: (id: string) => Promise<{ ok: boolean }>;
        setRisk: (id: string, tool: string, risk: McpRisk | null) => Promise<McpServerState | null>;
        setSecret: (key: string, value: string) => Promise<{ ok: boolean; message?: string }>;
        onEvent: (listener: (state: McpServerState) => void) => () => void;
      };
      skills: {
        pick: () => Promise<string | null>;
        list: (workspace: string) => Promise<SkillInfo[]>;
        install: (
          workspace: string,
          dir: string,
        ) => Promise<{ ok: boolean; skill?: SkillInfo; error?: string }>;
        enable: (
          workspace: string,
          name: string,
          enabled: boolean,
        ) => Promise<{ ok: boolean; error?: string }>;
        confirm: (workspace: string, name: string) => Promise<{ ok: boolean; error?: string }>;
        uninstall: (workspace: string, name: string) => Promise<{ ok: boolean; error?: string }>;
        load: (
          workspace: string,
          name: string,
        ) => Promise<{ ok: boolean; text?: string; error?: string }>;
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
