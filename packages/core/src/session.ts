import type { Message, Part } from './types';

/**
 * 事件日志：主进程追加写 JSONL，渲染层靠重放恢复任务。
 * 只记录「可还原」的粗粒度事件，token 级增量不入库。
 */
export type SessionEvent =
  | { at: number; type: 'user.message'; id: string; text: string }
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
  | { at: number; type: 'undo'; snapshotId: string };

export interface SessionLog {
  taskId: string;
  events: SessionEvent[];
}

/** 把事件重放成消息列表；顺序即时间顺序。 */
export function replaySession(events: SessionEvent[]): Message[] {
  const messages: Message[] = [];
  for (const event of events) {
    if (event.type === 'user.message') {
      messages.push({
        id: event.id,
        role: 'user',
        at: event.at,
        parts: [{ kind: 'text', text: event.text }],
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
