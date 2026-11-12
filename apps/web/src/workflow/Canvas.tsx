import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  KINDS,
  NODE_H,
  NODE_W,
  STATUS_LABEL,
  edgePath,
  fitView,
  type NodeKind,
  type Viewport,
  type WfNode,
  type Workflow,
} from '@olivia/core';
import { Icon } from '../icons';

export interface CanvasHandle {
  fit: () => void;
  zoom: (delta: number) => void;
}

interface Props {
  wf: Workflow;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMove: (id: string, x: number, y: number) => void;
  onConnect: (from: string, to: string) => void;
  onDropNode: (kind: NodeKind, x: number, y: number) => void;
  onViewport: (scale: number) => void;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const FIT_PAD = 36;

export const Canvas = forwardRef<CanvasHandle, Props>(function Canvas(
  { wf, selectedId, onSelect, onMove, onConnect, onDropNode, onViewport },
  handle,
) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<Viewport>({ x: 0, y: 0, s: 1 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [dragging, setDragging] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const [link, setLink] = useState<{ from: string; x: number; y: number } | null>(null);

  const viewRef = useRef(view);
  viewRef.current = view;
  const dragRef = useRef<{ id: string; ox: number; oy: number; px: number; py: number } | null>(null);
  const panRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
  const linkRef = useRef<string | null>(null);
  const touchedRef = useRef(false);
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  const onConnectRef = useRef(onConnect);
  onConnectRef.current = onConnect;

  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      setSize({ w: rect.width, h: rect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!size.w || touchedRef.current) return;
    setView(fitView(wf.nodes, size.w, size.h, FIT_PAD, 1));
  }, [size, wf.nodes.length]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const el = surfaceRef.current;
      if (!el || touchedRef.current) return;
      const rect = el.getBoundingClientRect();
      setView(fitView(wf.nodes, rect.width, rect.height, FIT_PAD, 1));
    }, 260);
    return () => clearTimeout(timer);
  }, [wf.nodes.length]);

  useEffect(() => {
    onViewport(view.s);
  }, [view.s, onViewport]);

  const fit = () => {
    const el = surfaceRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    touchedRef.current = true;
    setView(fitView(wf.nodes, rect.width, rect.height, FIT_PAD, 1));
  };

  const zoomAt = (delta: number, mx: number, my: number) => {
    const current = viewRef.current;
    touchedRef.current = true;
    const s = clamp(current.s + delta, 0.3, 1.6);
    setView({
      s,
      x: mx - ((mx - current.x) / current.s) * s,
      y: my - ((my - current.y) / current.s) * s,
    });
  };

  useImperativeHandle(handle, () => ({
    fit,
    zoom: (delta: number) => {
      const rect = surfaceRef.current?.getBoundingClientRect();
      zoomAt(delta, (rect?.width ?? 800) / 2, (rect?.height ?? 600) / 2);
    },
  }));

  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      touchedRef.current = true;
      const rect = el.getBoundingClientRect();
      const current = viewRef.current;
      const s = clamp(current.s * Math.exp(-event.deltaY * 0.0014), 0.3, 1.6);
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      setView({
        s,
        x: mx - ((mx - current.x) / current.s) * s,
        y: my - ((my - current.y) / current.s) * s,
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const onMovePointer = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (drag) {
        const current = viewRef.current;
        onMoveRef.current(
          drag.id,
          Math.round(drag.ox + (event.clientX - drag.px) / current.s),
          Math.round(drag.oy + (event.clientY - drag.py) / current.s),
        );
        return;
      }
      const pan = panRef.current;
      if (pan) {
        setView((value) => ({
          ...value,
          x: pan.ox + (event.clientX - pan.px),
          y: pan.oy + (event.clientY - pan.py),
        }));
        return;
      }
      if (linkRef.current) {
        const rect = surfaceRef.current?.getBoundingClientRect();
        if (!rect) return;
        const current = viewRef.current;
        setLink({
          from: linkRef.current,
          x: (event.clientX - rect.left - current.x) / current.s,
          y: (event.clientY - rect.top - current.y) / current.s,
        });
      }
    };

    const onUp = (event: PointerEvent) => {
      if (dragRef.current) {
        dragRef.current = null;
        setDragging(null);
      }
      if (panRef.current) {
        panRef.current = null;
        setPanning(false);
      }
      const from = linkRef.current;
      if (from) {
        linkRef.current = null;
        setLink(null);
        const target = document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest('[data-node-id]');
        const to = target?.getAttribute('data-node-id');
        if (to && to !== from) onConnectRef.current(from, to);
      }
    };

    window.addEventListener('pointermove', onMovePointer);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMovePointer);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  const startDrag = (event: ReactPointerEvent, node: WfNode) => {
    event.stopPropagation();
    onSelect(node.id);
    if ((event.target as HTMLElement).closest('.wf-port')) return;
    touchedRef.current = true;
    dragRef.current = { id: node.id, ox: node.x, oy: node.y, px: event.clientX, py: event.clientY };
    setDragging(node.id);
  };

  const startLink = (event: ReactPointerEvent, node: WfNode) => {
    event.stopPropagation();
    linkRef.current = node.id;
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return;
    const current = viewRef.current;
    setLink({
      from: node.id,
      x: (event.clientX - rect.left - current.x) / current.s,
      y: (event.clientY - rect.top - current.y) / current.s,
    });
  };

  const onSurfaceDown = (event: ReactPointerEvent) => {
    if (event.button !== 0 && event.button !== 1) return;
    if ((event.target as HTMLElement).closest('.wf-node')) return;
    onSelect(null);
    touchedRef.current = true;
    panRef.current = {
      px: event.clientX,
      py: event.clientY,
      ox: viewRef.current.x,
      oy: viewRef.current.y,
    };
    setPanning(true);
  };

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    const kind = event.dataTransfer.getData('application/olivia-node') as NodeKind;
    if (!kind) return;
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return;
    const current = viewRef.current;
    onDropNode(
      kind,
      Math.round((event.clientX - rect.left - current.x) / current.s - NODE_W / 2),
      Math.round((event.clientY - rect.top - current.y) / current.s - NODE_H / 2),
    );
  };

  const nodeMap = new Map(wf.nodes.map((node) => [node.id, node]));

  return (
    <div
      className={`wf-surface ${panning ? 'panning' : ''} ${dragging ? 'dragging' : ''}`}
      ref={surfaceRef}
      onPointerDown={onSurfaceDown}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={onDrop}
    >
      <div
        className="wf-grid"
        style={{
          backgroundSize: `${24 * view.s}px ${24 * view.s}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
      />

      <svg className="wf-links">
        <defs>
          <marker
            id="wf-arrow"
            viewBox="0 0 10 10"
            refX="8.5"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#c6c6d0" />
          </marker>
          <marker
            id="wf-arrow-active"
            viewBox="0 0 10 10"
            refX="8.5"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#3b6ef6" />
          </marker>
        </defs>
        <g transform={`translate(${view.x},${view.y}) scale(${view.s})`}>
          {wf.edges.map((edge) => {
            const from = nodeMap.get(edge.from);
            const to = nodeMap.get(edge.to);
            if (!from || !to) return null;
            const active = selectedId === edge.from || selectedId === edge.to;
            return (
              <path
                key={edge.id}
                d={edgePath(from, to)}
                className={`wf-link ${active ? 'active' : ''}`}
                markerEnd={active ? 'url(#wf-arrow-active)' : 'url(#wf-arrow)'}
              />
            );
          })}
          {link &&
            (() => {
              const from = nodeMap.get(link.from);
              if (!from) return null;
              const x1 = from.x + NODE_W;
              const y1 = from.y + NODE_H / 2;
              const dx = Math.max(40, Math.abs(link.x - x1) * 0.5);
              return (
                <path
                  className="wf-link ghost"
                  d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${link.x - dx} ${link.y}, ${link.x} ${link.y}`}
                />
              );
            })()}
        </g>
      </svg>

      <div
        className="wf-world"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}
      >
        {wf.nodes.map((node) => {
          const meta = KINDS[node.kind];
          return (
            <div
              key={node.id}
              data-node-id={node.id}
              className={`wf-node kind-${node.kind} ${selectedId === node.id ? 'selected' : ''} status-${node.status}`}
              style={{
                width: NODE_W,
                height: NODE_H,
                transform: `translate(${node.x}px, ${node.y}px)`,
              }}
              onPointerDown={(event) => startDrag(event, node)}
            >
              <div className="wf-node-top">
                <span
                  className="wf-node-glyph"
                  style={{ color: meta.accent, background: `${meta.accent}14` }}
                >
                  <Icon name={meta.icon} size={13} />
                </span>
                <span className="wf-node-title">{node.title}</span>
              </div>
              <div className="wf-node-sub">{node.subtitle}</div>
              <div className="wf-node-foot">
                <span className="wf-node-model">
                  {node.model ??
                    (node.kind === 'trigger' ? '定时' : node.kind === 'gate' ? 'Policy' : '—')}
                </span>
                <span className={`wf-node-state ${node.status}`}>{STATUS_LABEL[node.status]}</span>
              </div>
              <span className="wf-port in" />
              <span
                className="wf-port out"
                onPointerDown={(event) => startLink(event, node)}
                title="拖出连线"
              />
            </div>
          );
        })}
      </div>

      {wf.nodes.length === 0 && (
        <div className="wf-empty">
          <Icon name="workflow" size={22} />
          <p>从左上角节点库拖入第一个节点</p>
        </div>
      )}
    </div>
  );
});
