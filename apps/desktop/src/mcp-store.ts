import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { McpServerConfig } from '@olivia/core';

/**
 * MCP 服务器配置：存在应用数据目录（机器级），不进工作区仓库。
 * 团队技能可以「引用」服务器 id，但不能定义命令——否则 clone 一个仓库就等于执行陌生代码。
 */
export class McpStore {
  private cache: McpServerConfig[] | null = null;

  constructor(private readonly file: string) {}

  private async atomicWrite(text: string): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, text, 'utf8');
    await fs.rename(temp, this.file);
  }

  async list(): Promise<McpServerConfig[]> {
    if (this.cache) return this.cache.map((item) => structuredClone(item));
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const list = Array.isArray(parsed) ? parsed : [];
      this.cache = list.filter(
        (item): item is McpServerConfig =>
          Boolean(item) && typeof item === 'object' && typeof (item as McpServerConfig).id === 'string',
      );
    } catch {
      this.cache = [];
    }
    return this.cache.map((item) => structuredClone(item));
  }

  async save(configs: McpServerConfig[]): Promise<void> {
    this.cache = configs.map((item) => structuredClone(item));
    await this.atomicWrite(`${JSON.stringify(this.cache, null, 2)}\n`);
  }
}