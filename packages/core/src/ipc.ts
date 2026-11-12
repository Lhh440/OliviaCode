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
      type: 'file.changed';
      path: string;
      adds: number;
      dels: number;
      hunks: DiffHunk[];
      snapshotId: string;
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
}

export interface SessionPayload {
  taskId: string;
  events: unknown[];
}
