import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  classifyPreviewUrl,
  type PreviewState,
} from '@olivia/core';
import { Icon } from '../icons';

export interface PreviewDockProps {
  taskId: string;
  open: boolean;
  initialUrl?: string;
  hidden?: boolean;
  onClose: () => void;
  onCaptured: (path: string) => void;
  /** M8：截图后直接加入 Composer 附件托盘（仍需用户点发送） */
  onSendToModel?: (path: string) => void;
}

type Device = 'desktop' | 'tablet' | 'phone';

const DEVICE_WIDTH: Record<Device, number> = {
  desktop: 0,
  tablet: 768,
  phone: 390,
};

/**
 * 内置预览的渲染层外壳。
 * 画面本体是主进程的 WebContentsView（浮在 HTML 上方），
 * 这里只负责地址栏、设备宽度、缩放，以及把占位区的 bounds 报给主进程。
 */
export function PreviewDock({ taskId, open, initialUrl, hidden, onClose, onCaptured, onSendToModel }: PreviewDockProps) {
  const bridge = window.olivia?.preview;
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(520);
  const [url, setUrl] = useState(initialUrl ?? '');
  const [state, setState] = useState<PreviewState | null>(null);
  const [device, setDevice] = useState<Device>('desktop');
  const [notice, setNotice] = useState<string | null>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const bounds = useCallback((): {
    x: number;
    y: number;
    width: number;
    height: number;
    visible: boolean;
  } | null => {
    const host = hostRef.current;
    if (!host) return null;
    const rect = host.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return null;
    const maxWidth = Math.max(120, rect.width - 16);
    const desired = DEVICE_WIDTH[device] > 0 ? Math.min(DEVICE_WIDTH[device], maxWidth) : maxWidth;
    return {
      x: Math.round(rect.left + (rect.width - desired) / 2),
      y: Math.round(rect.top + 8),
      width: Math.round(desired),
      height: Math.round(rect.height - 16),
      visible: !hidden,
    };
  }, [device, hidden]);

  // 订阅主进程状态
  useEffect(() => {
    if (!bridge) return;
    const off = bridge.onEvent((next) => {
      setState(next);
      if (next.closed) return;
      if (next.url) setUrl(next.url);
    });
    return off;
  }, [bridge]);

  // 打开时通知主进程（只在打开/地址/task 变化时重建，不要跟着 bounds 重载）
  useEffect(() => {
    if (!bridge || !open) return;
    if (!initialUrl) return;
    const timer = window.setTimeout(() => {
      const box = bounds();
      void bridge
        .open({ taskId, url: initialUrl, bounds: box ?? { x: 0, y: 0, width: 520, height: 400, visible: true } })
        .then((result) => {
          if (!result.ok) setNotice(result.error ?? '预览打开失败');
        })
        .catch(() => setNotice('预览打开失败'));
    }, 60);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, open, initialUrl, taskId]);

  // 布局变化 → 同步 bounds
  useEffect(() => {
    if (!bridge) return;
    const sync = (): void => {
      const box = bounds();
      if (box) void bridge.setBounds(box);
      else void bridge.setBounds({ x: 0, y: 0, width: 1, height: 1, visible: false });
    };
    sync();
    const host = hostRef.current;
    const observer = host ? new ResizeObserver(sync) : null;
    if (host && observer) observer.observe(host);
    window.addEventListener('resize', sync);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', sync);
    };
  }, [bridge, bounds]);

  // 关闭时销毁视图
  useEffect(() => {
    if (!bridge) return;
    if (!open) {
      void bridge.close();
      setState(null);
    }
  }, [bridge, open]);

  useEffect(() => () => void bridge?.close(), [bridge]);

  const submit = (): void => {
    const value = url.trim();
    if (!value || !bridge) return;
    const verdict = classifyPreviewUrl(value);
    if (verdict.action === 'deny') {
      setNotice(verdict.reason);
      return;
    }
    setNotice(null);
    setUrl(value);
    if (!state) {
      const box = bounds();
      void bridge.open({
        taskId,
        url: value,
        bounds: box ?? { x: 0, y: 0, width: 520, height: 400, visible: true },
      });
      return;
    }
    void bridge.navigate(value);
  };

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const dragMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag) return;
    const next = Math.max(360, Math.min(840, drag.startWidth - (event.clientX - drag.startX)));
    setWidth(next);
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  if (!bridge) return null;

  return (
    <aside
      className="preview-dock relative shrink-0 flex flex-col border-l border-light-line/70 dark:border-dark-line/70 bg-light-bg/55 dark:bg-black/35 backdrop-blur-xl"
      style={{ width }}
      aria-hidden={hidden}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        className="absolute -left-1 top-0 bottom-0 w-2 cursor-col-resize z-10 group"
        onPointerDown={startDrag}
        onPointerMove={dragMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        title="拖动调宽"
      >
        <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-10 w-0.5 rounded-full bg-light-lineStrong dark:bg-dark-lineStrong opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>

      <div className="flex flex-col gap-1.5 px-2 py-2 border-b border-light-line/70 dark:border-dark-line/70">
        <div className="flex items-center gap-1">
        <button
          type="button"
          className="btn-ghost h-7 w-7 px-0 shrink-0"
          title="后退"
          disabled={!state?.canGoBack}
          onClick={() => void bridge.back()}
        >
          <Icon name="chevron" size={13} className="rotate-90" />
        </button>
        <button
          type="button"
          className="btn-ghost h-7 w-7 px-0 shrink-0"
          title="前进"
          disabled={!state?.canGoForward}
          onClick={() => void bridge.forward()}
        >
          <Icon name="chevron" size={13} className="-rotate-90" />
        </button>
        <button
          type="button"
          className="btn-ghost h-7 w-7 px-0 shrink-0"
          title="刷新"
          onClick={() => void bridge.reload()}
        >
          <Icon name="rotate" size={12} />
        </button>
        <form
          className="flex-1 min-w-0 flex items-center gap-1 rounded-lg border border-light-line dark:border-dark-line bg-white/55 dark:bg-white/[0.05] px-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Icon
            name="globe"
            size={11}
            className={state?.external ? 'text-amber-500 shrink-0' : 'text-light-inkFaint dark:text-dark-inkFaint shrink-0'}
          />
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            spellCheck={false}
            placeholder="http://localhost:5173"
            className="flex-1 min-w-0 h-7 bg-transparent border-0 outline-none text-[12.5px] font-mono text-light-ink dark:text-dark-ink placeholder:text-light-inkFaint dark:placeholder:text-dark-inkFaint"
          />
          {state?.loading && (
            <span className="w-3 h-3 shrink-0 rounded-full border-[1.5px] border-light-accent dark:border-dark-gold border-t-transparent animate-spin" />
          )}
        </form>
        </div>
        <div className="flex items-center gap-1">
        <div className="flex items-center gap-0.5 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] p-0.5 shrink-0">
          {(['desktop', 'tablet', 'phone'] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setDevice(item)}
              className={`px-1.5 h-6 rounded-md text-[11px] transition-colors ${
                device === item
                  ? 'bg-white/85 dark:bg-white/[0.14] text-light-ink dark:text-dark-ink shadow-sm'
                  : 'text-light-inkMuted dark:text-dark-inkMuted hover:text-light-ink dark:hover:text-dark-ink'
              }`}
              title={item === 'desktop' ? '铺满' : item === 'tablet' ? '平板 768' : '手机 390'}
            >
              {item === 'desktop' ? '桌' : item === 'tablet' ? '板' : '机'}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn-ghost h-7 w-7 px-0 shrink-0"
          title="缩小"
          onClick={() => {
            const next = Math.max(0.4, (state?.zoom ?? 1) - 0.1);
            void bridge.setZoom(next);
          }}
        >
          <Icon name="zoomOut" size={12} />
        </button>
        <span className="text-[11px] tabular-nums text-light-inkFaint dark:text-dark-inkFaint w-8 text-center shrink-0">
          {Math.round((state?.zoom ?? 1) * 100)}%
        </span>
        <button
          type="button"
          className="btn-ghost h-7 w-7 px-0 shrink-0"
          title="放大"
          onClick={() => {
            const next = Math.min(3, (state?.zoom ?? 1) + 0.1);
            void bridge.setZoom(next);
          }}
        >
          <Icon name="zoomIn" size={12} />
        </button>
        <span className="flex-1" />
        <button
          type="button"
          className="btn-ghost h-7 w-7 px-0 shrink-0"
          title="截图存到 artifacts"
          onClick={() => {
            void bridge.capture().then((result) => {
              if (result.ok && result.path) onCaptured(result.path);
              else setNotice(result.error ?? '截图失败');
            });
          }}
        >
          <Icon name="download" size={12} />
        </button>
        {onSendToModel && (
          <button
            type="button"
            className="btn-ghost h-7 px-2 shrink-0 text-[11.5px]"
            title="截图并加入输入（不会自动发送）"
            onClick={() => {
              void bridge.capture().then((result) => {
                if (result.ok && result.path) {
                  onSendToModel(result.path);
                  setNotice('截图已加入输入，确认后点发送');
                } else {
                  setNotice(result.error ?? '截图失败');
                }
              });
            }}
          >
            <Icon name="paperclip" size={12} />
            发给模型
          </button>
        )}
        <button
          type="button"
          className="btn-ghost h-7 w-7 px-0 shrink-0"
          title="在系统浏览器打开"
          onClick={() => {
            if (state?.url) window.open(state.url, '_blank', 'noopener');
          }}
        >
          <Icon name="output" size={12} />
        </button>
        <button type="button" className="btn-ghost h-7 w-7 px-0 shrink-0" title="关闭预览" onClick={onClose}>
          <Icon name="x" size={12} />
        </button>
        </div>
      </div>

      {(state?.pendingExternal || notice || state?.error) && (
        <div className="px-3 py-1.5 space-y-1 border-b border-light-line/60 dark:border-dark-line/60">
          {state?.pendingExternal && (
            <div className="flex items-center gap-2 text-[12px] text-amber-600 dark:text-amber-300">
              <Icon name="alert" size={11} />
              <span className="flex-1 truncate">
                页面想打开外部站点：<span className="font-mono">{state.pendingExternal}</span>
              </span>
              <button
                type="button"
                className="btn-ghost h-6"
                onClick={() => {
                  void bridge.allowExternal();
                  setNotice(null);
                }}
              >
                仍要打开
              </button>
              <button
                type="button"
                className="btn-ghost h-6"
                onClick={() => {
                  if (state.url) void bridge.navigate(state.url);
                }}
              >
                取消
              </button>
            </div>
          )}
          {(notice || state?.error) && (
            <div className="flex items-center gap-2 text-[12px] text-red-600 dark:text-red-300">
              <Icon name="alert" size={11} />
              <span className="flex-1 truncate">{notice ?? state?.error}</span>
              <button type="button" className="btn-ghost h-6" onClick={() => setNotice(null)}>
                知道了
              </button>
            </div>
          )}
        </div>
      )}

      {state?.external && (
        <div className="px-3 py-1 text-[11.5px] text-amber-600 dark:text-amber-300 bg-amber-500/[0.08] border-b border-amber-500/20">
          外部站点 · 本任务已临时允许（预览仍是独立会话，不共享应用登录态）
        </div>
      )}

      {hidden ? null : (
        <div ref={hostRef} className="relative flex-1 min-h-0 m-2 rounded-lg overflow-hidden bg-black/20">
          {!url && (
            <div className="absolute inset-0 grid place-items-center text-center px-4">
              <div>
                <Icon name="globe" size={20} className="mx-auto mb-2 text-light-inkFaint dark:text-dark-inkFaint" />
                <p className="text-[12.5px] text-light-inkMuted dark:text-dark-inkMuted">
                  输入 dev server 地址，或让 agent 跑起来后从工具卡点「在预览中打开」。
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
