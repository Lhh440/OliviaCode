import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  normalizeBaseUrl,
  type ProviderConfig,
  type ProviderDraft,
  type ProviderProtocol,
} from '@olivia/core';

const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    protocol: 'openai-chat',
    enabled: true,
    models: [
      { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', contextWindow: 128000 },
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', contextWindow: 128000 },
    ],
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'qwen',
    name: 'Qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    protocol: 'openai-chat',
    enabled: false,
    models: [
      { id: 'qwen3.8-27b', label: 'Qwen3.8 27B', contextWindow: 128000, vision: false },
    ],
    createdAt: 0,
    updatedAt: 0,
  },
];

/**
 * M8 · 模型提供商的持久化（不含密钥）。
 * 密钥由 vault 按 `provider:<id>` 单独保存；这里只存地址与模型目录。
 */
export class ProviderStore {
  private cache: ProviderConfig[] | null = null;

  constructor(private readonly file: string) {}

  private sanitize(raw: unknown): ProviderConfig[] {
    if (!Array.isArray(raw)) return structuredClone(DEFAULT_PROVIDERS);
    const out: ProviderConfig[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const input = item as Partial<ProviderConfig>;
      if (typeof input.id !== 'string' || !input.id || seen.has(input.id)) continue;
      seen.add(input.id);
      out.push({
        id: input.id,
        name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : input.id,
        baseUrl: typeof input.baseUrl === 'string' ? normalizeBaseUrl(input.baseUrl) : '',
        protocol: input.protocol === 'openai-chat' ? 'openai-chat' : 'openai-chat',
        enabled: input.enabled !== false,
        models: Array.isArray(input.models)
          ? input.models
              .filter((model): model is NonNullable<typeof model> => Boolean(model) && typeof model.id === 'string')
              .map((model) => ({
                id: model.id,
                label: typeof model.label === 'string' ? model.label : undefined,
                contextWindow: typeof model.contextWindow === 'number' ? model.contextWindow : undefined,
                vision: Boolean(model.vision),
              }))
          : [],
        createdAt: typeof input.createdAt === 'number' ? input.createdAt : Date.now(),
        updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : Date.now(),
      });
    }
    return out;
  }

  async list(): Promise<ProviderConfig[]> {
    if (this.cache) return structuredClone(this.cache);
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      this.cache = this.sanitize(JSON.parse(raw) as unknown);
    } catch {
      this.cache = structuredClone(DEFAULT_PROVIDERS);
    }
    return structuredClone(this.cache);
  }

  async get(id: string): Promise<ProviderConfig | null> {
    return (await this.list()).find((item) => item.id === id) ?? null;
  }

  private async write(next: ProviderConfig[]): Promise<ProviderConfig[]> {
    this.cache = next;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await fs.rename(temp, this.file);
    return structuredClone(next);
  }

  async save(draft: ProviderDraft): Promise<{ ok: boolean; error?: string; providers?: ProviderConfig[] }> {
    const current = await this.list();
    const id = draft.id.trim();
    const existing = current.find((item) => item.id === id);
    if (!existing && current.length >= 12) return { ok: false, error: '最多 12 个提供商' };
    const now = Date.now();
    const config: ProviderConfig = {
      id,
      name: draft.name.trim(),
      baseUrl: normalizeBaseUrl(draft.baseUrl),
      protocol: (draft.protocol ?? 'openai-chat') as ProviderProtocol,
      enabled: draft.enabled ?? existing?.enabled ?? true,
      models: draft.models.map((model) => ({
        id: model.id.trim(),
        label: model.label?.trim() || undefined,
        contextWindow:
          typeof model.contextWindow === 'number' && model.contextWindow > 0 ? model.contextWindow : undefined,
        vision: Boolean(model.vision),
      })),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const next = existing
      ? current.map((item) => (item.id === config.id ? config : item))
      : [...current, config];
    const providers = await this.write(next);
    return { ok: true, providers };
  }

  async remove(id: string): Promise<ProviderConfig[]> {
    const current = await this.list();
    return await this.write(current.filter((item) => item.id !== id));
  }

  async setEnabled(id: string, enabled: boolean): Promise<ProviderConfig[]> {
    const current = await this.list();
    return await this.write(
      current.map((item) => (item.id === id ? { ...item, enabled, updatedAt: Date.now() } : item)),
    );
  }

  async setModelFlags(
    providerId: string,
    modelId: string,
    patch: { vision?: boolean; contextWindow?: number },
  ): Promise<ProviderConfig[]> {
    const current = await this.list();
    return await this.write(
      current.map((provider) => {
        if (provider.id !== providerId) return provider;
        return {
          ...provider,
          updatedAt: Date.now(),
          models: provider.models.map((model) =>
            model.id === modelId
              ? {
                  ...model,
                  vision: patch.vision ?? model.vision,
                  contextWindow:
                    typeof patch.contextWindow === 'number' && patch.contextWindow > 0
                      ? patch.contextWindow
                      : model.contextWindow,
                }
              : model,
          ),
        };
      }),
    );
  }
}
