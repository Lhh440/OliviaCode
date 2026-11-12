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
          <div className="field-note">
            <Icon name="folder" size={13} />
            工作区目录绑定会在 M1 落地；M0 阶段执行器只读运行，不落盘。
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
              <b>0.3.0 · M0 骨架</b>
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
              <b>M1：真实工具调用 + 事件日志</b>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
