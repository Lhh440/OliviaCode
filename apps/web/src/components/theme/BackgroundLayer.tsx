import { useEffect, useRef, useState } from 'react';
import { useTheme } from '../../hooks/useTheme';
import { KoiScene } from './KoiScene';
import type { ThemePreset } from './themes';

/**
 * 主题背景：黑鱼白水 / 白鱼黑水。
 *
 * 两套主题是同一张画的正负片，所以切换时让旧场景停在最后一帧淡出、
 * 新场景淡入，像水面换了一次光，而不是硬切。
 */
export function BackgroundLayer() {
  const { theme } = useTheme();
  const [previous, setPrevious] = useState<ThemePreset | null>(null);
  const last = useRef(theme);

  useEffect(() => {
    if (last.current.id === theme.id) return;
    const outgoing = last.current;
    last.current = theme;
    setPrevious(outgoing);
    const timer = setTimeout(() => setPrevious(null), 1500);
    return () => clearTimeout(timer);
  }, [theme]);

  return (
    <div className="scene" aria-hidden="true">
      <div className="scene-base" style={{ background: theme.palette.bg }} />
      {previous && (
        <div className="scene-layer is-prev" key={`prev-${previous.id}`}>
          <KoiScene theme={previous} still />
        </div>
      )}
      <div className="scene-layer" key={theme.id}>
        <KoiScene theme={theme} />
      </div>
      <div className="scene-vignette" />
      <div className="scene-grain" />
    </div>
  );
}