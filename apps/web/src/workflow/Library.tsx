import { KINDS, type NodeKind } from '@olivia/core';
import { Icon } from '../icons';

const ORDER: NodeKind[] = ['trigger', 'agent', 'reviewer', 'gate', 'output'];

export function Library({ onAdd }: { onAdd: (kind: NodeKind) => void }) {
  return (
    <aside className="wf-library">
      <div className="wf-lib-title">节点库</div>
      {ORDER.map((kind) => {
        const meta = KINDS[kind];
        return (
          <button
            key={kind}
            className="wf-lib-item"
            draggable
            title={meta.desc}
            onDragStart={(event) => {
              event.dataTransfer.setData('application/olivia-node', kind);
              event.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => onAdd(kind)}
          >
            <Icon name={meta.icon} size={15} />
            <span>{meta.label}</span>
          </button>
        );
      })}
      <div className="wf-lib-hint">拖到画布，或点击添加</div>
    </aside>
  );
}
