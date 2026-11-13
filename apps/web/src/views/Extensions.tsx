import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  McpRisk,
  McpServerConfig,
  McpServerState,
  McpTransport,
  SkillInfo,
} from '@olivia/core';
import { Icon } from '../icons';
import { useStore } from '../store';

const STATUS_TEXT: Record<McpServerState['status'], string> = {
  idle: '未连接',
  connecting: '连接中',
  ready: '已连接',
  error: '连接失败',
};

const RISK_LABEL: Record<McpRisk, string> = { read: '只读', write: '写入', exec: '执行' };

interface Draft {
  name: string;
  transport: McpTransport;
  command: string;
  argsText: string;
  url: string;
  timeoutMs: string;
}

const EMPTY_DRAFT: Draft = { name: '', transport: 'stdio', command: '', argsText: '', url: '', timeoutMs: '' };

export function ExtensionsView() {
  const { state } = useStore();
  const task = state.tasks.find((item) => item.id === state.activeId) ?? null;
  const workspace = task?.workspace ?? '';

  const [configs, setConfigs] = useState<McpServerConfig[]>([]);
  const [states, setStates] = useState<Record<string, McpServerState>>({});
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [preview, setPreview] = useState<{ name: string; text: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const api = window.olivia;
    if (!api) return;
    const list = await api.mcp.list().catch(() => ({ configs: [], states: [] }));
    setConfigs(list.configs);
    setStates(Object.fromEntries(list.states.map((item) => [item.serverId, item])));
    if (!selectedId && list.configs[0]) setSelectedId(list.configs[0].id);
    if (workspace) setSkills(await api.skills.list(workspace).catch(() => []));
  }, [selectedId, workspace]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

  useEffect(() => {
    const api = window.olivia;
    if (!api) return;
    return api.mcp.onEvent((next) => {
      setStates((current) => ({ ...current, [next.serverId]: next }));
    });
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4500);
    return () => clearTimeout(timer);
  }, [notice]);

  const selected = useMemo(() => configs.find((item) => item.id === selectedId) ?? null, [configs, selectedId]);
  const selectedState = selected ? states[selected.id] : undefined;

  const saveServer = async (): Promise<void> => {
    const api = window.olivia;
    if (!api) return;
    setBusy(true);
    const args = draft.argsText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const result = await api.mcp.save({
      name: draft.name,
      transport: draft.transport,
      command: draft.transport === 'stdio' ? draft.command : undefined,
      args: draft.transport === 'stdio' ? args : undefined,
      url: draft.transport === 'http' ? draft.url : undefined,
      timeoutMs: draft.timeoutMs ? Number(draft.timeoutMs) : undefined,
    });
    setBusy(false);
    if (!result.ok) {
      setNotice(result.error ?? '保存失败');
      return;
    }
    setDraft(EMPTY_DRAFT);
    setNotice('已保存，点「连接」拉取工具');
    await load();
  };

  const act = async (label: string, run: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      await run();
      setNotice(label);
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const setRisk = async (serverId: string, tool: string, risk: McpRisk | null): Promise<void> => {
    await window.olivia?.mcp.setRisk(serverId, tool, risk);
    await load();
  };

  const installSkill = async (): Promise<void> => {
    const api = window.olivia;
    if (!api || !workspace) {
      setNotice('先给任务绑定一个工作区');
      return;
    }
    const dir = await api.skills.pick();
    if (!dir) return;
    setBusy(true);
    const result = await api.skills.install(workspace, dir);
    setBusy(false);
    setNotice(result.ok ? `已安装并启用：${result.skill?.name ?? ''}` : result.error ?? '安装失败');
    setSkills(await api.skills.list(workspace));
  };

  if (!window.olivia?.mcp) {
    return (
      <div className="ext-page">
        <header className="page-head">
          <h1>扩展</h1>
          <p>MCP 服务器与团队技能只在桌面端可用。</p>
        </header>
        <div className="ext-empty">浏览器预览里没有主进程，请用 `npm start` 打开桌面端。</div>
      </div>
    );
  }

  return (
    <div className="ext-page">
      <header className="ext-head">
        <div>
          <h1>扩展</h1>
          <p>MCP 服务器提供外部工具；团队技能把「一套做法」随仓库分享给同事。</p>
        </div>
      </header>

      {notice && (
        <div className="ext-banner">
          <Icon name="info" size={13} />
          <span>{notice}</span>
        </div>
      )}

      {/* —— MCP —— */}
      <section className="ext-section">
        <div className="ext-section-head">
          <h2>MCP 服务器</h2>
          <span className="ext-hint">勾选工具才会暴露给模型；默认一个都不勾。</span>
        </div>

        <div className="ext-grid">
          <div className="ext-list">
            {configs.length === 0 && <p className="ext-hint">还没有服务器。下面填一个命令或 URL 试试。</p>}
            {configs.map((config) => {
              const serverState = states[config.id];
              const status = serverState?.status ?? 'idle';
              const toolCount = serverState?.tools.length ?? 0;
              return (
                <button
                  key={config.id}
                  className={`ext-card ${selectedId === config.id ? 'active' : ''}`}
                  onClick={() => setSelectedId(config.id)}
                >
                  <span className={`ext-dot ${status}`} />
                  <span className="ext-card-main">
                    <b>{config.name}</b>
                    <span className="ext-card-sub">
                      {config.transport === 'stdio' ? config.command : config.url}
                      {serverState?.era ? ` · ${serverState.era === 'modern' ? '现代协议' : '传统协议'}` : ''}
                    </span>
                  </span>
                  <span className={`ext-badge ${status}`}>{STATUS_TEXT[status]}</span>
                  <span className="ext-count">{toolCount} 工具</span>
                </button>
              );
            })}
          </div>

          <div className="ext-detail">
            {selected ? (
              <>
                <div className="ext-detail-head">
                  <b>{selected.name}</b>
                  <div className="ext-actions">
                    <button className="btn" disabled={busy} onClick={() => void act('已刷新', () => window.olivia!.mcp.refresh(selected.id))}>
                      刷新
                    </button>
                    <button className="btn ghost" disabled={busy} onClick={() => void act('已断开', () => window.olivia!.mcp.disconnect(selected.id))}>
                      断开
                    </button>
                    <button
                      className="btn danger"
                      disabled={busy}
                      onClick={() => void act('已删除', async () => {
                        await window.olivia!.mcp.remove(selected.id);
                        setSelectedId(null);
                      })}
                    >
                      删除
                    </button>
                  </div>
                </div>

                {selectedState?.error && <div className="ext-error">{selectedState.error}</div>}
                {selectedState?.instructions && <p className="ext-instructions">{selectedState.instructions}</p>}
                {(selectedState?.warnings?.length ?? 0) > 0 && (
                  <ul className="ext-warnings">
                    {selectedState!.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                )}

                {selectedState?.status === 'ready' ? (
                  <div className="ext-tools">
                    {selectedState.tools.map((tool) => {
                      const risk = selectedState.risks[tool.name];
                      return (
                        <div className="ext-tool" key={tool.name}>
                          <input
                            type="checkbox"
                            checked={Boolean(risk)}
                            onChange={(event) =>
                              void setRisk(selected.id, tool.name, event.target.checked ? 'exec' : null)
                            }
                          />
                          <span className="ext-tool-name">{tool.name}</span>
                          <span className="ext-tool-desc">{tool.description ?? '（无描述）'}</span>
                          <select
                            className="input ext-risk"
                            value={risk ?? 'exec'}
                            disabled={!risk}
                            onChange={(event) => void setRisk(selected.id, tool.name, event.target.value as McpRisk)}
                          >
                            {(['read', 'write', 'exec'] as McpRisk[]).map((value) => (
                              <option key={value} value={value}>
                                {RISK_LABEL[value]}
                              </option>
                            ))}
                          </select>
                        </div>
                      );
                    })}
                    {selectedState.tools.length === 0 && <p className="ext-hint">这个服务器没有提供工具。</p>}
                  </div>
                ) : (
                  <button
                    className="btn primary"
                    disabled={busy}
                    onClick={() => void act('已连接', () => window.olivia!.mcp.connect(selected.id))}
                  >
                    连接并拉取工具
                  </button>
                )}
              </>
            ) : (
              <p className="ext-hint">选中一个服务器查看工具，或在下面添加。</p>
            )}
          </div>
        </div>

        <div className="ext-form">
          <div className="ext-form-row">
            <label className="ext-field">
              <span>名称</span>
              <input className="input" placeholder="filesystem" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label className="ext-field">
              <span>传输</span>
              <select className="input" value={draft.transport} onChange={(e) => setDraft({ ...draft, transport: e.target.value as McpTransport })}>
                <option value="stdio">stdio（本地命令）</option>
                <option value="http">Streamable HTTP</option>
              </select>
            </label>
            <label className="ext-field">
              <span>超时（ms，可选）</span>
              <input className="input" type="number" placeholder="60000" value={draft.timeoutMs} onChange={(e) => setDraft({ ...draft, timeoutMs: e.target.value })} />
            </label>
          </div>
          {draft.transport === 'stdio' ? (
            <div className="ext-form-row">
              <label className="ext-field">
                <span>启动命令</span>
                <input className="input" placeholder="npx" value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} />
              </label>
              <label className="ext-field grow">
                <span>参数（每行一个）</span>
                <textarea
                  className="input textarea"
                  rows={2}
                  placeholder={'-y\n@modelcontextprotocol/server-filesystem\nD:\\work'}
                  value={draft.argsText}
                  onChange={(e) => setDraft({ ...draft, argsText: e.target.value })}
                />
              </label>
            </div>
          ) : (
            <label className="ext-field">
              <span>URL</span>
              <input className="input" placeholder="https://example.com/mcp" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
            </label>
          )}
          <div className="ext-form-actions">
            <button className="btn primary" disabled={busy || !draft.name.trim()} onClick={() => void saveServer()}>
              添加服务器
            </button>
            <span className="ext-hint">stdio 服务器继承的环境变量只有 PATH 等最小集，不会拿到模型密钥。</span>
          </div>
        </div>
      </section>

      {/* —— 技能 —— */}
      <section className="ext-section">
        <div className="ext-section-head">
          <h2>团队技能</h2>
          <span className="ext-hint">
            {workspace ? `工作区：${workspace}` : '先给任务绑定工作区；技能随仓库提交，同事 clone 即得'}
          </span>
        </div>

        <div className="ext-skill-actions">
          <button className="btn primary" disabled={busy || !workspace} onClick={() => void installSkill()}>
            <Icon name="plus" size={13} />
            从目录安装
          </button>
          <span className="ext-hint">技能只提供指令与脚本清单，不能自带二进制；脚本仍走 run_command 的审批与围栏。</span>
        </div>

        <div className="ext-skills">
          {skills.length === 0 && <p className="ext-hint">工作区里还没有技能（`.olivia/skills/&lt;name&gt;/SKILL.md`）。</p>}
          {skills.map((skill) => (
            <div className={`ext-skill ${skill.intact ? '' : 'tampered'}`} key={`${skill.source}:${skill.name}`}>
              <div className="ext-skill-head">
                <span className="ext-skill-name">{skill.name}</span>
                <span className="ext-skill-version">v{skill.version}</span>
                <span className={`ext-badge ${skill.source === 'workspace' ? 'ready' : 'idle'}`}>
                  {skill.source === 'workspace' ? '仓库' : '个人'}
                </span>
                {!skill.intact && <span className="ext-badge error">已被修改</span>}
              </div>
              <p className="ext-skill-desc">{skill.description}</p>
              <div className="ext-skill-meta">
                {skill.requires.tools?.length ? <span>需要工具：{skill.requires.tools.join('、')}</span> : null}
                {skill.requires.mcp?.length ? <span>需要 MCP：{skill.requires.mcp.join('、')}</span> : null}
                {skill.scripts.length ? <span>{skill.scripts.length} 个脚本</span> : null}
                <span>{skill.instructionsChars} 字指令</span>
              </div>
              <div className="ext-skill-actions">
                {!skill.intact ? (
                  <button className="btn" disabled={busy} onClick={() => void act('已重新确认', () => window.olivia!.skills.confirm(workspace, skill.name))}>
                    确认当前版本
                  </button>
                ) : (
                  <label className="ext-toggle">
                    <input
                      type="checkbox"
                      checked={skill.enabled}
                      disabled={busy}
                      onChange={(event) =>
                        void act(event.target.checked ? '已启用' : '已停用', () =>
                          window.olivia!.skills.enable(workspace, skill.name, event.target.checked),
                        )
                      }
                    />
                    <span>启用</span>
                  </label>
                )}
                <button
                  className="btn ghost"
                  disabled={busy}
                  onClick={() =>
                    void window.olivia!.skills.load(workspace, skill.name).then((result) => {
                      setPreview({ name: skill.name, text: result.ok ? result.text ?? '' : result.error ?? '加载失败' });
                    })
                  }
                >
                  查看指令
                </button>
                {skill.source === 'workspace' && (
                  <button className="btn danger" disabled={busy} onClick={() => void act('已删除', () => window.olivia!.skills.uninstall(workspace, skill.name))}>
                    删除
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {preview && (
        <div className="ext-modal-backdrop" onClick={() => setPreview(null)}>
          <div className="ext-modal" onClick={(event) => event.stopPropagation()}>
            <header>
              <b>{preview.name}</b>
              <button className="btn ghost" onClick={() => setPreview(null)}>
                关闭
              </button>
            </header>
            <pre>{preview.text}</pre>
          </div>
        </div>
      )}
    </div>
  );
}