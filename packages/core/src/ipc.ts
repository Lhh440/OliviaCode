import type { ApprovalMode, DiffHunk } from './types';
import type { ToolRisk } from './tools';

/** 主进程 ⇄ 渲染层（含 preload）共用的协议。 */

export type ApprovalDecision = 'once' | 'always' | 'reject';

export interface ApprovalRequest {
  callId: string;
  name: string;
  risk: ToolRisk;
  detail: string;
  args: Record<string, unknown>;
}

/** 逐处修改的预览：每一条 edits 一个可勾选单元 */
export interface PatchEditPreview {
  index: number;
  adds: number;
  dels: number;
  hunks: DiffHunk[];
}

/** null = 全部拒绝；数组 = 接受的下标 */
export type PatchDecision = number[] | null;

export type TurnEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool.request'; call: ApprovalRequest; needsApproval: boolean }
  | {
      type: 'tool.result';
      callId: string;
      status: 'ok' | 'error';
      summary: string;
      rows?: string[];
    }
  | { type: 'command.output'; callId: string; chunk: string }
  | {
      type: 'file.proposed';
      callId: string;
      path: string;
      edits: PatchEditPreview[];
      adds: number;
      dels: number;
    }
  | {
      type: 'file.changed';
      path: string;
      adds: number;
      dels: number;
      hunks: DiffHunk[];
      snapshotId: string;
      callId?: string;
    }
  | { type: 'turn.done'; ok: boolean; error?: string };

export interface TurnEnvelope {
  taskId: string;
  turnId: string;
  event: TurnEvent;
}

export interface TurnStartArgs {
  taskId: string;
  workspace: string;
  prompt: string;
  model: string;
  approval: ApprovalMode;
  allowShell: boolean;
  /** 设置页里填的端点与密钥（只存渲染层内存），优先于环境变量 */
  baseUrl?: string;
  apiKey?: string;
  /** 最近若干轮纯文本历史，用于给模型接上下文 */
  history: { role: 'user' | 'assistant'; content: string }[];
}

export interface WorkspaceCheck {
  ok: boolean;
  message: string;
  name?: string;
}

export interface UndoResult {
  ok: boolean;
  paths: string[];
  message?: string;
  /** 还能继续回退几步 */
  remaining?: number;
}

// —— Git ——

export type GitProvider = 'gitcode' | 'github';

export interface RemoteInfo {
  provider: GitProvider;
  host: string;
  owner: string;
  repo: string;
  webUrl: string;
}

export type GitFileState =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted';

export interface GitFile {
  path: string;
  state: GitFileState;
  staged: boolean;
}

export interface GitStatus {
  ok: boolean;
  message?: string;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
  remote: RemoteInfo | null;
}

export interface GitBranch {
  name: string;
  current: boolean;
}

export interface GitCommit {
  hash: string;
  short: string;
  author: string;
  at: number;
  subject: string;
}

export interface GitHunk {
  index: number;
  header: string;
  body: string;
}

export interface GitFileDiff {
  path: string;
  header: string;
  hunks: GitHunk[];
  binary: boolean;
  empty: boolean;
}

export interface GitRepoState {
  isRepo: boolean;
  root: string;
  status: GitStatus;
  branches: GitBranch[];
  log: GitCommit[];
}

export interface GitPrResult {
  ok: boolean;
  url?: string;
  message?: string;
}

export interface VaultStatus {
  gitcode: boolean;
  github: boolean;
}
