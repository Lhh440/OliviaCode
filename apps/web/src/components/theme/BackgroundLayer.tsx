import { useEffect, useRef, useState } from 'react';
import { useTheme } from '../../hooks/useTheme';
import { themeAsset, type ThemePreset } from './themes';

/**
 * 动态主题背景。
 *
 * - 视频：静音、循环、内联播放，`canplay` 后 1.4s 渐显（不会黑屏硬切）。
 * - 静图：慢速推镜（Ken Burns）+ 轻模糊，掩盖低分辨率。
 * - 切换：旧图层留在下面，新图层淡入，形成交叉溶解。
 */

function scrimOf(theme: ThemePreset): string {
  const c = theme.scrimColor;
  const s = theme.scrim;
  const a = (value: number): string => `rgba(${c},${(value * s).toFixed(3)})`;
  return [
    `radial-gradient(125% 95% at 60% 36%, ${a(0)} 0%, ${a(0.08)} 42%, ${a(0.62)} 100%)`,
    `linear-gradient(90deg, ${a(0.96)} 0%, ${a(0.66)} 14%, ${a(0.18)} 46%, ${a(0.04)} 100%)`,
    `linear-gradient(0deg, ${a(0.82)} 0%, ${a(0.26)} 26%, ${a(0.02)} 58%)`,
  ].join(', ');
}

function MediaLayer({ theme, previous = false }: { theme: ThemePreset; previous?: boolean }) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <div className={`scene-layer ${ready ? 'is-ready' : ''} ${previous ? 'is-prev' : ''}`}>
      {theme.kind === 'video' ? (
        <video
          key={theme.id}
          className="scene-media scene-video"
          src={themeAsset(theme.file)}
          poster={theme.poster ? themeAsset(theme.poster) : undefined}
          style={{ objectPosition: theme.position ?? 'center' }}
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          onCanPlay={() => setReady(true)}
          onError={() => setFailed(true)}
        />
      ) : (
        <img
          key={theme.id}
          className="scene-media scene-image"
          src={themeAsset(theme.file)}
          alt=""
          style={{ objectPosition: theme.position ?? 'center', filter: theme.imageFilter }}
          onLoad={() => setReady(true)}
          onError={() => setFailed(true)}
        />
      )}
      {failed && <div className="scene-fallback" />}
      <div className="scene-scrim" style={{ background: scrimOf(theme) }} />
    </div>
  );
}

export function BackgroundLayer() {
  const { theme } = useTheme();
  const [previous, setPrevious] = useState<ThemePreset | null>(null);
  const last = useRef(theme);

  useEffect(() => {
    if (last.current.id === theme.id) return;
    const outgoing = last.current;
    last.current = theme;
    setPrevious(outgoing);
    const timer = setTimeout(() => setPrevious(null), 1600);
    return () => clearTimeout(timer);
  }, [theme]);

  return (
    <div className="scene" aria-hidden="true">
      <div className="scene-base" style={{ background: theme.palette.bg }} />
      {previous && <MediaLayer key={`prev-${previous.id}`} theme={previous} previous />}
      <MediaLayer key={theme.id} theme={theme} />
      <div className="scene-vignette" />
      <div className="scene-grain" />
    </div>
  );
}