import { useEffect, useRef } from 'react';

/**
 * 浮层互斥：同一时刻只允许一个 popover/抽屉开着。
 *
 * 之前模型菜单能和用量抽屉同时打开、叠在一起，Escape 行为也各写各的。
 * 这里用一个模块级登记表统一收口：打开新的就关掉上一个，关掉自己就注销。
 */

let seq = 0;
const closers = new Map<number, () => void>();

function openPopover(close: () => void): number {
  const id = ++seq;
  for (const [otherId, closeOther] of [...closers]) {
    if (otherId === id) continue;
    closers.delete(otherId);
    closeOther();
  }
  closers.set(id, close);
  return id;
}

function closePopover(id: number): void {
  closers.delete(id);
}

/**
 * @param open 当前是否打开
 * @param onClose 被别人挤掉时怎么关
 */
export function usePopoverExclusive(open: boolean, onClose: () => void): void {
  const idRef = useRef<number | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) {
      if (idRef.current !== null) {
        closePopover(idRef.current);
        idRef.current = null;
      }
      return;
    }
    idRef.current = openPopover(() => closeRef.current());
    return () => {
      if (idRef.current !== null) {
        closePopover(idRef.current);
        idRef.current = null;
      }
    };
  }, [open]);
}
