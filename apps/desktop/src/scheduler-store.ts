import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_UNATTENDED_POLICY,
  type RunRecord,
  type ScheduleRecord,
} from '@olivia/core';

/**
 * 排期账本：`schedules.json`（注册表）+ `runs/<id>.json`（每次运行）。
 *
 * 两条硬要求：
 * - 原子写：先写临时文件再 rename，掉电不留半截 JSON；
 * - 容错读：文件损坏时退回空账本并保留现场（另存 .bad），不让启动直接崩。
 */
export class SchedulerStore {
  private readonly schedulesFile: string;
  private readonly runsDir: string;
  private cache: ScheduleRecord[] | null = null;

  constructor(private readonly baseDir: string) {
    this.schedulesFile = path.join(baseDir, 'schedules.json');
    this.runsDir = path.join(baseDir, 'runs');
  }

  private async atomicWrite(file: string, text: string): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, text, 'utf8');
    await fs.rename(temp, file);
  }

  async listSchedules(): Promise<ScheduleRecord[]> {
    if (this.cache) return this.cache.map((item) => structuredClone(item));
    try {
      const raw = await fs.readFile(this.schedulesFile, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const list = Array.isArray(parsed) ? parsed : [];
      this.cache = list
        .filter(
          (item): item is ScheduleRecord =>
            Boolean(item) && typeof item === 'object' && typeof (item as ScheduleRecord).id === 'string',
        )
        // M7：老计划没有 token/费用上限字段，读的时候按默认值补齐
        .map((item) => ({
          ...item,
          policy: { ...DEFAULT_UNATTENDED_POLICY, ...item.policy },
        }));
    } catch (error) {
      this.cache = [];
      if (error instanceof SyntaxError) {
        // 损坏的账本留一份现场，避免下次写入把它彻底覆盖
        await fs
          .copyFile(this.schedulesFile, `${this.schedulesFile}.bad.${Date.now()}`)
          .catch(() => undefined);
      }
    }
    return this.cache.map((item) => structuredClone(item));
  }

  async getSchedule(id: string): Promise<ScheduleRecord | null> {
    const all = await this.listSchedules();
    return all.find((item) => item.id === id) ?? null;
  }

  async saveSchedules(records: ScheduleRecord[]): Promise<void> {
    this.cache = records.map((item) => structuredClone(item));
    await this.atomicWrite(this.schedulesFile, `${JSON.stringify(this.cache, null, 2)}\n`);
  }

  async putSchedule(record: ScheduleRecord): Promise<void> {
    const all = await this.listSchedules();
    const index = all.findIndex((item) => item.id === record.id);
    if (index >= 0) all[index] = record;
    else all.push(record);
    await this.saveSchedules(all);
  }

  async saveRuns(record: RunRecord): Promise<void> {
    await this.atomicWrite(path.join(this.runsDir, `${record.id}.json`), JSON.stringify(record, null, 2));
  }

  async getRun(id: string): Promise<RunRecord | null> {
    try {
      const raw = await fs.readFile(path.join(this.runsDir, `${id}.json`), 'utf8');
      return JSON.parse(raw) as RunRecord;
    } catch {
      return null;
    }
  }

  /** 某个计划的运行记录，按开始时间倒序。 */
  async listRuns(scheduleId: string, limit = 50): Promise<RunRecord[]> {
    const names = await fs.readdir(this.runsDir).catch(() => [] as string[]);
    const runs: RunRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(this.runsDir, name), 'utf8');
        const parsed = JSON.parse(raw) as RunRecord;
        if (parsed?.scheduleId === scheduleId) runs.push(parsed);
      } catch {
        // 单条损坏不影响其它历史
      }
    }
    return runs.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
  }

  async listAllRuns(limit = 100): Promise<RunRecord[]> {
    const names = await fs.readdir(this.runsDir).catch(() => [] as string[]);
    const runs: RunRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        runs.push(JSON.parse(await fs.readFile(path.join(this.runsDir, name), 'utf8')) as RunRecord);
      } catch {
        // 忽略
      }
    }
    return runs.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
  }

  /**
   * 上次进程留下的「运行中」记录一律判为中断：
   * 崩溃后不能假装那次跑成功了，也不该让界面永远转圈。
   */
  async markInterrupted(): Promise<RunRecord[]> {
    const runs = await this.listAllRuns(500);
    const touched: RunRecord[] = [];
    for (const run of runs) {
      if (run.status !== 'running') continue;
      const next: RunRecord = {
        ...run,
        status: 'interrupted',
        endedAt: run.endedAt ?? Date.now(),
        error: run.error ?? '应用退出时这次运行还没结束',
      };
      await this.saveRuns(next);
      touched.push(next);
    }
    return touched;
  }
}