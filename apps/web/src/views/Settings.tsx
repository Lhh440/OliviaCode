import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  APPROVALS,
  MODELS,
  type ApprovalMode,
  type GitProvider,
  type ModelPricing,
  type PricingFile,
  type ProviderConfig,
  type VaultStatus,
} from '@olivia/core';
import { Icon } from '../icons';
import { SelectMenu } from '../components/SelectMenu';
import { ProviderDialog } from '../components/ProviderDialog';
import { useProviders } from '../hooks/useProviders';
import { useStore } from '../store';

const SETTINGS_NAV = [
  { id: 'model', icon: 'cpu', label: '模型接入' },
  { id: 'usage', icon: 'layers', label: '用量与价格' },
  { id: 'execution', icon: 'shield', label: '执行与审批' },
  { id: 'unattended', icon: 'clock', label: '无人值守凭据' },
  { id: 'git', icon: 'key', label: 'Git 凭据' },
  { id: 'about', icon: 'info', label: '关于' },
] as const;

interface PriceDraft {
  contextWindow: string;
  inPerM: string;
  outPerM: string;
  cachedInPerM: string;
}

function Section({
  icon,
  title,
  desc,
  children,
  id,
}: {
  icon: string;
  title: string;
  desc: string;
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <motion.section
      id={id}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="scroll-mt-6 rounded-2xl border border-light-line dark:border-dark-line bg-light-panelStrong dark:bg-dark-panelStrong p-5"
    >
      <div className="flex items-start gap-3 mb-4">
        <span className="w-8 h-8 shrink-0 rounded-lg grid place-items-center border border-light-accent/20 dark:border-dark-gold/25 bg-light-accent/[0.08] dark:bg-dark-gold/[0.08] text-light-accent dark:text-dark-gold">
          <Icon name={icon} size={15} />
        </span>
        <div className="min-w-0">
          <h2 className="text-[16px] font-semibold leading-tight tracking-tight text-light-ink dark:text-dark-ink">
            {title}
          </h2>
          <p className="mt-0.5 text-[13px] leading-relaxed text-light-inkMuted dark:text-dark-inkMuted">{desc}</p>
        </div>
      </div>
      <div className="space-y-4">{children}</div>
    </motion.section>
  );
}

function Field({ label, note, children }: { label: string; note?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block mb-1.5 text-[11px] tracking-[0.14em] uppercase text-light-inkFaint dark:text-dark-inkFaint">
        {label}
      </span>
      {children}
      {note && (
        <span className="mt-1.5 flex items-start gap-1.5 text-[12.5px] leading-relaxed text-light-inkFaint dark:text-dark-inkFaint">
          <Icon name="shield" size={11} className="mt-[3px] shrink-0" />
          <span>{note}</span>
        </span>
      )}
    </label>
  );
}

