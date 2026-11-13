import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { APPROVALS, MODELS, type ApprovalMode, type GitProvider, type VaultStatus } from '@olivia/core';
import { Icon } from '../icons';
import { useStore } from '../store';

function Section({
  icon,
  title,
  desc,
  children,
}: {
  icon: string;
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="rounded-2xl border border-light-line dark:border-dark-line bg-light-panel dark:bg-dark-panel backdrop-blur-xl p-5"
    >
      <div className="flex items-start gap-3 mb-4">
        <span className="w-8 h-8 shrink-0 rounded-lg grid place-items-center border border-light-accent/20 dark:border-dark-gold/25 bg-light-accent/[0.08] dark:bg-dark-gold/[0.08] text-light-accent dark:text-dark-gold">
          <Icon name={icon} size={15} />
        </span>
        <div className="min-w-0">
          <h2 className="font-serif text-[14.5px] font-semibold leading-tight text-light-ink dark:text-dark-ink">
            {title}
          </h2>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-light-inkMuted dark:text-dark-inkMuted">{desc}</p>
        </div>
      </div>
      <div className="space-y-4">{children}</div>
    </motion.section>
  );
}

function Field({ label, note, children }: { label: string; note?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block mb-1.5 text-[10px] tracking-[0.14em] uppercase text-light-inkFaint dark:text-dark-inkFaint">
        {label}
      </span>
      {children}
      {note && (
        <span className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-light-inkFaint dark:text-dark-inkFaint">
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

  useEffect(() => {
    void window.olivia?.vault.status().then(setVault);
  }, []);

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
      <div className="max-w-2xl mx-auto px-7 py-8">
        <motion.header
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-7"
        >
          <h1 className="text-[26px] font-semibold leading-tight text-light-ink dark:text-dark-ink">设置</h1>
          <p className="mt-1.5 text-[12.5px] text-light-inkMuted dark:text-dark-inkMuted">
            模型端点、执行策略与本地数据。密钥只留在内存里。
          </p>
          <div className="mt-4 h-px w-20 rule-ornate" />
        </motion.header>

        <div className="space-y-3.5">
          {/* 模型接入 */}
          <Section
            icon="cpu"
            title="模型接入"
            desc="任何 OpenAI 兼容端点都能接，请求从本机直接发出。"
          >
            <Field label="Base URL">
              <input
                className="field-input font-mono text-[12px]"
                value={settings.baseUrl}
                spellCheck={false}
                placeholder="https://api.deepseek.com/v1"
                onChange={(event) => update({ baseUrl: event.target.value })}
              />
            </Field>

            <Field
              label="API Key"
              note="密钥只保存在本次会话的内存中，不写磁盘、不进日志。关掉应用即失效。"
            >
              <input
                className="field-input font-mono text-[12px]"
                type="password"
                value={settings.apiKey}
                spellCheck={false}
                placeholder="sk-…"
                onChange={(event) => update({ apiKey: event.target.value })}
              />
            </Field>

            <Field label="默认模型">
              <select
                className="field-select"
                value={settings.model}
                onChange={(event) => update({ model: event.target.value })}
              >
                {MODELS.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
            </Field>

            <div>
              {settings.apiKey.trim() ? (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11.5px] bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                  <Icon name="check" size={12} />
                  已配置，对话将走真实模型
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11.5px] bg-amber-500/10 text-amber-700 dark:text-amber-300">
                  <Icon name="sparkle" size={12} />
                  未配置密钥，当前是脚本回放的演示模式
                </span>
              )}
            </div>
          </Section>

          {/* 执行与审批 */}
          <Section
            icon="shield"
            title="执行与审批"
            desc="决定工具在你机器上敢做多少事。策略由执行器强制，UI 绕不过去。"
          >
            <div className="grid gap-1.5">
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
                      <b className="text-[12.5px] font-medium text-light-ink dark:text-dark-ink">{option.label}</b>
                    </span>
                    <span className="block mt-1 pl-5.5 text-[11px] leading-relaxed text-light-inkMuted dark:text-dark-inkMuted">
                      {option.hint}
                    </span>
                  </button>
                );
              })}
            </div>

            <div>
              <span className="block mb-1.5 text-[10px] tracking-[0.14em] uppercase text-light-inkFaint dark:text-dark-inkFaint">
                命令执行（run_command）
              </span>
              {settings.allowShell ? (
                <button
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/25 hover:bg-emerald-500/15 transition-colors"
                  onClick={() => update({ allowShell: false })}
                  title="关闭后所有命令都会被执行器拒绝"
                >
                  <Icon name="check" size={13} />
                  已开启 · 点此关闭
                </button>
              ) : (
                <button
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] border border-amber-500/30 bg-amber-500/[0.07] text-amber-700 dark:text-amber-300 hover:bg-amber-500/[0.12] transition-colors"
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
              <p className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-light-inkFaint dark:text-dark-inkFaint">
                <Icon name="shield" size={11} className="mt-[3px] shrink-0" />
                <span>默认关闭。关闭时模型读写文件仍然可用，但所有命令都会被拒绝。</span>
              </p>
            </div>

            <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-light-inkFaint dark:text-dark-inkFaint">
              <Icon name="folder" size={11} className="mt-[3px] shrink-0" />
              <span>
                工作区是按任务绑定的：在对话头部点「绑定目录」选一次，之后这个任务只在该目录内读写。
              </span>
            </p>
          </Section>

          {/* Git 凭据 */}
          <Section
            icon="key"
            title="Git 凭据"
            desc="用于推送与创建 PR。safeStorage 加密存在本机，只在主进程读取。"
          >
            {(['gitcode', 'github'] as GitProvider[]).map((provider) => (
              <div key={provider} className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-[12.5px] font-medium text-light-ink dark:text-dark-ink">
                    {provider === 'github' ? 'GitHub' : 'GitCode'}
                  </span>
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded ${
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
                    className="field-input flex-1 font-mono text-[12px]"
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
            <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-light-inkFaint dark:text-dark-inkFaint">
              <Icon name="shield" size={11} className="mt-[3px] shrink-0" />
              <span>
                界面上只能覆盖或清除，读不回原文；也不会写进仓库的 .git/config。
                {vaultNotice ? ` · ${vaultNotice}` : ''}
              </span>
            </p>
          </Section>

          {/* 关于 */}
          <Section icon="layers" title="关于" desc="本地优先的 AI 编程工作站。">
            <div className="divide-y divide-light-line dark:divide-dark-line">
              {[
                { label: '版本', value: '0.5.0 · M2+M3' },
                {
                  label: '运行形态',
                  value: typeof window !== 'undefined' && 'olivia' in window ? 'Electron 桌面端' : '浏览器预览',
                },
                { label: '仓库', value: 'gitcode.com/Olivia0703/OliviaCode' },
                { label: '下一步', value: 'M4：多智能体并行与工作流真实执行' },
              ].map((row) => (
                <div key={row.label} className="flex items-center justify-between gap-4 py-2 first:pt-0 last:pb-0">
                  <span className="text-[11.5px] text-light-inkMuted dark:text-dark-inkMuted">{row.label}</span>
                  <span className="text-[11.5px] font-medium text-right text-light-ink dark:text-dark-ink">
                    {row.value}
                  </span>
                </div>
              ))}
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
