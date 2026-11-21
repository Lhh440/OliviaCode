import type { ProviderConfig } from '@olivia/core';

/**
 * M8 · 连接测试：只用最小的请求验端点与密钥，不发送任何对话内容。
 * - 能列模型就列；不行就发一条 1 token 的 chat 请求；
 * - 特别区分 401/403（密钥）、429（额度）与网络错误。
 */

export async function fetchProviderModels(
  baseUrl: string,
  apiKey: string,
): Promise<{ ok: boolean; models?: string[]; error?: string; status?: number }> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, status: response.status, error: await response.text().catch(() => '') };
    const json = (await response.json().catch(() => null)) as { data?: { id?: string }[] } | null;
    const models = (json?.data ?? []).map((item) => item.id).filter((id): id is string => Boolean(id));
    return { ok: true, models };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: /abort/i.test(message) ? '请求超时（8s）' : message };
  } finally {
    clearTimeout(timer);
  }
}

async function pingChat(
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
    });
    if (!response.ok) {
      return { ok: false, status: response.status, error: (await response.text().catch(() => '')).slice(0, 300) };
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: /abort/i.test(message) ? '请求超时（15s）' : message };
  } finally {
    clearTimeout(timer);
  }
}

export async function testProviderConnection(input: {
  draft: ProviderConfig;
  apiKey: string;
}): Promise<{ ok: boolean; message: string; models?: string[]; keyWorks?: boolean }> {
  const baseUrl = input.draft.baseUrl.replace(/\/+$/, '');
  const apiKey = input.apiKey.trim();
  if (!baseUrl) return { ok: false, message: 'API 地址不能为空' };
  if (!apiKey) return { ok: false, message: '还没有 API Key，无法测试' };

  const listing = await fetchProviderModels(baseUrl, apiKey);
  if (listing.ok) {
    const models = listing.models ?? [];
    return {
      ok: true,
      keyWorks: true,
      models,
      message:
        models.length > 0
          ? `连接成功 · 密钥可用 · 端点返回 ${models.length} 个模型`
          : '连接成功 · 密钥可用 · 端点没有返回模型列表',
    };
  }
  if (listing.status === 401 || listing.status === 403) {
    return { ok: false, keyWorks: false, message: `密钥无效或没有权限（HTTP ${listing.status}）` };
  }

  const model = input.draft.models[0]?.id;
  if (!model) {
    return {
      ok: false,
      message: `无法读取模型列表：${listing.error?.slice(0, 200) ?? '未知错误'}；请先填写模型 ID`,
    };
  }
  const ping = await pingChat(baseUrl, apiKey, model);
  if (ping.ok) return { ok: true, keyWorks: true, message: `连接成功 · 密钥可用（${model} 回应正常）` };
  if (ping.status === 401 || ping.status === 403) {
    return { ok: false, keyWorks: false, message: `密钥无效或没有权限（HTTP ${ping.status}）` };
  }
  return {
    ok: false,
    message: `连接失败（HTTP ${ping.status ?? '—'}）：${(ping.error ?? '').slice(0, 240)}`,
  };
}