export function SettingsView() {
  const { state, dispatch } = useStore();
  const settings = state.settings;
  const update = (patch: Partial<typeof settings>) => dispatch({ type: 'settings', patch });

  const [vault, setVault] = useState<VaultStatus>({ gitcode: false, github: false });
  const [tokens, setTokens] = useState<Record<GitProvider, string>>({ gitcode: '', github: '' });
  const [vaultNotice, setVaultNotice] = useState<string | null>(null);
  const [modelStatus, setModelStatus] = useState<{ saved: boolean; baseUrl: string; model: string }>({
    saved: false,
    baseUrl: '',
    model: '',
  });
  const [modelDraft, setModelDraft] = useState({
    baseUrl: '',
    apiKey: '',
    model: 'deepseek-v4.1-flash',
  });
  const [modelNotice, setModelNotice] = useState<string | null>(null);

  const { providers, refresh: refreshProviders } = useProviders();
  const [providerDialog, setProviderDialog] = useState<{ editing: ProviderConfig | null } | null>(null);
  const [providerNotice, setProviderNotice] = useState<string | null>(null);
  const [providerBusy, setProviderBusy] = useState<string | null>(null);

  const toggleProvider = async (provider: ProviderConfig): Promise<void> => {
    if (!window.olivia?.provider) return;
    setProviderBusy(provider.id);
    try {
      const result = await window.olivia.provider.enable(provider.id, !provider.enabled);
      setProviderNotice(
        result.ok
          ? `已${provider.enabled ? '停用' : '启用'}「${provider.name}」`
          : result.error ?? '操作失败',
      );
      await refreshProviders();
    } finally {
      setProviderBusy(null);
    }
  };

  const removeProvider = async (provider: ProviderConfig): Promise<void> => {
    if (!window.olivia?.provider) return;
    if (!window.confirm(`删除提供商「${provider.name}」？密钥也会一起清除。`)) return;
    setProviderBusy(provider.id);
    try {
      const result = await window.olivia.provider.remove(provider.id);
      setProviderNotice(result.ok ? `已删除「${provider.name}」` : result.error ?? '删除失败');
      await refreshProviders();
    } finally {
      setProviderBusy(null);
    }
  };

  const pricingBridge = window.olivia?.pricing;
  const [pricingFile, setPricingFile] = useState<PricingFile | null>(null);
  const [prices, setPrices] = useState<Record<string, PriceDraft>>(() => {
    const next: Record<string, PriceDraft> = {};
    for (const model of MODELS) {
      next[model.id] = {
        contextWindow: String(model.contextWindow),
        inPerM: model.pricing ? String(model.pricing.inPerM) : '',
        outPerM: model.pricing ? String(model.pricing.outPerM) : '',
        cachedInPerM: model.pricing?.cachedInPerM !== undefined ? String(model.pricing.cachedInPerM) : '',
      };
    }
    return next;
  });
  const [defaultWindow, setDefaultWindow] = useState(String(settings.defaultContextWindow));
  const [priceNotice, setPriceNotice] = useState<string | null>(null);

  function applyPricing(file: PricingFile): void {
    setPricingFile(file);
    setDefaultWindow(String(file.defaultContextWindow));
    const next: Record<string, PriceDraft> = {};
    for (const model of MODELS) {
      const override = file.models[model.id];
      const price = override?.pricing ?? model.pricing;
      next[model.id] = {
        contextWindow: String(override?.contextWindow ?? model.contextWindow),
        inPerM: price ? String(price.inPerM) : '',
        outPerM: price ? String(price.outPerM) : '',
        cachedInPerM: price?.cachedInPerM !== undefined ? String(price.cachedInPerM) : '',
      };
    }
    setPrices(next);
  }

  useEffect(() => {
    if (!pricingBridge) return;
    void pricingBridge.get().then(applyPricing).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const savePrice = async (id: string): Promise<void> => {
    const draft = prices[id];
    if (!draft || !pricingBridge) return;
    const number = (value: string): number => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    };
    const contextWindow = Number(draft.contextWindow);
    const pricing: ModelPricing = {
      inPerM: number(draft.inPerM),
      outPerM: number(draft.outPerM),
      cachedInPerM: draft.cachedInPerM.trim() ? number(draft.cachedInPerM) : undefined,
      currency: 'USD',
      updatedAt: new Date().toISOString().slice(0, 10),
      source: 'user',
    };
    const file = await pricingBridge.setModel({
      id,
      contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : undefined,
      pricing,
    });
    applyPricing(file);
    setPriceNotice('已保存；金额会按新价格实时重算');
  };

  const resetPrice = async (id: string): Promise<void> => {
    if (!pricingBridge) return;
    applyPricing(await pricingBridge.resetModel(id));
    setPriceNotice('已恢复内置参考价');
  };

  const saveWindow = async (): Promise<void> => {
    if (!pricingBridge) return;
    applyPricing(await pricingBridge.setWindow(Number(defaultWindow)));
    setPriceNotice('默认窗口已保存');
  };

  const resetPricing = async (): Promise<void> => {
    if (!pricingBridge) return;
    applyPricing(await pricingBridge.reset());
    setPriceNotice('已恢复全部内置值');
  };

  const exportUsage = async (): Promise<void> => {
    const records = (await window.olivia?.usage.list(30)) ?? [];
    const header = ['at', 'taskId', 'turnId', 'model', 'step', 'input', 'output', 'cached', 'source'];
    const body = records.map((record) =>
      [
        new Date(record.at).toISOString(),
        record.taskId,
        record.turnId,
        record.model,
        record.step,
        record.input,
        record.output,
        record.cached ?? '',
        record.source,
      ]
        .map((value) => `"${String(value).replace(/"/g, '""')}"`)
        .join(','),
    );
    const blob = new Blob([[header.join(','), ...body].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'olivia-usage.csv';
    anchor.click();
    URL.revokeObjectURL(url);
    setPriceNotice(`已导出 ${records.length} 条用量记录`);
  };

  const clearUsage = async (): Promise<void> => {
    await window.olivia?.usage.clear();
    setPriceNotice('用量账本已清空');
  };

  const clearPreviewData = async (): Promise<void> => {
    await window.olivia?.preview.clearData();
    setPriceNotice('预览会话数据已清除');
  };

  const clearMemories = async (): Promise<void> => {
    await window.olivia?.memory.clearAll();
    setPriceNotice('所有任务记忆与检查点已清空；会话原文不受影响');
  };

  useEffect(() => {
    void window.olivia?.vault.status().then(setVault);
    void window.olivia?.vault.modelStatus().then((status) => setModelStatus(status));
  }, []);

  const saveModel = async (): Promise<void> => {
    const api = window.olivia;
    if (!api) return;
    const result = await api.vault.setModel({
      baseUrl: modelDraft.baseUrl || modelStatus.baseUrl,
      apiKey: modelDraft.apiKey,
      model: modelDraft.model,
    });
    setModelNotice(result.ok ? '已加密保存，无人值守运行会用它' : result.message ?? '保存失败');
    if (result.ok) {
      setModelDraft((current) => ({ ...current, apiKey: '' }));
      setModelStatus(await api.vault.modelStatus());
    }
  };

  const clearModel = async (): Promise<void> => {
    await window.olivia?.vault.clearModel();
    setModelStatus(await window.olivia!.vault.modelStatus());
    setModelNotice('已清除；无人值守运行会回退到环境变量，没有则预检失败');
  };

  const saveToken = async (provider: GitProvider): Promise<void> => {
    const api = window.olivia;
    if (!api) return;
    const result = await api.vault.set(provider, tokens[provider]);
    setVaultNotice(result.ok ? '已加密保存' : result.message ?? '保存失败');
    if (result.ok) {
      setTokens((current) => ({ ...current, [provider]: '' }));
      setVault(await api.vault.status());
    }
  };

  const clearToken = async (provider: GitProvider): Promise<void> => {
    const api = window.olivia;
    if (!api) return;
    await api.vault.clear(provider);
    setVault(await api.vault.status());
    setVaultNotice('已清除');
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-7 py-8">
        <motion.header
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-7"
        >
          <h1 className="text-[29px] font-semibold leading-tight text-light-ink dark:text-dark-ink">设置</h1>
          <p className="mt-1.5 text-[14px] text-light-inkMuted dark:text-dark-inkMuted">
            模型端点、执行策略与本地数据。提供商密钥加密存在本机保险箱。
          </p>
          <div className="mt-4 h-px w-20 rule-ornate" />
        </motion.header>

        <div className="grid grid-cols-1 lg:grid-cols-[190px_minmax(0,1fr)] gap-6 items-start">
          <nav className="hidden lg:block sticky top-2 rounded-2xl border border-light-line/90 dark:border-dark-line bg-light-panelStrong dark:bg-dark-panelStrong p-2.5">
            <div className="space-y-0.5">
              {SETTINGS_NAV.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() =>
                    document.getElementById(item.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }
                  className="w-full flex items-center gap-2.5 h-8 px-2.5 rounded-lg text-[13px] text-left text-light-inkMuted dark:text-dark-inkMuted hover:text-light-ink dark:hover:text-dark-ink hover:bg-white/60 dark:hover:bg-white/[0.06] transition-colors"
                >
                  <Icon name={item.icon} size={13} className="shrink-0 opacity-80" />
                  {item.label}
                </button>
              ))}
            </div>
            <p className="mt-3 pt-3 px-1 border-t border-light-line/80 dark:border-dark-line/80 text-[11.5px] leading-relaxed text-light-inkFaint dark:text-dark-inkFaint">
              密钥只写入内存或保险箱；价格与用量账本落在本机应用数据目录。
            </p>
          </nav>

          <div className="space-y-3.5 min-w-0">
          {/* 模型接入 */}
          <Section
            id="model"
            icon="cpu"
            title="模型接入"
            desc="管理提供商与模型目录。密钥加密存在本机，界面只写不读。"
          >
            {!window.olivia?.provider && (
              <p className="text-[12.5px] leading-relaxed text-amber-600 dark:text-amber-300">
                浏览器开发模式没有主进程，无法保存提供商；请在桌面端配置。
              </p>
            )}

            {providers.length === 0 ? (
              <div className="rounded-xl border border-dashed border-light-lineStrong dark:border-dark-lineStrong px-4 py-6 text-center">
                <Icon name="cpu" size={18} className="mx-auto mb-2 text-light-inkFaint dark:text-dark-inkFaint" />
                <p className="text-[13.5px] text-light-inkMuted dark:text-dark-inkMuted">
                  还没有提供商。添加一个 OpenAI Chat Completions 兼容端点，
                  <br />
                  再获取或手动添加模型。
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {providers.map((provider) => (
                  <div
                    key={provider.id}
                    className={`rounded-xl border px-3.5 py-3 transition-colors ${
                      provider.enabled
                        ? 'border-light-line dark:border-dark-line bg-white/40 dark:bg-white/[0.03]'
                        : 'border-light-line/60 dark:border-dark-line/60 bg-black/[0.02] dark:bg-white/[0.015] opacity-70'
                    }`}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[14px] font-medium text-light-ink dark:text-dark-ink">
                        {provider.name}
                      </span>
                      <span className="text-[11px] px-1.5 py-0.5 rounded font-mono bg-black/[0.05] dark:bg-white/[0.07] text-light-inkFaint dark:text-dark-inkFaint">
                        {provider.id}
                      </span>
                      <span
                        className={`text-[11px] px-1.5 py-0.5 rounded ${
                          provider.hasKey
                            ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                            : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                        }`}
                      >
                        {provider.hasKey ? '密钥已保存' : '缺 API Key'}
                      </span>
                      {!provider.enabled && (
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-black/[0.05] dark:bg-white/[0.07] text-light-inkFaint dark:text-dark-inkFaint">
                          已停用
                        </span>
                      )}
                      <span className="flex-1" />
                      <button
                        type="button"
                        className="btn-ghost h-7 px-2"
                        disabled={providerBusy === provider.id}
                        onClick={() => void toggleProvider(provider)}
                      >
                        {provider.enabled ? '停用' : '启用'}
                      </button>
                      <button
                        type="button"
                        className="btn-ghost h-7 px-2"
                        onClick={() => setProviderDialog({ editing: provider })}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="btn-ghost h-7 px-2 text-red-600 dark:text-red-300"
                        disabled={providerBusy === provider.id}
                        onClick={() => void removeProvider(provider)}
                      >
                        删除
                      </button>
                    </div>
                    <div className="mt-1.5 flex items-center gap-3 text-[12px] text-light-inkFaint dark:text-dark-inkFaint min-w-0">
                      <span className="font-mono truncate">{provider.baseUrl || '未填 API 地址'}</span>
                      <span className="shrink-0">·</span>
                      <span className="shrink-0">{provider.models.length} 个模型</span>
                      <span className="shrink-0">·</span>
                      <span className="shrink-0">{provider.protocol === 'openai-chat' ? 'OpenAI Chat' : provider.protocol}</span>
                    </div>
                    {provider.models.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {provider.models.slice(0, 8).map((model) => (
                          <span
                            key={model.id}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11.5px] bg-black/[0.04] dark:bg-white/[0.06] text-light-inkMuted dark:text-dark-inkMuted"
                            title={model.label || model.id}
                          >
                            <span className="font-mono truncate max-w-[160px]">{model.label || model.id}</span>
                            {model.vision && <Icon name="paperclip" size={9} />}
                          </span>
                        ))}
                        {provider.models.length > 8 && (
                          <span className="text-[11.5px] text-light-inkFaint dark:text-dark-inkFaint">
                            +{provider.models.length - 8}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn-outline h-8 px-3"
                onClick={() => setProviderDialog({ editing: null })}
                disabled={!window.olivia?.provider}
              >
                <Icon name="plus" size={13} />
                添加提供商
              </button>
              {providerNotice && (
                <span className="text-[12.5px] text-light-inkFaint dark:text-dark-inkFaint">{providerNotice}</span>
              )}
            </div>
            <p className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-light-inkFaint dark:text-dark-inkFaint">
              <Icon name="shield" size={11} className="mt-[3px] shrink-0" />
              <span>
                API Key 由 safeStorage 加密保存，只在主进程读取；对话与工作流共用这份目录，
                定时任务仍走下方「无人值守凭据」。模型目录里每个模型可以单独打开「支持图片」。
              </span>
            </p>
          </Section>

          {/* 用量与价格 */}
          <Section
            id="usage"
            icon="layers"
            title="用量与价格"
            desc="对话与工作流按端点 usage 记账；价格只是参考，可以在这里覆盖。账本不含对话内容。"
          >
            {!pricingBridge && (
              <p className="text-[12.5px] leading-relaxed text-amber-600 dark:text-amber-300">
                浏览器开发模式没有主进程，这里只读展示内置参考价；保存、导出与清理由桌面端提供。
              </p>
            )}

            <div>
              <span className="block mb-1.5 text-[11px] tracking-[0.14em] uppercase text-light-inkFaint dark:text-dark-inkFaint">
                未知模型的上下文窗口
              </span>
              <div className="flex gap-2">
                <input
                  className="field-input"
                  value={defaultWindow}
                  inputMode="numeric"
                  onChange={(event) => setDefaultWindow(event.target.value)}
                  disabled={!pricingBridge}
                />
                <button
                  type="button"
                  className="btn-outline h-10 px-4 shrink-0"
                  onClick={() => void saveWindow()}
                  disabled={!pricingBridge}
                >
                  保存
                </button>
              </div>
            </div>

            <div>
              <span className="block mb-1.5 text-[11px] tracking-[0.14em] uppercase text-light-inkFaint dark:text-dark-inkFaint">
                自动整理上下文
              </span>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={70}
                  max={95}
                  step={1}
                  value={settings.compactThreshold}
                  onChange={(event) => update({ compactThreshold: Number(event.target.value) })}
                  className="flex-1 accent-[var(--olivia-accent)]"
                />
                <span className="w-12 text-right text-[13px] font-medium tabular-nums text-light-ink dark:text-dark-ink">
                  {settings.compactThreshold}%
                </span>
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-light-inkFaint dark:text-dark-inkFaint">
                对话窗口用到这个比例时，回合结束后自动把旧回合整理成任务记忆；界面历史不变。
              </p>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            {MODELS.map((model) => {
              const draft = prices[model.id];
              if (!draft) return null;
              const overridden = pricingFile?.models[model.id];
              return (
                <div
                  key={model.id}
                  className="rounded-xl border border-light-line/80 dark:border-dark-line bg-white/40 dark:bg-white/[0.03] p-3 space-y-2.5"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[13.5px] font-medium text-light-ink dark:text-dark-ink">
                      {model.label}
                    </span>
                    <span className="text-[11.5px] text-light-inkFaint dark:text-dark-inkFaint">
                      每百万 token · USD
                    </span>
                    {overridden?.pricing && (
                      <span className="ml-auto text-[11px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400">
                        已覆盖
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {(
                      [
                        ['contextWindow', '窗口'],
                        ['inPerM', '输入'],
                        ['outPerM', '输出'],
                        ['cachedInPerM', '缓存'],
                      ] as const
                    ).map(([key, label]) => (
                      <label key={key} className="block">
                        <span className="block mb-1 text-[11px] text-light-inkFaint dark:text-dark-inkFaint">
                          {label}
                        </span>
                        <input
                          className="w-full h-8 rounded-md border border-light-line dark:border-dark-line bg-white/60 dark:bg-white/[0.04] px-2 text-[12.5px] font-mono text-light-ink dark:text-dark-ink outline-none focus:border-light-accent/50 dark:focus:border-dark-accent/50"
                          value={draft[key]}
                          inputMode="decimal"
                          disabled={!pricingBridge}
                          onChange={(event) =>
                            setPrices((current) => ({
                              ...current,
                              [model.id]: { ...current[model.id]!, [key]: event.target.value },
                            }))
                          }
                        />
                      </label>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="btn-outline h-8 px-3"
                      onClick={() => void savePrice(model.id)}
                      disabled={!pricingBridge}
                    >
                      保存
                    </button>
                    <button
                      type="button"
                      className="btn-ghost h-8"
                      onClick={() => void resetPrice(model.id)}
                      disabled={!pricingBridge}
                    >
                      恢复内置
                    </button>
                  </div>
                </div>
              );
            })}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn-outline h-8 px-3"
                onClick={() => void exportUsage()}
                disabled={!window.olivia?.usage}
              >
                导出账本 CSV
              </button>
              <button
                type="button"
                className="btn-ghost h-8"
                onClick={() => void clearUsage()}
                disabled={!window.olivia?.usage}
              >
                清理账本
              </button>
              <button
                type="button"
                className="btn-ghost h-8"
                onClick={() => void clearPreviewData()}
                disabled={!window.olivia?.preview}
              >
                清除预览数据
              </button>
              <button
                type="button"
                className="btn-ghost h-8"
                onClick={() => void clearMemories()}
                disabled={!window.olivia?.memory}
              >
                清空所有任务记忆
              </button>
              <button
                type="button"
                className="btn-ghost h-8"
                onClick={() => void resetPricing()}
                disabled={!pricingBridge}
              >
                全部恢复内置
              </button>
            </div>
            {priceNotice && (
              <p className="text-[12.5px] text-emerald-600 dark:text-emerald-400">{priceNotice}</p>
            )}
          </Section>

          {/* 执行与审批 */}
          <Section
            id="execution"
            icon="shield"
            title="执行与审批"
            desc="决定工具在你机器上敢做多少事。策略由执行器强制，UI 绕不过去。"
          >
            <div className="grid gap-2 md:grid-cols-3">
              {APPROVALS.map((option) => {
                const on = settings.approval === option.value;
                return (
                  <button
                    key={option.value}
                    onClick={() => update({ approval: option.value as ApprovalMode })}
                    className={`relative w-full text-left px-3 py-2.5 rounded-xl border transition-all duration-200 ${
                      on
                        ? 'border-light-accent/50 dark:border-dark-accent/50 bg-light-accent/[0.07] dark:bg-dark-accent/[0.09]'
                        : 'border-light-line dark:border-dark-line bg-white/40 dark:bg-white/[0.03] hover:bg-white/70 dark:hover:bg-white/[0.06]'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className={`w-3.5 h-3.5 shrink-0 rounded-full border grid place-items-center ${
                          on
                            ? 'border-light-accent dark:border-dark-accent'
                            : 'border-light-lineStrong dark:border-dark-lineStrong'
                        }`}
                      >
                        {on && <span className="w-1.5 h-1.5 rounded-full bg-light-accent dark:bg-dark-accent" />}
                      </span>
                      <b className="text-[14px] font-medium text-light-ink dark:text-dark-ink">{option.label}</b>
                    </span>
                    <span className="block mt-1 pl-5.5 text-[12.5px] leading-relaxed text-light-inkMuted dark:text-dark-inkMuted">
                      {option.hint}
                    </span>
                  </button>
                );
              })}
            </div>

            <div>
              <span className="block mb-1.5 text-[11px] tracking-[0.14em] uppercase text-light-inkFaint dark:text-dark-inkFaint">
                命令执行（run_command）
              </span>
              {settings.allowShell ? (
                <button
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[13.5px] bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/25 hover:bg-emerald-500/15 transition-colors"
                  onClick={() => update({ allowShell: false })}
                  title="关闭后所有命令都会被执行器拒绝"
                >
                  <Icon name="check" size={13} />
                  已开启 · 点此关闭
                </button>
              ) : (
                <button
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[13.5px] border border-amber-500/30 bg-amber-500/[0.07] text-amber-700 dark:text-amber-300 hover:bg-amber-500/[0.12] transition-colors"
                  onClick={() => {
                    const ok = window.confirm(
                      [
                        '开启后，模型可以在你绑定的工作区里执行命令（例如 npm test、git status）。',
                        '',
                        '命令以参数数组启动、不经过 shell 拼接，但仍可能修改文件、安装依赖或访问网络。',
                        '每次执行依然会按上面的审批策略询问你。',
                        '',
                        '确定开启吗？',
                      ].join('\n'),
                    );
                    if (ok) update({ allowShell: true });
                  }}
                >
                  <Icon name="terminal" size={13} />
                  开启命令执行（需要确认风险）
                </button>
              )}
              <p className="mt-1.5 flex items-start gap-1.5 text-[12.5px] leading-relaxed text-light-inkFaint dark:text-dark-inkFaint">
                <Icon name="shield" size={11} className="mt-[3px] shrink-0" />
                <span>默认关闭。关闭时模型读写文件仍然可用，但所有命令都会被拒绝。</span>
              </p>
            </div>

            <p className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-light-inkFaint dark:text-dark-inkFaint">
              <Icon name="folder" size={11} className="mt-[3px] shrink-0" />
              <span>
                工作区是按任务绑定的：在对话头部点「绑定目录」选一次，之后这个任务只在该目录内读写。
              </span>
            </p>
          </Section>

          {/* 无人值守凭据 */}
          <Section
            id="unattended"
            icon="clock"
            title="无人值守凭据"
            desc="只给定时任务用：没人看着的时候也要能调模型，所以需要单独一份加密 Key。日常对话与工作流用上面的「模型接入（提供商）」，两边互不影响。"
          >
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-medium text-light-ink dark:text-dark-ink">模型接入</span>
              <span
                className={`text-[11px] px-1.5 py-0.5 rounded ${
                  modelStatus.saved
                    ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                    : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                }`}
              >
                {modelStatus.saved ? `已保存 · ${modelStatus.model}` : '未保存 · 回退环境变量'}
              </span>
            </div>
            <Field label="Base URL" note={modelStatus.saved ? `当前：${modelStatus.baseUrl}` : undefined}>
              <input
                className="field-input font-mono text-[13.5px]"
                value={modelDraft.baseUrl}
                spellCheck={false}
                placeholder={modelStatus.baseUrl || 'https://api.deepseek.com/v1'}
                onChange={(event) =>
                  setModelDraft((current) => ({ ...current, baseUrl: event.target.value }))
                }
              />
            </Field>
            <Field label="API Key" note="只写不读；不填表示保留已存的那份。">
              <input
                className="field-input font-mono text-[13.5px]"
                type="password"
                value={modelDraft.apiKey}
                spellCheck={false}
                placeholder="sk-…"
                onChange={(event) =>
                  setModelDraft((current) => ({ ...current, apiKey: event.target.value }))
                }
              />
            </Field>
            <Field label="模型">
              <SelectMenu
                value={modelDraft.model}
                options={MODELS.map((item) => ({ value: item.id, label: item.label }))}
                onChange={(next) => setModelDraft((current) => ({ ...current, model: next }))}
                className="w-full"
                title="模型"
                ariaLabel="模型"
                buttonClassName="w-full flex items-center justify-between gap-2 h-10 px-3 rounded-lg border border-light-line dark:border-dark-line bg-white/55 dark:bg-white/[0.05] text-[13.5px] text-light-ink dark:text-dark-ink hover:bg-white/75 dark:hover:bg-white/[0.08] transition-colors"
              />
            </Field>
            <div className="flex items-center gap-1.5">
              <button className="btn-solid" disabled={!modelDraft.apiKey.trim()} onClick={() => void saveModel()}>
                保存
              </button>
              <button className="btn-ghost" disabled={!modelStatus.saved} onClick={() => void clearModel()}>
                清除
              </button>
              {modelNotice && (
                <span className="text-[12.5px] text-light-inkFaint dark:text-dark-inkFaint">{modelNotice}</span>
              )}
            </div>
            <p className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-light-inkFaint dark:text-dark-inkFaint">
              <Icon name="shield" size={11} className="mt-[3px] shrink-0" />
              <span>
                定时任务会按「计划」页的预算与审批门策略执行；这份凭据只给主进程的调度器用，渲染层拿不到明文。
              </span>
            </p>
          </Section>

          {/* Git 凭据 */}
          <Section
            id="git"
            icon="key"
            title="Git 凭据"
            desc="用于推送与创建 PR。safeStorage 加密存在本机，只在主进程读取。"
          >
            {(['gitcode', 'github'] as GitProvider[]).map((provider) => (
              <div key={provider} className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-medium text-light-ink dark:text-dark-ink">
                    {provider === 'github' ? 'GitHub' : 'GitCode'}
                  </span>
                  <span
                    className={`text-[11px] px-1.5 py-0.5 rounded ${
                      vault[provider]
                        ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                        : 'bg-black/[0.05] dark:bg-white/[0.07] text-light-inkFaint dark:text-dark-inkFaint'
                    }`}
                  >
                    {vault[provider] ? '已保存' : '未保存'}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <input
                    className="field-input flex-1 font-mono text-[13.5px]"
                    type="password"
                    spellCheck={false}
                    placeholder="粘贴访问令牌（只写不读）"
                    value={tokens[provider]}
                    onChange={(event) =>
                      setTokens((current) => ({ ...current, [provider]: event.target.value }))
                    }
                  />
                  <button
                    className="btn-solid"
                    disabled={!tokens[provider].trim()}
                    onClick={() => void saveToken(provider)}
                  >
                    保存
                  </button>
                  <button
                    className="btn-ghost"
                    disabled={!vault[provider]}
                    onClick={() => void clearToken(provider)}
                  >
                    清除
                  </button>
                </div>
              </div>
            ))}
            <p className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-light-inkFaint dark:text-dark-inkFaint">
              <Icon name="shield" size={11} className="mt-[3px] shrink-0" />
              <span>
                界面上只能覆盖或清除，读不回原文；也不会写进仓库的 .git/config。
                {vaultNotice ? ` · ${vaultNotice}` : ''}
              </span>
            </p>
          </Section>

          {/* 关于 */}
          <Section id="about" icon="layers" title="关于" desc="本地优先的 AI 编程工作站。">
            <div className="divide-y divide-light-line dark:divide-dark-line">
              {[
                { label: '版本', value: '0.10.0 · M8 · 记忆、图片与提供商' },
                {
                  label: '运行形态',
                  value: typeof window !== 'undefined' && 'olivia' in window ? 'Electron 桌面端' : '浏览器预览',
                },
                { label: '仓库', value: 'gitcode.com/Olivia0703/OliviaCode' },
                { label: '下一步', value: 'M8.5：MCP resources / prompts 浏览与引用' },
              ].map((row) => (
                <div key={row.label} className="flex items-center justify-between gap-4 py-2 first:pt-0 last:pb-0">
                  <span className="text-[13px] text-light-inkMuted dark:text-dark-inkMuted">{row.label}</span>
                  <span className="text-[13px] font-medium text-right text-light-ink dark:text-dark-ink">
                    {row.value}
                  </span>
                </div>
              ))}
            </div>
          </Section>
          </div>
        </div>
      </div>

      {providerDialog && (
        <ProviderDialog
          key={providerDialog.editing?.id ?? 'new'}
          editing={providerDialog.editing}
          onCancel={() => setProviderDialog(null)}
          onSaved={() => {
            setProviderDialog(null);
            setProviderNotice(
              providerDialog.editing
                ? `已保存「${providerDialog.editing.name}」`
                : '提供商已创建；到 Composer 的模型菜单里选择它',
            );
            void refreshProviders();
          }}
        />
      )}
    </div>
  );
}
