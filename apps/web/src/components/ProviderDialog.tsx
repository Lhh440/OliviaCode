import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  PROVIDER_PROTOCOLS,
  validateProviderDraft,
  type ProviderConfig,
  type ProviderDraft,
  type ProviderModel,
  type ProviderProtocol,
} from '@olivia/core';
import { Icon } from '../icons';
import { SelectMenu } from './SelectMenu';

export interface ProviderDialogProps {
  editing?: ProviderConfig | null;
  onCancel: () => void;
  onSaved: (providers: ProviderConfig[]) => void;
}

function initialDraft(editing?: ProviderConfig | null): ProviderDraft {
  return {
    id: editing?.id ?? '',
    name: editing?.name ?? '',
    baseUrl: editing?.baseUrl ?? '',
    protocol: editing?.protocol ?? 'openai-chat',
    enabled: editing?.enabled ?? true,
    apiKey: '',
    models: editing ? editing.models.map((model) => ({ ...model })) : [],
  };
}

const ID_HINT = '小写字母开头，可用小写字母、数字、下划线与连字符';

/**
 * 图片 1 的提供商创建/编辑对话框：
 * Provider ID / 显示名称 / API 地址 / API 协议 / API 密钥 / 模型目录。
 * 模型目录支持从端点「获取可用模型」，也支持手动添加。
 */
