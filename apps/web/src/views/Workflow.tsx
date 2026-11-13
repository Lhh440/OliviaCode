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

function loadWorkflow(): Workflow {
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
    }, 280);
    return () => clearTimeout(timer);
  }, [wf]);

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
    for (let index = start; index < order.length; index += 1) {
      const node = order[index];
      if (!node || disposedRef.current) return;
      if (node.kind === 'trigger') {
        patchNode(node.id, { status: 'ready' });
        continue;
      }
      if (node.kind === 'gate' && !approvedRef.current) {
        patchNode(node.id, { status: 'waiting' });
        cursorRef.current = index;
        setRunState('waiting');
        setToast('人工审批门：确认后继续执行');
        return;
      }
      patchNode(node.id, { status: 'running' });
      await sleep(720);
      if (disposedRef.current) return;
      patchNode(node.id, { status: 'done' });
    }
    if (disposedRef.current) return;
    setRunState('done');
    setToast(`跑完了：${order.length} 个节点，产物已生成`);
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
    if (!runId || !gate) return;
    window.olivia?.workflow.gate(runId, gate.nodeId, approved);
    setGate(null);
    setRunState(approved ? 'running' : 'idle');
    if (!approved) setToast('已停止：集成分支里已有的提交不会被删除');
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
    setWf((prev) => ({
      ...prev,
      nodes: prev.nodes.map((node) => ({
        ...node,
        status: node.kind === 'trigger' ? ('ready' as const) : ('idle' as const),
      })),
    }));
    setRunState('running');
    setToast('浏览器预览：按拓扑顺序模拟推进');
    await sleep(120);
    await advance(0);
  };

  const approve = async () => {
    const order = topoOrder(wfRef.current);
    const gate = order[cursorRef.current];
    if (gate) patchNode(gate.id, { status: 'done' });
    approvedRef.current = true;
    setRunState('running');
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
    if (!window.confirm('重置为默认的「夜间重构工作流」？当前画布改动会丢失。')) return;
    const seeded = seedWorkflow();
    setWf(seeded);
    setSelectedId(seeded.nodes.find((node) => node.title === '页面与交互')?.id ?? null);
    setRunState('idle');
    setToast('已重置为默认工作流');
  };

  return (
    <div className="workflow-page">
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

        <Library onAdd={addNode} />

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
          <button className="wf-action" onClick={reset}>
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
            className="absolute left-4 bottom-16 z-30 h-8 px-3 rounded-xl border border-light-line dark:border-dark-line bg-light-panelStrong dark:bg-[rgba(18,14,20,0.94)] backdrop-blur-xl text-[11.5px] text-light-ink dark:text-dark-ink shadow-lg"
          >
            运行面板 · {runInfo.phase === 'running' ? '执行中' : runInfo.phase === 'done' ? '完成' : runInfo.phase}
          </button>
        )}

        {toast && <div className="toast">{toast}</div>}
      </div>

      <Inspector
        node={selected}
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
