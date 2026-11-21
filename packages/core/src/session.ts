import type { Message, Part } from './types';
import type { ImageAttachment } from './attachment';
import type { ContextCheckpoint, TaskMemory } from './memory';
import type { UsageStep } from './usage';

/**
 * 事件日志：主进程追加写 JSONL，渲染层靠重放恢复任务。
 * 只记录「可还原」的粗粒度事件，token 级增量不入库。
 */
export type SessionEvent =
  | { at: number; type: 'user.message'; id: string; text: string; attachments?: ImageAttachment[] }
  | { at: number; type: 'assistant.message'; id: string; parts: Part[] }
  | { at: number; type: 'turn.start'; turnId: string; promptChars: number }
  | { at: number; type: 'turn.end'; turnId: string; ok: boolean; error?: string }
  | {
      at: number;
      type: 'tool.call';
      callId: string;
      name: string;
      args: string;
      decision: 'auto' | 'approved' | 'rejected';
      status: 'ok' | 'error';
      summary: string;
    }
  | { at: number; type: 'file.changed'; path: string; adds: number; dels: number }
  | { at: number; type: 'snapshot'; id: string; files: string[] }
  | { at: number; type: 'undo'; snapshotId: string }
  /** M7：每一步模型调用的用量与上下文快照（不含对话内容之外的敏感数据） */
  | { at: number; type: 'usage'; turnId: string; usage: UsageStep }
  /** M8：任务记忆检查点 */
  | { at: number; type: 'memory.updated'; checkpoint: ContextCheckpoint; memory: TaskMemory }
  /** M8：用户显式清空记忆；用于防止从旧日志里把已清空的记忆又重建回来 */
  | { at: number; type: 'memory.cleared' };

export interface SessionLog {
  taskId: string;
  events: SessionEvent[];
}

/** 把事件重放成消息列表；顺序即时间顺序。 */
export function replaySession(events: SessionEvent[]): Message[] {
  const messages: Message[] = [];
  for (const event of events) {
    if (event.type === 'user.message') {
      const parts: Part[] = [{ kind: 'text', text: event.text }];
      for (const attachment of event.attachments ?? []) {
        parts.push({ kind: 'image', attachment });
      }
      messages.push({
        id: event.id,
        role: 'user',
        at: event.at,
        parts,
      });
    } else if (event.type === 'assistant.message') {
      messages.push({
        id: event.id,
        role: 'assistant',
        at: event.at,
        parts: event.parts,
      });
    }
  }
  return messages;
}

export function parseSessionLog(text: string): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as SessionEvent;
      if (parsed && typeof parsed.type === 'string') events.push(parsed);
    } catch {
      // 半行/损坏行直接跳过，日志要能容错
    }
  }
  return events;
}

/** 从事件日志还原用量（旧日志没有 usage 事件，返回空数组）。 */
export function replayUsage(events: SessionEvent[]): UsageStep[] {
  const steps: UsageStep[] = [];
  for (const event of events) {
    if (event.type !== 'usage') continue;
    const usage = event.usage as UsageStep | undefined;
    if (!usage || typeof usage.step !== 'number' || !usage.context) continue;
    steps.push(usage);
  }
  return steps.sort((a, b) => a.at - b.at || a.step - b.step);
}
