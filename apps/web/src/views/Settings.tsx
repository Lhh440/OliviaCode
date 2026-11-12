import { APPROVALS, MODELS, type ApprovalMode } from '@olivia/core';
import { Icon } from '../icons';
import { useStore } from '../store';

export function SettingsView() {
  const { state, dispatch } = useStore();
  const settings = state.settings;
  const update = (patch: Partial<typeof settings>) => dispatch({ type: 'settings', patch });

  return (
    <div className="settings-page">
      <header className="page-head">
        <h1>设置</h1>
        <p>模型端点、执行策略与本地数据。密钥只留在内存里。</p>
      </header>

      <div className="settings-body">
        <section className="card">
          <div className="card-head">
            <span className="card-glyph">
              <Icon name="cpu" size={16} />
            </span>
            <div>
              <h2>模型接入</h2>
              <p>任何 OpenAI 兼容端点都能接，请求从本机直接发出。</p>
            </div>
          </div>

          <label className="field">
            <span className="field-label">Base URL</span>
            <input
              className="input"
              value={settings.baseUrl}
              spellCheck={false}
              placeholder="https://api.deepseek.com/v1"
              onChange={(event) => update({ baseUrl: event.target.value })}
            />
          </label>

          <label className="field">
            <span className="field-label">API Key</span>
            <input
              className="input"
              type="password"
              value={settings.apiKey}
              spellCheck={false}
              placeholder="sk-…"
              onChange={(event) => update({ apiKey: event.target.value })}
            />
          </label>

          <p className="field-note">
            <Icon name="shield" size={13} />
            密钥只保存在本次会话的内存中，不写磁盘、不进日志。关掉应用即失效。
          </p>

          <label className="field">
            <span className="field-label">默认模型</span>
            <select
              className="input"
              value={settings.model}
              onChange={(event) => update({ model: event.target.value })}
            >
              {MODELS.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          </label>

          <div className="settings-state">
            {settings.apiKey.trim() ? (
              <span className="state-pill on">
                <Icon name="check" size={12} />
                已配置，对话将走真实模型
              </span>
            ) : (
              <span className="state-pill">
                <Icon name="sparkle" size={12} />
                未配置密钥，当前是脚本回放的演示模式
              </span>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <span className="card-glyph">
              <Icon name="shield" size={16} />
            </span>
            <div>
              <h2>执行与审批</h2>
              <p>决定工具在你机器上敢做多少事。策略由执行器强制，UI 绕不过去。</p>
            </div>
          </div>
          <div className="approval-cards">
            {APPROVALS.map((option) => (
              <button
                key={option.value}
                className={`approval-card ${settings.approval === option.value ? 'on' : ''}`}
                onClick={() => update({ approval: option.value as ApprovalMode })}
              >
                <b>{option.label}</b>
                <span>{option.hint}</span>
              </button>
            ))}
          </div>

          <div className="field">
            <span className="field-label">命令执行（run_command）</span>
            {settings.allowShell ? (
              <button
                className="shell-toggle on"
                onClick={() => update({ allowShell: false })}
                title="关闭后所有命令都会被执行器拒绝"
              >
                <Icon name="check" size={14} />
                已开启 · 点此关闭
              </button>
            ) : (
              <button
                className="shell-toggle"
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
                <Icon name="terminal" size={14} />
                开启命令执行（需要确认风险）
              </button>
            )}
            <p className="field-note">
              <Icon name="shield" size={13} />
              默认关闭。关闭时模型读写文件仍然可用，但所有命令都会被拒绝。
            </p>
          </div>

          <div className="field-note">
            <Icon name="folder" size={13} />
            工作区是按任务绑定的：在对话头部点「绑定目录」选一次，之后这个任务只在该目录内读写。
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <span className="card-glyph">
              <Icon name="layers" size={16} />
            </span>
            <div>
              <h2>关于</h2>
              <p>本地优先的 AI 编程工作站。</p>
            </div>
          </div>
          <div className="about-rows">
            <div className="about-row">
              <span>版本</span>
              <b>0.4.0 · M1 工具闭环</b>
            </div>
            <div className="about-row">
              <span>运行形态</span>
              <b>{typeof window !== 'undefined' && 'olivia' in window ? 'Electron 桌面端' : '浏览器预览'}</b>
            </div>
            <div className="about-row">
              <span>仓库</span>
              <b>gitcode.com/Olivia0703/OliviaCode</b>
            </div>
            <div className="about-row">
              <span>下一步</span>
              <b>M2：多步回滚与逐 hunk 接受</b>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
