import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  emptyMemory,
  mergeMemory,
  parseMemoryDraft,
  type ContextCheckpoint,
  type TaskMemory,
  type TaskMemoryFile,
} from '@olivia/core';

/**
 * M8 · 任务记忆的持久化。
 *
 * 每个任务一份 JSON：当前记忆 + 检查点列表（只增不改）。
 * 「回退」只是把 activeCheckpointId 指向上一个，原文与会话日志都不动。
 */
export class MemoryStore {
  constructor(private readonly dir: string) {}

  private file(taskId: string): string {
    const safe = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.dir, `${safe}.json`);
  }

  async read(taskId: string): Promise<TaskMemoryFile> {
    try {
      const raw = await fs.readFile(this.file(taskId), 'utf8');
      const parsed = JSON.parse(raw) as TaskMemoryFile;
      if (parsed?.memory && Array.isArray(parsed.checkpoints)) {
        return {
          taskId,
          updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
          memory: parsed.memory,
          checkpoints: parsed.checkpoints,
          activeCheckpointId:
            typeof parsed.activeCheckpointId === 'string' ? parsed.activeCheckpointId : undefined,
        };
      }
    } catch {
      // 没有就返回空记忆
    }
    return { taskId, updatedAt: Date.now(), memory: emptyMemory(taskId), checkpoints: [] };
  }

  private async write(next: TaskMemoryFile): Promise<TaskMemoryFile> {
    await fs.mkdir(this.dir, { recursive: true });
    const file = this.file(next.taskId);
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await fs.rename(temp, file);
    return next;
  }

  /** 写入一次整理结果：合并记忆 + 追加检查点。 */
  async commit(
    taskId: string,
    input: {
      draftRaw: string;
      reason: ContextCheckpoint['reason'];
      beforeUsed: number;
      afterUsed: number;
      keptTurns: number;
      droppedTurns: number;
      usage?: ContextCheckpoint['usage'];
    },
  ): Promise<{ ok: boolean; error?: string; file?: TaskMemoryFile; memory?: TaskMemory }> {
    const draft = parseMemoryDraft(input.draftRaw);
    if (!draft) return { ok: false, error: '摘要不是合法的记忆 JSON（字段缺失或超长）' };
    const current = await this.read(taskId);
    const memory = mergeMemory(taskId, current.memory, draft);
    const checkpoint: ContextCheckpoint = {
      id: `cp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      at: Date.now(),
      reason: input.reason,
      beforeUsed: input.beforeUsed,
      afterUsed: input.afterUsed,
      keptTurns: input.keptTurns,
      droppedTurns: input.droppedTurns,
      memory,
      usage: input.usage,
    };
    const file = await this.write({
      taskId,
      updatedAt: Date.now(),
      memory,
      checkpoints: [...current.checkpoints, checkpoint].slice(-50),
      activeCheckpointId: checkpoint.id,
    } as TaskMemoryFile);
    return { ok: true, file, memory };
  }

  async setMemory(taskId: string, memory: TaskMemory): Promise<TaskMemoryFile> {
    const current = await this.read(taskId);
    return await this.write({ ...current, updatedAt: Date.now(), memory });
  }

  /** 回退：指向已有检查点；不删除任何原文。 */
  async revert(taskId: string, checkpointId: string | null): Promise<TaskMemoryFile> {
    const current = await this.read(taskId);
    const target = checkpointId
      ? current.checkpoints.find((item) => item.id === checkpointId)
      : [...current.checkpoints].reverse().find((item) => item.id !== current.activeCheckpointId);
    return await this.write({
      ...current,
      updatedAt: Date.now(),
      activeCheckpointId: target?.id,
      memory: target?.memory ?? current.memory,
    });
  }

  async clear(taskId: string): Promise<void> {
    await fs.rm(this.file(taskId), { force: true }).catch(() => undefined);
  }

  async clearAll(): Promise<void> {
    const names = await fs.readdir(this.dir).catch(() => [] as string[]);
    for (const name of names) {
      if (name.endsWith('.json')) await fs.rm(path.join(this.dir, name), { force: true }).catch(() => undefined);
    }
  }
}