export function ProviderDialog({ editing, onCancel, onSaved }: ProviderDialogProps) {
  const [draft, setDraft] = useState<ProviderDraft>(() => initialDraft(editing));
  const [busy, setBusy] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const bridge = window.olivia?.provider;
  const hasSavedKey = Boolean(editing?.hasKey);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const patch = (value: Partial<ProviderDraft>): void => {
    setDraft((current) => ({ ...current, ...value }));
    // 改了字段就把上一条错误收掉：填好了还挂着「先填 API 地址」只会让人以为没填对
    setError(null);
  };

  const updateModel = (index: number, value: Partial<ProviderModel>): void => {
    setDraft((current) => ({
      ...current,
      models: current.models.map((model, at) => (at === index ? { ...model, ...value } : model)),
    }));
    setError(null);
  };

  const addModel = (): void => {
    setDraft((current) => ({ ...current, models: [...current.models, { id: '', label: undefined, vision: false }] }));
    setNotice(null);
  };

  const removeModel = (index: number): void => {
    setDraft((current) => ({ ...current, models: current.models.filter((_model, at) => at !== index) }));
  };

  const fetchModels = async (): Promise<void> => {
    if (!bridge) {
      setError('浏览器预览没有主进程，无法连接端点；请在桌面端操作');
      return;
    }
    if (!draft.baseUrl.trim()) {
      setError('先填 API 地址');
      return;
    }
    setFetching(true);
    setError(null);
    setNotice(null);
    try {
      const result = await bridge.fetchModels({
        providerId: editing?.id,
        baseUrl: draft.baseUrl.trim(),
        apiKey: (draft.apiKey ?? '').trim() || undefined,
      });
      if (!result.ok) {        setError(result.error ?? '获取模型失败');
        return;
      }
      const known = new Set(draft.models.map((model) => model.id.trim()).filter(Boolean));
      const incoming = (result.models ?? []).filter((id) => !known.has(id));
      if (incoming.length > 0) {
        setDraft((current) => ({
          ...current,
          models: [...current.models, ...incoming.map((id) => ({ id, vision: false }))],
        }));
      }
      setNotice(
        incoming.length > 0
          ? `已获取 ${incoming.length} 个模型，已加入目录`
          : result.models?.length
            ? `端点返回 ${result.models.length} 个模型，目录里都有了`
            : '端点没有返回模型列表，可以手动添加',
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setFetching(false);
    }
  };

  const save = async (): Promise<void> => {
    const normalized: ProviderDraft = {
      ...draft,
      id: draft.id.trim(),
      name: draft.name.trim(),
      baseUrl: draft.baseUrl.trim(),
      apiKey: (draft.apiKey ?? '').trim() || undefined,
      models: draft.models
        .map((model) => ({
          ...model,
          id: model.id.trim(),
          label: model.label?.trim() || undefined,
        }))
        .filter((model) => model.id),
    };
    const invalid = validateProviderDraft(normalized);
    if (invalid) {
      setError(invalid);
      return;
    }
    if (!bridge) {
      setError('浏览器预览没有主进程，无法保存；请在桌面端操作');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await bridge.save(normalized);
      if (!result.ok || !result.providers) {
        setError(result.error ?? '保存失败');
        return;
      }
      onSaved(result.providers);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-black/55 backdrop-blur-sm p-5"
      role="dialog"
      aria-modal="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: 14, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-2xl max-h-[88vh] flex flex-col rounded-2xl border border-light-line dark:border-dark-line bg-light-panelStrong dark:bg-dark-panelStrong shadow-2xl overflow-hidden"
      >
        <div className="flex items-start gap-3 px-5 pt-4 pb-3 border-b border-light-line/70 dark:border-dark-line/70">
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] font-semibold leading-tight text-light-ink dark:text-dark-ink">
              {editing ? '编辑提供商' : '添加提供商'}
            </h2>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-light-inkMuted dark:text-dark-inkMuted">
              任何 OpenAI Chat Completions 兼容端点都能接；密钥加密存在本机。
            </p>
          </div>
          <button type="button" className="btn-ghost h-7 w-7 px-0" onClick={onCancel} title="关闭">
            <Icon name="x" size={13} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 space-y-3.5">
          <div className="grid gap-3 sm:grid-cols-[1fr_1.4fr]">
            <label className="block">
              <span className="block mb-1.5 text-[11px] tracking-[0.14em] uppercase text-light-inkFaint dark:text-dark-inkFaint">
                Provider ID
              </span>
              <input
                className="field-input font-mono text-[13.5px] disabled:opacity-60"
                value={draft.id}
                spellCheck={false}
                disabled={Boolean(editing)}
                placeholder="my-gateway"
                onChange={(event) => patch({ id: event.target.value })}
              />
              <span className="mt-1 block text-[11.5px] leading-relaxed text-light-inkFaint dark:text-dark-inkFaint">
                {ID_HINT}
              </span>
            </label>
            <label className="block">
              <span className="block mb-1.5 text-[11px] tracking-[0.14em] uppercase text-light-inkFaint dark:text-dark-inkFaint">
                显示名称
              </span>
              <input
                className="field-input text-[13.5px]"
                value={draft.name}
                placeholder="例如：公司网关"
                onChange={(event) => patch({ name: event.target.value })}
              />
            </label>
          </div>

          <label className="block">
            <span className="block mb-1.5 text-[11px] tracking-[0.14em] uppercase text-light-inkFaint dark:text-dark-inkFaint">
              API 地址
            </span>
            <input
              className="field-input font-mono text-[13.5px]"
              value={draft.baseUrl}
              spellCheck={false}
              placeholder="https://api.example.com/v1"
              onChange={(event) => patch({ baseUrl: event.target.value })}
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <span className="block mb-1.5 text-[11px] tracking-[0.14em] uppercase text-light-inkFaint dark:text-dark-inkFaint">
                API 协议
              </span>
              <SelectMenu
                value={draft.protocol}
                options={PROVIDER_PROTOCOLS.map((item) => ({ value: item.value, label: item.label }))}
                onChange={(value) => patch({ protocol: value as ProviderProtocol })}
                className="w-full"
                title="API 协议"
                ariaLabel="API 协议"
                buttonClassName="w-full flex items-center justify-between gap-2 h-10 px-3 rounded-lg border border-light-line dark:border-dark-line bg-white/55 dark:bg-white/[0.05] text-[13.5px] text-light-ink dark:text-dark-ink hover:bg-white/75 dark:hover:bg-white/[0.08] transition-colors"
              />
            </div>
            <label className="block">
              <span className="block mb-1.5 text-[11px] tracking-[0.14em] uppercase text-light-inkFaint dark:text-dark-inkFaint">
                API 密钥
              </span>
              <input
                className="field-input font-mono text-[13.5px]"
                type="password"
                value={draft.apiKey}
                spellCheck={false}
                placeholder={hasSavedKey ? '已保存；留空表示保留' : 'sk-…'}
                onChange={(event) => patch({ apiKey: event.target.value })}
              />
            </label>
          </div>
          <p className="text-[11.5px] leading-relaxed text-light-inkFaint dark:text-dark-inkFaint flex items-start gap-1.5 -mt-1">
            <Icon name="shield" size={11} className="mt-[3px] shrink-0" />
            <span>密钥只写不读，加密保存在本机；界面只显示「已保存 / 未保存」。</span>
          </p>

          <div className="rounded-xl border border-light-line/80 dark:border-dark-line overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2.5 bg-black/[0.025] dark:bg-white/[0.03] border-b border-light-line/70 dark:border-dark-line/70">
              <span className="text-[13px] font-medium text-light-ink dark:text-dark-ink">模型目录</span>
              <span className="text-[11.5px] text-light-inkFaint dark:text-dark-inkFaint">
                {draft.models.length} 个模型
              </span>
              <span className="flex-1" />
              <button
                type="button"
                className="btn-outline h-8 px-3"
                onClick={() => void fetchModels()}
                disabled={fetching || busy}
              >
                {fetching ? '获取中…' : '获取可用模型'}
              </button>
            </div>

            <div className="max-h-64 overflow-y-auto">
              {draft.models.length === 0 ? (
                <p className="px-3 py-5 text-[12.5px] text-center text-light-inkFaint dark:text-dark-inkFaint">
                  还没有模型。点「获取可用模型」从端点读取，或手动添加。
                </p>
              ) : (
                <div className="divide-y divide-light-line/60 dark:divide-dark-line/60">
                  {draft.models.map((model, index) => (
                    <div key={`model-${index}`} className="grid grid-cols-[1.4fr_1fr_72px_auto_auto] gap-2 items-center px-3 py-2">
                      <label className="min-w-0">
                        <span className="block mb-1 text-[10.5px] text-light-inkFaint dark:text-dark-inkFaint">模型 ID</span>
                        <input
                          className="w-full h-8 rounded-md border border-light-line dark:border-dark-line bg-white/60 dark:bg-white/[0.04] px-2 text-[12.5px] font-mono text-light-ink dark:text-dark-ink outline-none focus:border-light-accent/50 dark:focus:border-dark-accent/50"
                          value={model.id}
                          spellCheck={false}
                          placeholder="gpt-4o"
                          onChange={(event) => updateModel(index, { id: event.target.value })}
                        />
                      </label>
                      <label className="min-w-0">
                        <span className="block mb-1 text-[10.5px] text-light-inkFaint dark:text-dark-inkFaint">显示名</span>
                        <input
                          className="w-full h-8 rounded-md border border-light-line dark:border-dark-line bg-white/60 dark:bg-white/[0.04] px-2 text-[12.5px] text-light-ink dark:text-dark-ink outline-none focus:border-light-accent/50 dark:focus:border-dark-accent/50"
                          value={model.label ?? ''}
                          placeholder="可选"
                          onChange={(event) => updateModel(index, { label: event.target.value })}
                        />
                      </label>
                      <label className="min-w-0">
                        <span className="block mb-1 text-[10.5px] text-light-inkFaint dark:text-dark-inkFaint">窗口</span>
                        <input
                          className="w-full h-8 rounded-md border border-light-line dark:border-dark-line bg-white/60 dark:bg-white/[0.04] px-2 text-[12px] font-mono text-light-ink dark:text-dark-ink outline-none focus:border-light-accent/50 dark:focus:border-dark-accent/50"
                          value={model.contextWindow ?? ''}
                          inputMode="numeric"
                          placeholder="默认"
                          onChange={(event) => {
                            const value = Number(event.target.value);
                            updateModel(index, {
                              contextWindow:
                                Number.isFinite(value) && value > 0 ? Math.round(value) : undefined,
                            });
                          }}
                        />
                      </label>
                      <label
                        className="flex items-center gap-1.5 text-[12px] text-light-inkMuted dark:text-dark-inkMuted pt-4"
                        title="打开后这个模型会接收图片；图片会发送到该端点"
                      >
                        <input
                          type="checkbox"
                          className="accent-current"
                          checked={Boolean(model.vision)}
                          onChange={(event) => updateModel(index, { vision: event.target.checked })}
                        />
                        支持图片
                      </label>
                      <button
                        type="button"
                        className="btn-ghost h-7 w-7 px-0 mt-4 justify-self-end"
                        title="移除这个模型"
                        onClick={() => removeModel(index)}
                      >
                        <Icon name="x" size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 px-3 py-2 border-t border-light-line/70 dark:border-dark-line/70">
              <button type="button" className="btn-ghost h-8" onClick={addModel} disabled={busy}>
                <Icon name="plus" size={12} />
                添加模型
              </button>
              <span className="flex-1" />
              <span className="text-[11px] text-light-inkFaint dark:text-dark-inkFaint">
                图片开关默认关闭；关闭时 Composer 不允许附图
              </span>
            </div>
          </div>

          {error && (
            <p className="text-[12.5px] rounded-lg px-2.5 py-1.5 bg-red-500/10 text-red-600 dark:text-red-300">
              {error}
            </p>
          )}
          {notice && (
            <p className="text-[12.5px] rounded-lg px-2.5 py-1.5 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
              {notice}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 px-5 py-3 border-t border-light-line/70 dark:border-dark-line/70 bg-black/[0.02] dark:bg-white/[0.02]">
          <button type="button" className="btn-outline h-9 px-4" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <span className="flex-1" />
          <button type="button" className="btn-solid h-9 px-4" onClick={() => void save()} disabled={busy}>
            {busy ? '保存中…' : editing ? '保存修改' : '创建提供商'}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
