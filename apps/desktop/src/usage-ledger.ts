import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { UsageRecord } from '@olivia/core';

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * M7 · 用量账本：每步一行 JSONL，不含对话内容。
 * 用于「近 7 天 / 按模型」汇总与 CSV 导出；价格不落账本。
 */
export class UsageLedger {
  constructor(private readonly file: string) {}

  async append(record: UsageRecord): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const stat = await fs.stat(this.file).catch(() => null);
      if (stat && stat.size > MAX_BYTES) {
        await fs.rename(this.file, `${this.file}.1`).catch(() => undefined);
      }
      await fs.appendFile(this.file, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      // 账本写失败不影响对话
    }
  }

  async list(days = 7): Promise<UsageRecord[]> {
    const since = Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000;
    const records: UsageRecord[] = [];
    for (const file of [`${this.file}.1`, this.file]) {
      let text = '';
      try {
        text = await fs.readFile(file, 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as UsageRecord;
          if (typeof parsed?.at === 'number' && parsed.at >= since) records.push(parsed);
        } catch {
          // 半行忽略
        }
      }
    }
    return records.sort((a, b) => a.at - b.at);
  }

  async clear(): Promise<void> {
    await fs.rm(this.file, { force: true }).catch(() => undefined);
    await fs.rm(`${this.file}.1`, { force: true }).catch(() => undefined);
  }
}
