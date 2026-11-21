/**
 * M8 · 多提供商与模型目录（双端共用）。
 *
 * 配置存主进程（不含密钥）；API Key 进保险箱，键名 `provider:<id>`。
 * 渲染层只拿 hasKey 与模型目录，不拿明文。
 */

export type ProviderProtocol = 'openai-chat';

export const PROVIDER_PROTOCOLS: { value: ProviderProtocol; label: string }[] = [
  { value: 'openai-chat', label: 'OpenAI Chat Completions' },
];

export interface ProviderModel {
  id: string;
  /** 展示名；不填用 id */
  label?: string;
  /** 覆盖默认窗口；不填走设置里的默认窗口 */
  contextWindow?: number;
  /** M8：该模型是否允许发送图片 */
  vision?: boolean;
}

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  enabled: boolean;
  models: ProviderModel[];
  createdAt: number;
  updatedAt: number;
  /** 运行时字段：保险箱里有没有这个提供商的 Key（不持久化） */
  hasKey?: boolean;
}

export interface ProviderDraft {
  id: string;
  name: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  enabled?: boolean;
  models: ProviderModel[];
  /** 只在保存时使用；空表示保留已有 Key */
  apiKey?: string;
}

/** 主进程统一返回的结果；错误直接给用户看，不抛异常跨 IPC。 */
export interface ProviderSaveResult {
  ok: boolean;
  error?: string;
  providers?: ProviderConfig[];
}

export interface ProviderModelsResult {
  ok: boolean;
  models?: string[];
  error?: string;
  status?: number;
}

export interface ProviderTestResult extends ProviderModelsResult {
  message?: string;
  keyWorks?: boolean;
}

const PROVIDER_ID = /^[a-z][a-z0-9_-]{1,63}$/;

export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export function validateProviderDraft(draft: ProviderDraft): string | null {
  if (!draft || typeof draft !== 'object') return '提供商配置格式不对';
  if (!PROVIDER_ID.test(String(draft.id ?? '').trim())) {
    return 'Provider ID 要用小写字母开头，只能包含小写字母、数字、下划线与连字符（2–64 位）';
  }
  if (!String(draft.name ?? '').trim()) return '显示名称不能为空';
  if (String(draft.name).trim().length > 60) return '显示名称不能超过 60 个字符';
  if (!/^https?:\/\//i.test(String(draft.baseUrl ?? '').trim())) return 'API 地址必须以 http:// 或 https:// 开头';
  if (draft.protocol !== 'openai-chat') return '目前只支持 OpenAI Chat Completions 协议';
  if (!Array.isArray(draft.models)) return '模型目录格式不对';
  const seen = new Set<string>();
  for (const model of draft.models) {
    const id = String(model?.id ?? '').trim();
    if (!id) return '模型 ID 不能为空';
    if (id.length > 120) return `模型 ID 太长：${id.slice(0, 30)}…`;
    if (seen.has(id)) return `模型 ID 重复：${id}`;
    seen.add(id);
    if (model?.label && model.label.length > 80) return `模型展示名太长：${id}`;
    if (
      model?.contextWindow !== undefined &&
      (!Number.isFinite(model.contextWindow) || model.contextWindow < 4096 || model.contextWindow > 4_000_000)
    ) {
      return `模型 ${id} 的上下文窗口要在 4096–4,000,000 之间`;
    }
  }
  return null;
}

/** 模型选择的稳定键：providerId::modelId；没有 provider 时就是 modelId。 */
export function providerModelKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

/** 保险箱里的 Key 名；主进程读写，渲染层永远只拿 hasKey。 */
export function providerKeyName(id: string): string {
  return `provider:${id.trim()}`;
}

export function parseModelKey(value: string): { providerId?: string; modelId: string } {
  const index = value.indexOf('::');
  if (index <= 0) return { modelId: value };
  return { providerId: value.slice(0, index), modelId: value.slice(index + 2) };
}

export interface ProviderModelOption {
  key: string;
  providerId: string;
  providerName: string;
  modelId: string;
  label: string;
  contextWindow?: number;
  vision: boolean;
}

/** 只列启用提供商里配置过的模型；没配模型就不出现在选择器里。 */
export function providerModelOptions(providers: ProviderConfig[]): ProviderModelOption[] {
  const options: ProviderModelOption[] = [];
  for (const provider of providers) {
    if (!provider.enabled) continue;
    for (const model of provider.models) {
      options.push({
        key: providerModelKey(provider.id, model.id),
        providerId: provider.id,
        providerName: provider.name,
        modelId: model.id,
        label: model.label?.trim() || model.id,
        contextWindow: model.contextWindow,
        vision: Boolean(model.vision),
      });
    }
  }
  return options;
}

export function findProviderModel(
  providers: ProviderConfig[],
  providerId: string | undefined,
  modelId: string,
): { provider: ProviderConfig; model?: ProviderModel } | null {
  if (!providerId) return null;
  const provider = providers.find((item) => item.id === providerId);
  if (!provider) return null;
  return { provider, model: provider.models.find((item) => item.id === modelId) };
}
