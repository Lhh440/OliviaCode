import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_CONTEXT_WINDOW,
  type ModelOverride,
  type ModelPricing,
  type PricingFile,
} from '@olivia/core';

/**
 * M7 · 价格与窗口的持久化。
 *
 * 放在主进程而不是渲染层 localStorage：无人值守的费用预算由调度器执行，
 * 那时没有界面；账本只落 token，金额永远按当前价格表实时折算。
 */
export class PricingStore {
  private cache: PricingFile | null = null;

  constructor(private readonly file: string) {}

  private empty(): PricingFile {
    return { defaultContextWindow: DEFAULT_CONTEXT_WINDOW, models: {} };
  }

  private sanitize(raw: unknown): PricingFile {
    const base = this.empty();
    if (!raw || typeof raw !== 'object') return base;
    const input = raw as Partial<PricingFile>;
    const window = Number(input.defaultContextWindow);
    const models: Record<string, ModelOverride> = {};
    if (input.models && typeof input.models === 'object') {
      for (const [id, value] of Object.entries(input.models)) {
        if (!value || typeof value !== 'object') continue;
        const item = value as ModelOverride;
        const next: ModelOverride = {};
        if (typeof item.contextWindow === 'number' && item.contextWindow > 0) {
          next.contextWindow = Math.round(item.contextWindow);
        }
        if (item.pricing && typeof item.pricing === 'object') {
          const pricing = item.pricing as Partial<ModelPricing>;
          const inPerM = Number(pricing.inPerM);
          const outPerM = Number(pricing.outPerM);
          if (Number.isFinite(inPerM) && inPerM >= 0 && Number.isFinite(outPerM) && outPerM >= 0) {
            const cached = Number(pricing.cachedInPerM);
            next.pricing = {
              inPerM,
              outPerM,
              cachedInPerM: Number.isFinite(cached) && cached >= 0 ? cached : undefined,
              currency: 'USD',
              updatedAt: typeof pricing.updatedAt === 'string' ? pricing.updatedAt : new Date().toISOString().slice(0, 10),
              source: 'user',
            };
          }
        }
        if (next.contextWindow !== undefined || next.pricing !== undefined) models[id] = next;
      }
    }
    return {
      defaultContextWindow:
        Number.isFinite(window) && window >= 4096 && window <= 4_000_000
          ? Math.round(window)
          : base.defaultContextWindow,
      models,
    };
  }

  async read(): Promise<PricingFile> {
    if (this.cache) return structuredClone(this.cache);
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      this.cache = this.sanitize(JSON.parse(raw) as unknown);
    } catch {
      this.cache = this.empty();
    }
    return structuredClone(this.cache);
  }

  /** 同步读缓存（启动时已 read 过一次）；供无人值守预算使用。 */
  peek(): PricingFile {
    return structuredClone(this.cache ?? this.empty());
  }

  private async write(next: PricingFile): Promise<PricingFile> {
    this.cache = next;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await fs.rename(temp, this.file);
    return structuredClone(next);
  }

  async setModel(id: string, override: ModelOverride): Promise<PricingFile> {
    const current = await this.read();
    const models = { ...current.models };
    if (override.contextWindow === undefined && override.pricing === undefined) delete models[id];
    else models[id] = override;
    return await this.write({ ...current, models });
  }

  async setDefaultWindow(value: number): Promise<PricingFile> {
    const current = await this.read();
    const window = Math.min(4_000_000, Math.max(4096, Math.round(value)));
    return await this.write({ ...current, defaultContextWindow: window });
  }

  async resetModel(id: string): Promise<PricingFile> {
    const current = await this.read();
    const models = { ...current.models };
    delete models[id];
    return await this.write({ ...current, models });
  }

  async resetAll(): Promise<PricingFile> {
    return await this.write(this.empty());
  }
}
