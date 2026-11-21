import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  GATE_MODE_LABEL,
  RUN_STATUS_LABEL,
  describeCron,
  formatZoned,
  type RunRecord,
  type ScheduleRecord,
  type UnattendedPolicy,
} from '@olivia/core';
import { Icon } from '../icons';
import { useStore } from '../store';
import { loadWorkflow } from './Workflow';

const STATUS_TONE: Record<string, string> = {
  done: 'ok',
  failed: 'bad',
  running: 'run',
  skipped: 'muted',
  canceled: 'muted',
  interrupted: 'bad',
};

function duration(from: number, to?: number, now = Date.now()): string {
  const end = to ?? now;
  const seconds = Math.max(0, Math.round((end - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export function SchedulesView() {
  const { state } = useStore();
  const activeTask = state.tasks.find((task) => task.id === state.activeId) ?? null;
  const workspace = activeTask?.workspace ?? '';

  const [schedules, setSchedules] = useState<ScheduleRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [preview, setPreview] = useState<number[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [policy, setPolicy] = useState<UnattendedPolicy | null>(null);
  const [mode, setMode] = useState<ScheduleRecord['mode']>('report');
  const [confirming, setConfirming] = useState<ScheduleRecord | null>(null);
  const [modelSaved, setModelSaved] = useState<boolean | null>(null);
  const [mcpServers, setMcpServers] = useState<{ id: string; name: string }[]>([]);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  const selected = useMemo(
    () => schedules.find((item) => item.id === selectedId) ?? null,
    [schedules, selectedId],
  );

  const loadHistory = useCallback(async (id: string | null): Promise<void> => {
    const api = window.olivia?.schedules;
    if (!api || !id) {
      setRuns([]);
      setPreview([]);
      return;
    }
    const [history, times] = await Promise.all([
      api.runs(id).catch(() => []),
      api.preview(id).catch(() => []),
    ]);
    setRuns(history);
    setPreview(times);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    const api = window.olivia?.schedules;
    if (!api) return;
    const next = await api.list().catch(() => []);
    setSchedules(next);
    if (!selectedRef.current && next[0]) setSelectedId(next[0].id);
    if (selectedRef.current) {
      await loadHistory(selectedRef.current);
      const current = next.find((item) => item.id === selectedRef.current);
      if (current) {
        setPolicy(current.policy);
        setMode(current.mode);
      }
    }
  }, [loadHistory]);

  /** 打开页面时把当前画布的触发器同步给调度器，保证列表是最新的。 */
  const sync = useCallback(async (): Promise<void> => {
    const api = window.olivia?.schedules;
    if (!api) return;
    const result = await api.sync({ workflow: loadWorkflow(), workspace }).catch(() => null);
    if (!result) return;
    if (!result.ok) setNotice(result.error ?? '同步失败');
    else if (result.invalid?.length) setNotice(result.invalid.join('；'));
    else if (result.created?.length) setNotice(`新增计划：${result.created.join('、')}`);
  }, [workspace]);

  useEffect(() => {
    void (async () => {
      await sync();
      await load();
    })();
    void window.olivia?.vault.modelStatus().then((status) => setModelSaved(status.saved));
    void window.olivia?.mcp
      ?.list()
      .then(({ configs }) =>
        setMcpServers(configs.filter((item) => item.enabled).map((item) => ({ id: item.id, name: item.name }))),
      )
      .catch(() => undefined);
  }, [sync, load]);

  useEffect(() => {
    const api = window.olivia?.schedules;
    if (!api) return;
    const off = api.onEvent((event) => {
      const type = (event as { type?: string })?.type;
      if (type === 'run.start' || type === 'run.end' || type === 'schedule.changed') void load();
    });
    return off;
  }, [load]);

  useEffect(() => {
    if (!selected) return;
    setPolicy(selected.policy);
    setMode(selected.mode);
    void loadHistory(selected.id);
  }, [selected?.id, loadHistory]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const toggle = async (record: ScheduleRecord): Promise<void> => {
    const api = window.olivia?.schedules;
    if (!api) return;
    if (!record.enabled) {
      setConfirming(record);
      return;
    }
    setBusy(true);
    const result = await api.update(record.id, { enabled: false });
    setBusy(false);
    if (!result.ok) setNotice(result.error ?? '取消失败');
    await load();
  };

  const confirmEnable = async (): Promise<void> => {
    const api = window.olivia?.schedules;
    const record = confirming;
    if (!api || !record) return;
    setBusy(true);
    const result = await api.update(record.id, { enabled: true });
    setBusy(false);
    setConfirming(null);
    if (!result.ok) setNotice(result.error ?? '启用失败');
    else setNotice(`已启用：${record.workflowName}`);
    await load();
  };

  const runNow = async (record: ScheduleRecord): Promise<void> => {
    const api = window.olivia?.schedules;
    if (!api) return;
    setBusy(true);
    setNotice(`正在运行「${record.workflowName}」…`);
    const result = await api.runNow(record.id);
    setBusy(false);
    setNotice(result.ok ? '运行完成，报告已生成' : `运行结束：${result.error ?? '失败'}`);
    await load();
  };

  const savePolicy = async (): Promise<void> => {
    const api = window.olivia?.schedules;
    if (!api || !selected || !policy) return;
    setBusy(true);
    const result = await api.update(selected.id, { policy, mode });
    setBusy(false);
    setNotice(result.ok ? '策略已保存' : result.error ?? '保存失败');
    await load();
  };

  const openReport = async (run: RunRecord): Promise<void> => {
    if (!run.reportPath) {
      setNotice('这次运行没有报告');
      return;
    }
    const result = await window.olivia?.schedules.openReport(run.reportPath);
    if (!result?.ok) setNotice(result?.error ?? '打不开报告');
  };

  if (!window.olivia?.schedules) {
    return (
      <div className="sch-page">
        <header className="page-head">
          <h1>计划</h1>
          <p>定时任务只在桌面端可用。</p>
        </header>
        <div className="sch-empty">浏览器预览里没有调度器，请用 `npm start` 打开桌面端。</div>
      </div>
    );
  }

  return (
    <div className="sch-page">
      <header className="sch-head">
        <div className="sch-head-text">
          <h1>计划</h1>
          <p>到点自动运行工作流；无人值守时按这里的预算与审批门策略执行。</p>
        </div>
        <div className="sch-head-actions">
          <button className="btn" onClick={() => void sync().then(load)}>
            重新同步画布
          </button>
        </div>
      </header>

      {modelSaved === false && (
        <div className="sch-banner">
          <Icon name="shield" size={13} />
          <span>
            还没有保存无人值守用的模型密钥：到「设置 → 无人值守凭据」保存，或预置 `OLIVIA_API_KEY`，否则计划会在预检阶段失败。
          </span>
        </div>
      )}

      {notice && (
        <div className="sch-banner info">
          <Icon name="info" size={13} />
          <span>{notice}</span>
        </div>
      )}

      {schedules.length === 0 ? (
        <div className="sch-empty">
          画布上还没有带时间的触发器。到「工作流」页拖入「定时触发器」并填上 cron，再回来。
        </div>
      ) : (
        <div className="sch-body">
          <div className="sch-list">
            {schedules.map((record) => {
              const active = record.id === selectedId;
              return (
                <div
                  key={record.id}
                  className={`sch-card ${active ? 'active' : ''} ${record.enabled ? '' : 'off'}`}
                  onClick={() => setSelectedId(record.id)}
                >
                  <div className="sch-card-top">
                    <button
                      className={`sch-switch ${record.enabled ? 'on' : ''}`}
                      title={record.enabled ? '暂停' : '启用'}
                      disabled={busy}
                      onClick={(event) => {
                        event.stopPropagation();
                        void toggle(record);
                      }}
                    >
                      <span />
                    </button>
                    <div className="sch-card-title">
                      <b>{record.workflowName}</b>
                      <span className="sch-cron">{describeCron(record.cron)} · {record.timezone}</span>
                    </div>
                    <span className={`sch-state ${STATUS_TONE[record.lastStatus ?? ''] ?? 'muted'}`}>
                      {record.lastStatus ? RUN_STATUS_LABEL[record.lastStatus] : '还没跑过'}
                    </span>
                  </div>
                  <div className="sch-card-meta">
                    <span>
                      下次 <b>{record.enabled ? formatZoned(record.nextRunAt, record.timezone) : '已暂停'}</b>
                    </span>
                    <span>上次 {formatZoned(record.lastRunAt, record.timezone)}</span>
                    <span>{record.mode === 'report-pr' ? '报告 + PR' : '仅报告'}</span>
                    <span className="sch-ws" title={record.workspace}>
                      {record.workspace || '未绑定工作区'}
                    </span>
                  </div>
                  <div className="sch-card-actions">
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={(event) => {
                        event.stopPropagation();
                        void runNow(record);
                      }}
                    >
                      <Icon name="play" size={12} />
                      立即运行
                    </button>
                    <button
                      className="btn ghost"
                      disabled={!record.enabled}
                      onClick={(event) => {
                        event.stopPropagation();
                        window.olivia?.schedules.cancel(record.id);
                        setNotice('已请求取消');
                      }}
                    >
                      取消
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {selected && policy && (
            <aside className="sch-detail">
              <header className="sch-detail-head">
                <b>{selected.workflowName}</b>
                <span>{describeCron(selected.cron)} · {selected.timezone}</span>
              </header>

              <section className="sch-section">
                <h3>接下来</h3>
                <ul className="sch-times">
                  {preview.length === 0 && <li>cron 不合法或 400 天内没有下一次</li>}
                  {preview.map((at) => (
                    <li key={at}>{formatZoned(at, selected.timezone)}</li>
                  ))}
                </ul>
              </section>

              <section className="sch-section">
                <h3>结果</h3>
                <label className="sch-field">
                  <span>产出方式</span>
                  <select className="input" value={mode} onChange={(event) => setMode(event.target.value as ScheduleRecord['mode'])}>
                    <option value="report">仅报告（结果分支留在本地）</option>
                    <option value="report-pr">报告 + 推送并开 PR</option>
                  </select>
                </label>
              </section>

              <section className="sch-section">
                <h3>无人值守策略</h3>
                <label className="sch-field">
                  <span>审批门</span>
                  <select
                    className="input"
                    value={policy.gate}
                    onChange={(event) =>
                      setPolicy({ ...policy, gate: event.target.value as UnattendedPolicy['gate'] })
                    }
                  >
                    {(['pause-and-notify', 'auto-approve', 'auto-reject'] as const).map((value) => (
                      <option key={value} value={value}>
                        {GATE_MODE_LABEL[value]}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="sch-grid2">
                  <label className="sch-field">
                    <span>门等待（分钟）</span>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={1440}
                      value={policy.gateTimeout}
                      onChange={(event) => setPolicy({ ...policy, gateTimeout: Number(event.target.value) })}
                    />
                  </label>
                  <label className="sch-field">
                    <span>墙钟上限（分钟）</span>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={1440}
                      value={policy.maxWallMinutes}
                      onChange={(event) => setPolicy({ ...policy, maxWallMinutes: Number(event.target.value) })}
                    />
                  </label>
                  <label className="sch-field">
                    <span>节点数上限</span>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={500}
                      value={policy.maxNodes}
                      onChange={(event) => setPolicy({ ...policy, maxNodes: Number(event.target.value) })}
                    />
                  </label>
                  <label className="sch-field">
                    <span>步数上限</span>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={1000}
                      value={policy.maxSteps}
                      onChange={(event) => setPolicy({ ...policy, maxSteps: Number(event.target.value) })}
                    />
                  </label>
                  <label className="sch-field">
                    <span>token 上限（输入+输出）</span>
                    <input
                      className="input"
                      type="number"
                      min={1000}
                      max={100000000}
                      step={1000}
                      value={policy.maxTokens ?? 1000000}
                      onChange={(event) => setPolicy({ ...policy, maxTokens: Number(event.target.value) })}
                    />
                  </label>
                  <label className="sch-field">
                    <span>参考费用上限（美元，0 = 不设）</span>
                    <input
                      className="input"
                      type="number"
                      min={0}
                      max={10000}
                      step={0.1}
                      value={policy.maxCost ?? 0}
                      onChange={(event) => setPolicy({ ...policy, maxCost: Number(event.target.value) })}
                    />
                  </label>
                </div>
                <div className="sch-field">
                  <span>允许的 MCP 服务器（无人值守）</span>
                  {mcpServers.length === 0 ? (
                    <p className="sch-hint">没有已启用的 MCP 服务器；去「扩展」页添加。</p>
                  ) : (
                    <div className="sch-mcp-list">
                      {mcpServers.map((server) => {
                        const allowed = (policy.allowedMcpServers ?? []).includes(server.id);
                        return (
                          <label key={server.id} className="sch-mcp">
                            <input
                              type="checkbox"
                              checked={allowed}
                              onChange={(event) =>
                                setPolicy({
                                  ...policy,
                                  allowedMcpServers: event.target.checked
                                    ? [...(policy.allowedMcpServers ?? []), server.id]
                                    : (policy.allowedMcpServers ?? []).filter((id) => id !== server.id),
                                })
                              }
                            />
                            <span>{server.name || server.id}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                  <p className="sch-hint">默认全不选：没人看着的时候，MCP 工具一律不可用。</p>
                </div>
                <p className="sch-hint">任一上限触发即判定失败并停止，不会推送、不会开 PR。</p>
                <button className="btn primary" disabled={busy} onClick={() => void savePolicy()}>
                  保存策略
                </button>
              </section>

              <section className="sch-section">
                <h3>运行历史</h3>
                {runs.length === 0 && <p className="sch-hint">还没有运行记录。可以点「立即运行」试一次。</p>}
                <div className="sch-runs">
                  {runs.map((run) => (
                    <div key={run.id} className="sch-run">
                      <span className={`sch-dot ${STATUS_TONE[run.status] ?? 'muted'}`} />
                      <span className="sch-run-time">{formatZoned(run.startedAt, selected.timezone)}</span>
                      <span className={`sch-run-state ${STATUS_TONE[run.status] ?? 'muted'}`}>
                        {RUN_STATUS_LABEL[run.status]}
                      </span>
                      <span className="sch-run-dur">{duration(run.startedAt, run.endedAt)}</span>
                      {run.usage && run.usage.steps > 0 && (
                        <span
                          className="sch-run-dur"
                          title={`输入 ${run.usage.input} · 输出 ${run.usage.output}${
                            run.usage.costUsd !== undefined ? ` · 参考费用 $${run.usage.costUsd.toFixed(4)}` : ''
                          }`}
                        >
                          {Math.round((run.usage.input + run.usage.output) / 1000)}k tok
                        </span>
                      )}
                      {run.missed ? <span className="sch-run-missed">错过 {run.missed}</span> : null}
                      {run.reportPath && (
                        <button className="link-btn" onClick={() => void openReport(run)}>
                          报告
                        </button>
                      )}
                      {run.prUrl && (
                        <a className="link-btn" href={run.prUrl} target="_blank" rel="noreferrer">
                          PR
                        </a>
                      )}
                      {run.error && <span className="sch-run-error" title={run.error}>{run.error}</span>}
                    </div>
                  ))}
                </div>
              </section>
            </aside>
          )}
        </div>
      )}

      {confirming && (
        <div className="sch-modal-backdrop" onClick={() => setConfirming(null)}>
          <div className="sch-modal" onClick={(event) => event.stopPropagation()}>
            <h2>启用「{confirming.workflowName}」的定时运行？</h2>
            <p>启用后，它会在你不看着的时候：</p>
            <ul>
              <li>在 <code>{confirming.workspace || '（未绑定工作区）'}</code> 里改代码，每次写入前自动快照</li>
              <li>按「{GATE_MODE_LABEL[confirming.policy.gate]}」处理合并前的审批门</li>
              <li>
                {confirming.mode === 'report-pr'
                  ? '成功后推送结果分支并创建 PR'
                  : '只把结果留在本地分支，不推送'}
              </li>
              <li>单次最多跑 {confirming.policy.maxWallMinutes} 分钟；超限自动停止并出失败报告</li>
            </ul>
            <p className="sch-hint">
              应用关掉时不会触发；重新打开后，错过的只补跑最近一次。
            </p>
            <div className="sch-modal-actions">
              <button className="btn ghost" onClick={() => setConfirming(null)}>
                再想想
              </button>
              <button className="btn primary" disabled={busy} onClick={() => void confirmEnable()}>
                确认启用
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}