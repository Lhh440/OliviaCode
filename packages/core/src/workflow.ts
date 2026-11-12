export type NodeKind = 'trigger' | 'agent' | 'reviewer' | 'gate' | 'output';

export type NodeStatus = 'idle' | 'ready' | 'running' | 'waiting' | 'done' | 'failed';

export interface WfNode {
  id: string;
  kind: NodeKind;
  title: string;
  subtitle: string;
  model?: string;
  prompt?: string;
  tools?: string[];
  retries?: number;
  timeout?: number;
  isolation?: 'sandbox' | 'worktree';
  /** trigger: 触发频率；output: 产物类型 */
  schedule?: string;
  context?: 'clean' | 'history';
  status: NodeStatus;
  x: number;
  y: number;
}

export interface WfEdge {
  id: string;
  from: string;
  to: string;
}

export interface Workflow {
  id: string;
  name: string;
  nodes: WfNode[];
  edges: WfEdge[];
  updatedAt: number;
}

export const NODE_W = 176;
export const NODE_H = 78;

export interface KindMeta {
  label: string;
  icon: string;
  accent: string;
  desc: string;
}

export const KINDS: Record<NodeKind, KindMeta> = {
  trigger: { label: '定时触发器', icon: 'clock', accent: '#1f9d55', desc: '按计划唤醒整条工作流' },
  agent: { label: '并行 Agent', icon: 'agent', accent: '#3b6ef6', desc: '多个 worker 并行改代码' },
  reviewer: { label: '评审 Agent', icon: 'shield', accent: '#c98a12', desc: '干净上下文的独立评审' },
  gate: { label: '审批门', icon: 'gate', accent: '#c98a12', desc: '合并前的人工确认' },
  output: { label: '产出', icon: 'send', accent: '#1f9d55', desc: '提交 PR、输出日报' },
};

export const TOOL_NAMES = ['read', 'write', 'patch', 'shell', 'git', 'test'] as const;

export const STATUS_LABEL: Record<NodeStatus, string> = {
  idle: '未配置',
  ready: '已启用',
  running: '运行中',
  waiting: '等待你',
  done: '完成',
  failed: '失败',
};

