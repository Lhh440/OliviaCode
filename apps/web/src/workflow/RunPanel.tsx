import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  RUN_PHASE_LABEL,
  type NodeRunState,
  type WorkflowRunState,
  type Workflow,
} from '@olivia/core';
import { Icon } from '../icons';

export interface GatePrompt {
  nodeId: string;
  title: string;
  detail: string;
}

const PHASE_STYLE: Record<string, string> = {
  running: 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/25',
  waiting: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30',
  done: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/25',
  failed: 'bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/25',
  canceled: 'bg-black/[0.05] dark:bg-white/[0.06] text-light-inkMuted dark:text-dark-inkMuted border-light-line dark:border-dark-line',
};

const LOG_STYLE: Record<string, string> = {
  info: 'text-light-inkMuted dark:text-dark-inkMuted',
  text: 'text-light-ink dark:text-dark-ink',
  tool: 'text-light-accent dark:text-dark-gold',
  error: 'text-red-600 dark:text-red-300',
};

export function RunPanel({
  run,
  workflow,
  gate,
  onApprove,
  onReject,
  onCancel,
  onClose,
}: {
  run: WorkflowRunState | null;
  workflow: Workflow;
  gate: GatePrompt | null;
  onApprove: () => void;
  onReject: () => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = logRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [run?.logs.length]);
  if (!run) return null;
  const nodes = workflow.nodes.map((node) => ({
    node,
    state: run.nodes[node.id] ?? ({ nodeId: node.id, phase: 'queued', attempts: 0 } as NodeRunState),
  }));
  const finished = nodes.filter((item) => item.state.phase === 'done').length;
  const active = nodes.filter((item) => item.state.phase === 'running').length;
  const logs = run.logs.slice(-7);

  return (
    <motion.aside
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      data-run-phase={run.phase}
      className="wf-runpanel absolute left-4 bottom-16 z-30 w-[430px] max-w-[calc(100%-2rem)] rounded-2xl border border-light-line dark:border-dark-line bg-light-panelStrong dark:bg-[rgba(18,14,20,0.94)] backdrop-blur-2xl shadow-2xl overflow-hidden"
    >
      <header className="flex items-center gap-2 px-3.5 py-2.5 border-b border-light-line dark:border-dark-line">
        <span className="text-[11px] font-medium text-light-ink dark:text-dark-ink truncate">
          {run.workflowName}
        </span>
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded border ${PHASE_STYLE[run.phase] ?? PHASE_STYLE.canceled}`}
        >
          {RUN_PHASE_LABEL[run.phase]}
        </span>
        <span className="ml-auto text-[10.5px] text-light-inkFaint dark:text-dark-inkFaint tabular-nums">
          {finished}/{nodes.length} · {active} 并行
        </span>
        <button
          onClick={onClose}
          className="w-5 h-5 grid place-items-center rounded text-light-inkFaint dark:text-dark-inkFaint hover:bg-black/5 dark:hover:bg-white/10"
          title="收起运行面板"
        >
          <Icon name="close" size={11} />
        </button>
      </header>

      <div className="px-3.5 py-2 flex flex-wrap gap-1.5 border-b border-light-line dark:border-dark-line">
        {nodes.map(({ node, state: nodeState }) => (
          <span
            key={node.id}
            className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border ${
              PHASE_STYLE[nodeState.phase] ?? PHASE_STYLE.canceled
            } ${nodeState.phase === 'queued' ? 'opacity-55' : ''}`}
            title={nodeState.error ?? nodeState.summary ?? node.title}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                nodeState.phase === 'running'
                  ? 'bg-blue-500 animate-pulse'
                  : nodeState.phase === 'done'
                    ? 'bg-emerald-500'
                    : nodeState.phase === 'failed'
                      ? 'bg-red-500'
                      : nodeState.phase === 'waiting'
                        ? 'bg-amber-500'
                        : 'bg-current opacity-40'
              }`}
            />
            {node.title}
          </span>
        ))}
      </div>

      <div ref={logRef} className="px-3.5 py-2 max-h-[124px] overflow-y-auto space-y-1">
        {logs.length === 0 ? (
          <p className="text-[11px] text-light-inkFaint dark:text-dark-inkFaint">正在派发节点…</p>
        ) : (
          logs.map((line, index) => {
            const node = line.nodeId ? workflow.nodes.find((item) => item.id === line.nodeId) : null;
            return (
              <p
                key={`${line.at}-${index}`}
                className={`text-[10.5px] leading-relaxed font-mono break-words ${LOG_STYLE[line.kind] ?? LOG_STYLE.info}`}
              >
                {node ? <span className="text-light-inkFaint dark:text-dark-inkFaint">[{node.title}] </span> : null}
                {line.text}
              </p>
            );
          })
        )}
      </div>

      <AnimatePresence>
        {gate && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="px-3.5 py-2.5 border-t border-amber-500/25 bg-amber-500/[0.06]"
          >
            <p className="text-[11.5px] font-medium text-light-ink dark:text-dark-ink">
              审批门：{gate.title}
            </p>
            <p className="mt-0.5 text-[10.5px] text-light-inkMuted dark:text-dark-inkMuted">{gate.detail}</p>
            <div className="mt-2 flex items-center gap-1.5">
              <button className="btn-solid !h-7 !text-[11.5px]" onClick={onApprove}>
                批准并继续
              </button>
              <button className="btn-outline !h-7 !text-[11.5px]" onClick={onReject}>
                停止
              </button>
              <span className="text-[10px] text-light-inkFaint dark:text-dark-inkFaint">
                审批前 worker 的改动只落在集成分支，不会动你的工作区
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <footer className="flex items-center gap-2 px-3.5 py-2 border-t border-light-line dark:border-dark-line">
        <span className="text-[10.5px] text-light-inkFaint dark:text-dark-inkFaint truncate">
          {run.branch ? `结果分支 ${run.branch}` : run.error ? run.error : 'worktree 隔离 · 完成即合并'}
        </span>
        {run.phase === 'running' && (
          <button className="ml-auto btn-ghost !h-6 !text-[11px]" onClick={onCancel}>
            取消
          </button>
        )}
      </footer>
    </motion.aside>
  );
}
