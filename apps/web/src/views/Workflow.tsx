import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  NODE_W,
  makeNode,
  phaseToNodeStatus,
  seedWorkflow,
  topoOrder,
  uid,
  type NodeKind,
  type WfNode,
  type Workflow,
  type RunPhase,
  type WorkflowRunEvent,
  type WorkflowRunState,
} from '@olivia/core';
import { Icon } from '../icons';
import { useStore } from '../store';
import { Canvas, type CanvasHandle } from '../workflow/Canvas';
import { Inspector } from '../workflow/Inspector';
import { Library } from '../workflow/Library';
import { RunPanel, type GatePrompt } from '../workflow/RunPanel';

const STORAGE_KEY = 'olivia.workflow.v1';

const KIND_TEXT: Record<NodeKind, { title: string; subtitle: string }> = {
  trigger: { title: '定时触发器', subtitle: '触发器' },
  agent: { title: '新 Agent', subtitle: 'Worker · 待配置' },
  reviewer: { title: '评审节点', subtitle: 'Reviewer · 干净上下文' },
  gate: { title: '审批门', subtitle: 'Policy · 合并前确认' },
  output: { title: '产出', subtitle: 'Output · 提 PR' },
};

export function loadWorkflow(): Workflow {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Workflow;
      if (parsed && Array.isArray(parsed.nodes)) return parsed;
    }
  } catch {
    // 忽略损坏的本地草稿
  }
  return seedWorkflow();
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function WorkflowView() {
  const { state: store } = useStore();
  const activeTask = store.tasks.find((task) => task.id === store.activeId) ?? null;
  const workspace = activeTask?.workspace ?? '';
  const initial = useMemo(loadWorkflow, []);
  const [wf, setWf] = useState<Workflow>(initial);
  const [selectedId, setSelectedId] = useState<string | null>(
    () => initial.nodes.find((node) => node.title === '页面与交互')?.id ?? null,
  );
  const [zoom, setZoom] = useState(1);
  const [runState, setRunState] = useState<'idle' | 'running' | 'waiting' | 'done'>('idle');
  const [toast, setToast] = useState<string | null>(null);
  const [runInfo, setRunInfo] = useState<WorkflowRunState | null>(null);
  const [gate, setGate] = useState<GatePrompt | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [confirmReset, setConfirmReset] = useState(false);
  /** M6：已连接的 MCP 服务器，节点可以整台放行 */
  const [mcpServers, setMcpServers] = useState<string[]>([]);

  const canvasRef = useRef<CanvasHandle>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const approvedRef = useRef(false);
  const cursorRef = useRef(0);
  const disposedRef = useRef(false);
  const runIdRef = useRef<string | null>(null);
  const wfRef = useRef(wf);
  wfRef.current = wf;

  const selected = wf.nodes.find((node) => node.id === selectedId) ?? null;
  const doneCount = wf.nodes.filter((node) => node.status === 'done').length;

  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(wf));
      } catch {
        // 存储失败不影响编辑
      }
      // 画布变更同步给主进程调度器：触发器就是计划，别让两边各说各话
      void window.olivia?.schedules
        ?.sync({ workflow: wf, workspace })
        .then((result) => {
          // cron 不合法时在画布上就说清楚，别等用户到计划页才看到「无效」
          if (result?.invalid?.length) setToast(result.invalid[0]!);
        })
        .catch(() => undefined);
    }, 280);
    return () => clearTimeout(timer);
  }, [wf, workspace]);

  useEffect(() => {
    void window.olivia?.mcp
      ?.list()
      .then(({ configs }) => setMcpServers(configs.filter((item) => item.enabled).map((item) => item.id)))
      .catch(() => undefined);
  }, []);

  const applyRunEvent = useCallback((event: WorkflowRunEvent) => {
    if (event.type === 'run.start') {
      setRunInfo(event.run);
      setGate(null);
      setPanelOpen(true);
      setWf((prev) => ({
        ...prev,
        nodes: prev.nodes.map((node) => ({
          ...node,
          status: node.kind === 'trigger' ? ('ready' as const) : ('idle' as const),
        })),
      }));
      return;
    }
    if (event.type === 'node.status') {
      setRunInfo((prev) =>
        prev
          ? {
              ...prev,
              nodes: {
                ...prev.nodes,
                [event.nodeId]: {
                  ...(prev.nodes[event.nodeId] ?? { nodeId: event.nodeId, phase: 'queued', attempts: 0 }),
                  phase: event.phase,
                  summary: event.summary ?? prev.nodes[event.nodeId]?.summary,
                  error: event.error ?? prev.nodes[event.nodeId]?.error,
                },
              },
            }
          : prev,
      );
      setWf((prev) => ({
        ...prev,
        nodes: prev.nodes.map((node) =>
          node.id === event.nodeId ? { ...node, status: phaseToNodeStatus(event.phase) } : node,
        ),
      }));
      if (event.phase !== 'waiting') {
        setGate((current) => (current && current.nodeId === event.nodeId ? null : current));
        setRunState((current) => (current === 'waiting' ? 'running' : current));
      }
      return;
    }
    if (event.type === 'node.log') {
      setRunInfo((prev) =>
        prev
          ? {
              ...prev,
              logs: [
                ...prev.logs.slice(-199),
                { at: Date.now(), nodeId: event.nodeId, kind: event.kind, text: event.text },
              ],
            }
          : prev,
      );
      return;
    }
    if (event.type === 'gate.waiting') {
      setGate({ nodeId: event.nodeId, title: event.title, detail: event.detail });
      setPanelOpen(true);
      setRunState('waiting');
      return;
    }
    if (event.type === 'usage') {
      setRunInfo((prev) =>
        prev
          ? {
              ...prev,
              usage: event.usage,
              nodes: event.nodeId && prev.nodes[event.nodeId]
                ? {
                    ...prev.nodes,
                    [event.nodeId]: {
                      ...prev.nodes[event.nodeId]!,
                      usage: event.nodeUsage ?? prev.nodes[event.nodeId]!.usage,
                    },
                  }
                : prev.nodes,
            }
          : prev,
      );
      return;
    }
    if (event.type === 'run.done') {
      setRunInfo((prev) =>
        prev
          ? {
              ...prev,
              phase: event.ok ? 'done' : 'failed',
              branch: event.branch ?? prev.branch,
              error: event.error,
              endedAt: Date.now(),
            }
          : prev,
      );
      setGate(null);
      setRunState(event.ok ? 'done' : 'idle');
      setToast(
        event.ok
          ? `跑完了：结果在 ${event.branch ?? '集成分支'}，可在 Git 页检查或开 PR`
          : `运行失败：${event.error ?? '未知错误'}`,
      );
    }
  }, []);

  useEffect(() => {
    const bridge = window.olivia?.workflow;
    if (!bridge) return;
    const off = bridge.onEvent(({ runId, event }) => {
      if (runId !== runIdRef.current) return;
      applyRunEvent(event);
    });
    return off;
  }, [applyRunEvent]);

  useEffect(() => {
    return () => {
      disposedRef.current = true;
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) {
        event.preventDefault();
        removeNode(selectedId);
      }
      if (event.key === 'Escape') setSelectedId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const patchNode = useCallback((id: string, patch: Partial<WfNode>) => {
    setWf((prev) => ({
      ...prev,
      updatedAt: Date.now(),
      nodes: prev.nodes.map((node) => (node.id === id ? { ...node, ...patch } : node)),
    }));
  }, []);

  const addNodeAt = useCallback((kind: NodeKind, x: number, y: number) => {
    const node = makeNode({ kind, ...KIND_TEXT[kind], x, y });
    setWf((prev) => ({ ...prev, updatedAt: Date.now(), nodes: [...prev.nodes, node] }));
    setSelectedId(node.id);
  }, []);

  const addNode = (kind: NodeKind) => {
    const node = wf.nodes[wf.nodes.length - 1];
    addNodeAt(kind, node ? node.x + NODE_W + 96 : 120, node ? node.y : 280);
  };

  const moveNode = useCallback((id: string, x: number, y: number) => {
    setWf((prev) => ({
      ...prev,
      nodes: prev.nodes.map((node) => (node.id === id ? { ...node, x, y } : node)),
    }));
  }, []);

  const connect = useCallback((from: string, to: string) => {
    setWf((prev) => {
      if (from === to) return prev;
      if (prev.edges.some((edge) => edge.from === from && edge.to === to)) return prev;
      return {
        ...prev,
        updatedAt: Date.now(),
        edges: [...prev.edges, { id: uid('edge'), from, to }],
      };
    });
  }, []);

  function removeNode(id: string) {
    setWf((prev) => ({
      ...prev,
      updatedAt: Date.now(),
      nodes: prev.nodes.filter((node) => node.id !== id),
      edges: prev.edges.filter((edge) => edge.from !== id && edge.to !== id),
    }));
    setSelectedId((current) => (current === id ? null : current));
  }

  const insertDownstream = () => {
    if (!selected) return;
    const node = makeNode({
      kind: 'agent',
      title: '新 Agent',
      subtitle: 'Worker · 待配置',
      x: selected.x + NODE_W + 88,
      y: selected.y,
    });
    setWf((prev) => ({
      ...prev,
      updatedAt: Date.now(),
      nodes: [...prev.nodes, node],
      edges: [...prev.edges, { id: uid('edge'), from: selected.id, to: node.id }],
    }));
    setSelectedId(node.id);
  };

  const advance = async (start: number) => {
    const order = topoOrder(wfRef.current);
    /** 演示回放也要喂同一份运行面板：按钮在转，右栏总得能看出跑到哪一步 */
    const markNode = (nodeId: string, phase: RunPhase): void => {
      setRunInfo((prev) =>
        prev
          ? {
              ...prev,
              nodes: {
                ...prev.nodes,
                [nodeId]: {
                  nodeId,
                  title: wfRef.current.nodes.find((item) => item.id === nodeId)?.title,
                  phase,
                  attempts: 1,
                },
              },
            }
          : prev,
      );
    };
    const log = (nodeId: string | undefined, text: string): void => {
      setRunInfo((prev) =>
        prev ? { ...prev, logs: [...prev.logs, { at: Date.now(), nodeId, kind: 'info', text }] } : prev,
      );
    };

    try {
      for (let index = start; index < order.length; index += 1) {
        const node = order[index];
        if (!node || disposedRef.current) return;
        if (node.kind === 'trigger') {
          patchNode(node.id, { status: 'ready' });
          markNode(node.id, 'done');
          continue;
        }
        if (node.kind === 'gate' && !approvedRef.current) {
          patchNode(node.id, { status: 'waiting' });
          markNode(node.id, 'waiting');
          cursorRef.current = index;
          setRunState('waiting');
          setRunInfo((prev) => (prev ? { ...prev, phase: 'waiting' } : prev));
          setGate({
            nodeId: node.id,
            title: node.title,
            detail: node.blockReason ?? '合并前的人工确认：确认后继续执行。',
          });
          setToast('人工审批门：确认后继续执行');
          return;
        }
        patchNode(node.id, { status: 'running' });
        markNode(node.id, 'running');
        log(node.id, `派发「${node.title}」`);
        await sleep(720);
        if (disposedRef.current) return;
        patchNode(node.id, { status: 'done' });
        markNode(node.id, 'done');
        log(node.id, '完成');
      }
      if (disposedRef.current) return;
      setRunState('done');
      setRunInfo((prev) => (prev ? { ...prev, phase: 'done', endedAt: Date.now() } : prev));
      setToast(`跑完了：${order.length} 个节点（浏览器预览是模拟回放，不调用模型）`);
    } finally {
      // 中途抛错也不能把按钮永远留在「执行中…」
      setRunState((previous) => (previous === 'running' ? 'idle' : previous));
    }
  };

  const runReal = async (): Promise<boolean> => {
    const bridge = window.olivia?.workflow;
    if (!bridge) return false;
    const current = wfRef.current;
    if (!workspace) {
      setToast('先给任务绑定一个 git 仓库：并行 Agent 要在 worktree 里跑');
      return true;
    }
    if (current.nodes.length === 0) {
      setToast('画布是空的，先从节点库拖入触发器');
      return true;
    }
    if (!current.nodes.some((node) => node.kind === 'trigger')) {
      setToast('缺少触发器：工作流得有个起点');
      return true;
    }
    const runId = `wf_${Date.now().toString(36)}`;
    runIdRef.current = runId;
    setRunInfo({
      id: runId,
      workflowId: current.id,
      workflowName: current.name,
      workspace,
      phase: 'running',
      startedAt: Date.now(),
      nodes: {},
      logs: [],
    });
    setGate(null);
    setPanelOpen(true);
    setRunState('running');
    setToast('开始执行：按 DAG 派发 Agent，每个 worker 一个 worktree');
    const started = await bridge.run({
      runId,
      workflow: current,
      workspace,
      model: store.settings.model,
      providerId: store.settings.providerId,
      allowShell: store.settings.allowShell,
      baseUrl: store.settings.baseUrl,
      apiKey: store.settings.apiKey,
      maxParallel: 3,
    });
    if (!started.ok) {
      runIdRef.current = null;
      setRunInfo(null);
      setRunState('idle');
      setToast(started.error ?? '工作流启动失败');
    }
    return true;
  };

  const decideGate = (approved: boolean) => {
    const runId = runIdRef.current;
    const bridge = window.olivia?.workflow;
    if (bridge && runId && gate) {
      bridge.gate(runId, gate.nodeId, approved);
      setGate(null);
      setRunState(approved ? 'running' : 'idle');
      if (!approved) setToast('已停止：集成分支里已有的提交不会被删除');
      return;
    }
    // 浏览器预览没有主进程：本地回放自己续跑，别让「批准」点下去没反应
    if (approved) {
      void approve();
      return;
    }
    setGate(null);
    setRunState('idle');
    setToast('已停止本次模拟运行');
  };

  const cancelRun = () => {
    if (runIdRef.current) window.olivia?.workflow.cancel(runIdRef.current);
    setRunState('idle');
    setGate(null);
    setToast('已请求取消');
  };

  const run = async () => {
    if (runState === 'running') return;
    if (await runReal()) return;
    if (wfRef.current.nodes.length === 0) {
      setToast('画布是空的，先从节点库拖入触发器');
      return;
    }
    approvedRef.current = false;
    cursorRef.current = 0;
    const current = wfRef.current;
    const runId = `demo_${Date.now().toString(36)}`;
    runIdRef.current = runId;
    setWf((prev) => ({
      ...prev,
      nodes: prev.nodes.map((node) => ({
        ...node,
        status: node.kind === 'trigger' ? ('ready' as const) : ('idle' as const),
      })),
    }));
    // 演示回放也开运行面板：否则「执行中…」时右栏什么都没有，看着像卡死
    setRunInfo({
      id: runId,
      workflowId: current.id,
      workflowName: current.name,
      workspace: workspace || '浏览器预览',
      phase: 'running',
      startedAt: Date.now(),
      nodes: {},
      logs: [
        {
          at: Date.now(),
          kind: 'info',
          text: '浏览器预览：按拓扑顺序模拟推进，不调用模型、不写盘',
        },
      ],
    });
    setGate(null);
    setPanelOpen(true);
    setRunState('running');
    setToast('浏览器预览：按拓扑顺序模拟推进');
    await sleep(120);
    await advance(0);
  };

  const approve = async () => {
    const order = topoOrder(wfRef.current);
    const gateNode = order[cursorRef.current];
    if (gateNode) patchNode(gateNode.id, { status: 'done' });
    approvedRef.current = true;
    setGate(null);
    setRunState('running');
    setRunInfo((prev) => (prev ? { ...prev, phase: 'running' } : prev));
    setToast('已批准，继续执行');
    await advance(cursorRef.current + 1);
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(wf, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${wf.name}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setToast('已导出工作流 JSON');
  };

  const importJson = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as Workflow;
      if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
        throw new Error('结构不对');
      }
      setWf({
        id: parsed.id ?? uid('wf'),
        name: parsed.name ?? '导入的工作流',
        nodes: parsed.nodes,
        edges: parsed.edges,
        updatedAt: Date.now(),
      });
      setSelectedId(null);
      setRunState('idle');
      setToast(`已导入：${parsed.nodes.length} 个节点`);
    } catch {
      setToast('导入失败：不是合法的工作流 JSON');
    }
  };

  const reset = () => {
    const seeded = seedWorkflow();
    setWf(seeded);
    setSelectedId(seeded.nodes.find((node) => node.title === '页面与交互')?.id ?? null);
    setRunState('idle');
    setRunInfo(null);
    setConfirmReset(false);
    setToast('已重置为默认工作流');
  };

  return (
    <div className="workflow-page">
      <Library onAdd={addNode} />

      <div className="wf-main">
        <Canvas
          ref={canvasRef}
          wf={wf}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onMove={moveNode}
          onConnect={connect}
          onDropNode={addNodeAt}
          onViewport={setZoom}
        />

        <div className="wf-badges">
          <span className="wf-badge">
            <b>{wf.nodes.length}</b> 节点
          </span>
          <span className="wf-badge">
            <b>{wf.edges.length}</b> 连线
          </span>
          <span className="wf-badge">
            <Icon name="check" size={12} />
            <b>{doneCount}</b> 完成
          </span>
        </div>

        <div className="wf-zoom">
          <button className="zoom-btn" onClick={() => canvasRef.current?.zoom(-0.1)} title="缩小">
            <Icon name="zoomOut" size={15} />
          </button>
          <span className="zoom-value">{Math.round(zoom * 100)}%</span>
          <button className="zoom-btn" onClick={() => canvasRef.current?.zoom(0.1)} title="放大">
            <Icon name="zoomIn" size={15} />
          </button>
          <span className="zoom-sep" />
          <button className="zoom-fit" onClick={() => canvasRef.current?.fit()}>
            适配视图
          </button>
        </div>

        <div className="wf-actions">
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importJson(file);
              event.target.value = '';
            }}
          />
          <button className="wf-action" onClick={exportJson}>
            导出
          </button>
          <button className="wf-action" onClick={() => fileRef.current?.click()}>
            导入
          </button>
          <button className="wf-action" onClick={() => setConfirmReset(true)}>
            重置
          </button>
          <button
            className={`wf-run ${runState === 'waiting' ? 'approve' : ''}`}
            onClick={() => {
              if (gate) decideGate(true);
              else if (runState === 'waiting') void approve();
              else void run();
            }}
            disabled={runState === 'running' && !gate}
          >
            <Icon name="play" size={14} />
            {gate || runState === 'waiting'
              ? '批准并继续'
              : runState === 'running'
                ? '执行中…'
                : '运行工作流'}
          </button>
        </div>

        {panelOpen && (
          <RunPanel
            run={runInfo}
            workflow={wf}
            gate={gate}
            onApprove={() => decideGate(true)}
            onReject={() => decideGate(false)}
            onCancel={cancelRun}
            onClose={() => setPanelOpen(false)}
          />
        )}

        {runInfo && !panelOpen && (
          <button
            onClick={() => setPanelOpen(true)}
            className="absolute left-4 bottom-16 z-30 h-8 px-3 rounded-xl border border-light-line dark:border-dark-line bg-light-panelStrong dark:bg-[rgba(18,14,20,0.94)] backdrop-blur-xl text-[13px] text-light-ink dark:text-dark-ink shadow-lg"
          >
            运行面板 · {runInfo.phase === 'running' ? '执行中' : runInfo.phase === 'done' ? '完成' : runInfo.phase}
          </button>
        )}

        {toast && <div className="toast">{toast}</div>}

        {confirmReset && (
          <div
            className="fixed inset-0 z-[80] grid place-items-center bg-black/50 backdrop-blur-sm p-5"
            onClick={() => setConfirmReset(false)}
          >
            <div
              className="w-full max-w-sm rounded-2xl border border-light-line dark:border-dark-line bg-light-panel-light dark:bg-dark-panel p-5 shadow-2xl"
              style={{ background: 'var(--olivia-panel, rgba(250,248,243,0.98))' }}
              onClick={(event) => event.stopPropagation()}
              role="dialog"
              aria-modal="true"
            >
              <h2 className="text-[16px] font-semibold text-light-ink dark:text-dark-ink">
                重置为默认工作流？
              </h2>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-light-inkMuted dark:text-dark-inkMuted">
                当前画布上的节点、连线和触发器设置都会丢掉；已经生成的计划记录会保留（停用状态）。
              </p>
              <div className="mt-4 flex items-center gap-2">
                <button className="btn-outline h-8 px-3" onClick={() => setConfirmReset(false)}>
                  取消
                </button>
                <span className="flex-1" />
                <button className="btn-solid h-8 px-3" onClick={reset}>
                  重置
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <Inspector
        node={selected}
        mcpServers={mcpServers}
        onPatch={(patch) => {
          if (selectedId) patchNode(selectedId, patch);
        }}
        onDelete={() => {
          if (selectedId) removeNode(selectedId);
        }}
        onInsert={insertDownstream}
      />
    </div>
  );
}