let counter = 0;
function nid(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter.toString(36)}`;
}

export interface NodeSeed {
  kind: NodeKind;
  title: string;
  subtitle: string;
  x: number;
  y: number;
  model?: string;
  prompt?: string;
  tools?: string[];
  status?: NodeStatus;
  schedule?: string;
  context?: 'clean' | 'history';
}

export function makeNode(seed: NodeSeed): WfNode {
  const node: WfNode = {
    id: nid(seed.kind),
    kind: seed.kind,
    title: seed.title,
    subtitle: seed.subtitle,
    status: seed.status ?? 'idle',
    x: seed.x,
    y: seed.y,
    retries: 2,
    timeout: 10,
    isolation: 'worktree',
  };
  if (seed.model) node.model = seed.model;
  if (seed.prompt) node.prompt = seed.prompt;
  if (seed.tools) node.tools = seed.tools;
  if (seed.schedule) node.schedule = seed.schedule;
  if (seed.context) node.context = seed.context;
  return node;
}

export function seedWorkflow(): Workflow {
  const t1 = makeNode({
    kind: 'trigger',
    title: '每晚 22:00',
    subtitle: '触发器',
    schedule: '每晚 22:00',
    status: 'ready',
    x: 40,
    y: 330,
  });
  const p1 = makeNode({
    kind: 'agent',
    title: '需求拆解',
    subtitle: 'Planner · 读上下游',
    model: 'DeepSeek-V3.2',
    tools: ['read', 'git'],
    prompt: '拆解今日议题，输出 2–4 个互不重叠的子任务，每个子任务写明改动范围与验收方式。',
    x: 266,
    y: 330,
  });
  const a1 = makeNode({
    kind: 'agent',
    title: '接口与数据层',
    subtitle: 'Coder#1 · worker a',
    model: 'DeepSeek-V3.2',
    tools: ['read', 'write', 'patch', 'shell', 'git', 'test'],
    prompt: '你负责「{{scope}}」中的接口与数据层。先读上下文，再改代码；改完自己跑一遍测试。',
    x: 492,
    y: 214,
  });
  const a2 = makeNode({
    kind: 'agent',
    title: '页面与交互',
    subtitle: 'Coder#2 · worker b',
    model: 'DeepSeek-V3.2',
    tools: ['read', 'write', 'patch', 'shell', 'git', 'test'],
    prompt:
      '你负责「{{scope}}」部分。先用 read / grep 建立上下文，再动手改代码；改完必须自己跑一遍相关测试，失败就修复，不要留 TODO。',
    x: 492,
    y: 330,
  });
  const a3 = makeNode({
    kind: 'agent',
    title: '测试补齐',
    subtitle: 'Tester · worker c',
    model: 'DeepSeek-V3.2',
    tools: ['read', 'write', 'shell', 'test'],
    prompt: '为本次改动补齐回归测试，覆盖边界条件，禁止修改被测实现。',
    x: 492,
    y: 446,
  });
  const r1 = makeNode({
    kind: 'reviewer',
    title: '独立评审',
    subtitle: 'Reviewer · 干净上下文',
    model: 'Claude-Sonnet-4.5',
    tools: ['read', 'git'],
    context: 'clean',
    prompt: '只看 diff 与仓库现状，找出正确性、安全性与可维护性问题。不要相信实现者的自述。',
    x: 718,
    y: 330,
  });
  const g1 = makeNode({
    kind: 'gate',
    title: '人工审批门',
    subtitle: 'Policy · 合并前确认',
    status: 'waiting',
    x: 718,
    y: 446,
  });
  const i1 = makeNode({
    kind: 'agent',
    title: '合并与回归',
    subtitle: 'Integrator · 解冲突',
    model: 'DeepSeek-V3.2',
    tools: ['read', 'patch', 'shell', 'git', 'test'],
    prompt: '按顺序合并各 worker 分支，解决冲突，跑全量回归。',
    x: 944,
    y: 330,
  });
  const o1 = makeNode({
    kind: 'output',
    title: 'PR + 日报',
    subtitle: 'Output · 推提到 main',
    x: 1170,
    y: 330,
  });

  const nodes = [t1, p1, a1, a2, a3, r1, g1, i1, o1];
  const link = (from: WfNode, to: WfNode): WfEdge => ({ id: nid('edge'), from: from.id, to: to.id });
  const edges = [
    link(t1, p1),
    link(p1, a1),
    link(p1, a2),
    link(p1, a3),
    link(a1, r1),
    link(a2, r1),
    link(a3, r1),
    link(r1, g1),
    link(g1, i1),
    link(i1, o1),
  ];

  return { id: 'wf_default', name: '夜间重构工作流', nodes, edges, updatedAt: Date.now() };
}

export function topoOrder(wf: Workflow): WfNode[] {
  const indeg = new Map<string, number>();
  wf.nodes.forEach((n) => indeg.set(n.id, 0));
  wf.edges.forEach((e) => indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1));
  const queue = wf.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0);
  const out: WfNode[] = [];
  while (queue.length) {
    const n = queue.shift() as WfNode;
    out.push(n);
    for (const e of wf.edges.filter((x) => x.from === n.id)) {
      const next = (indeg.get(e.to) ?? 0) - 1;
      indeg.set(e.to, next);
      if (next === 0) {
        const target = wf.nodes.find((x) => x.id === e.to);
        if (target) queue.push(target);
      }
    }
  }
  const seen = new Set(out.map((n) => n.id));
  return [...out, ...wf.nodes.filter((n) => !seen.has(n.id))];
}

export interface Viewport {
  x: number;
  y: number;
  s: number;
}

export function fitView(
  nodes: WfNode[],
  width: number,
  height: number,
  pad = 72,
  maxScale = 1,
): Viewport {
  if (!nodes.length) return { x: width / 2, y: height / 2, s: 1 };
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + NODE_W));
  const maxY = Math.max(...nodes.map((n) => n.y + NODE_H));
  const bw = maxX - minX;
  const bh = maxY - minY;
  const s = Math.min(
    maxScale,
    Math.max(0.3, Math.min((width - pad * 2) / bw, (height - pad * 2) / bh)),
  );
  return {
    s,
    x: (width - bw * s) / 2 - minX * s,
    y: (height - bh * s) / 2 - minY * s,
  };
}

export function edgePath(from: WfNode, to: WfNode): string {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;
  const dx = Math.max(36, Math.min(180, Math.abs(x2 - x1) * 0.6));
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

export function validateWorkflow(wf: Workflow): string[] {
  const problems: string[] = [];
  const ids = new Set(wf.nodes.map((n) => n.id));
  for (const e of wf.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) problems.push(`连线 ${e.id} 指向了不存在的节点`);
    if (e.from === e.to) problems.push(`节点 ${e.from} 自连成环`);
  }
  if (!wf.nodes.some((n) => n.kind === 'trigger')) problems.push('缺少触发器，工作流无法自行启动');
  if (!wf.nodes.some((n) => n.kind === 'output')) problems.push('缺少产出节点，结果无处落地');
  const froms = new Set(wf.edges.map((e) => e.from));
  for (const n of wf.nodes) {
    if (n.kind !== 'output' && !froms.has(n.id)) problems.push(`「${n.title}」没有下游`);
  }
  return problems;
}
