import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseSessionLog, type SessionEvent } from '@olivia/core';

/** 每个任务一份 JSONL，追加写，损坏行可跳过。 */
export class SessionStore {
  constructor(private readonly dir: string) {}

  private file(taskId: string): string {
    const safe = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.dir, `${safe}.jsonl`);
  }

  async append(taskId: string, event: SessionEvent): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.appendFile(this.file(taskId), `${JSON.stringify(event)}\n`, 'utf8');
  }

  async read(taskId: string): Promise<SessionEvent[]> {
    try {
      const raw = await fs.readFile(this.file(taskId), 'utf8');
      return parseSessionLog(raw);
    } catch {
      return [];
    }
  }
}
