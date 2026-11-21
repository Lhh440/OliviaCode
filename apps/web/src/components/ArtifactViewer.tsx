import { useEffect, useState } from 'react';
import { artifactUrl, isAudioFile, isImageFile } from '@olivia/core';
import { Icon } from '../icons';

export interface ArtifactViewerProps {
  path: string;
  onClose: () => void;
  /** M8：图片可以加入 Composer 输入托盘，仍需用户确认发送 */
  onAddInput?: () => void;
}

/** 工具返回的图片/音频/文本预览；只走 olivia-artifact 白名单协议。 */
export function ArtifactViewer({ path, onClose, onAddInput }: ArtifactViewerProps) {
  const url = artifactUrl(path);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const image = isImageFile(path);
  const audio = isAudioFile(path);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (image || audio) return;
    let alive = true;
    void fetch(url)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.text();
        if (alive) setText(body.length > 200_000 ? `${body.slice(0, 200_000)}\n…（已截断）` : body);
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      alive = false;
    };
  }, [url, image, audio]);

  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-black/55 backdrop-blur-sm p-8"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="relative max-w-[min(920px,92vw)] max-h-[86vh] w-full flex flex-col rounded-2xl overflow-hidden border border-light-line dark:border-dark-line bg-light-panelStrong dark:bg-dark-panelStrong shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3.5 py-2 border-b border-light-line/70 dark:border-dark-line/70">
          <Icon name={image ? 'file' : audio ? 'terminal' : 'file'} size={12} className="text-light-inkMuted dark:text-dark-inkMuted" />
          <span className="flex-1 min-w-0 truncate text-[12.5px] font-mono text-light-ink dark:text-dark-ink">
            {path}
          </span>
          {image && onAddInput && (
            <button
              type="button"
              className="btn-ghost h-7"
              title="加入输入（不会自动发送）"
              onClick={onAddInput}
            >
              <Icon name="paperclip" size={12} />
              加入输入
            </button>
          )}
          <button
            type="button"
            className="btn-ghost h-7"
            onClick={() => {
              void navigator.clipboard?.writeText(path).catch(() => undefined);
            }}
          >
            复制路径
          </button>
          <button type="button" className="btn-ghost h-7 w-7 px-0" onClick={onClose} title="关闭">
            <Icon name="x" size={13} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto grid place-items-center p-3">
          {image ? (
            <img src={url} alt="" className="max-h-[70vh] max-w-full object-contain rounded-lg" />
          ) : audio ? (
            <audio src={url} controls className="w-full" />
          ) : error ? (
            <p className="text-[13px] text-red-600 dark:text-red-300">读不到这个文件：{error}</p>
          ) : text === null ? (
            <span className="text-[13px] text-light-inkMuted dark:text-dark-inkMuted">读取中…</span>
          ) : (
            <pre className="w-full max-h-[70vh] overflow-auto text-[12.5px] font-mono leading-relaxed whitespace-pre-wrap break-all text-light-ink dark:text-dark-ink">
              {text}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
