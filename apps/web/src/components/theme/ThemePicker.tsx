import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Icon } from '../../icons';
import { useTheme } from '../../hooks/useTheme';
import { THEMES, themeAsset, type ThemePreset } from './themes';

function ThemeTile({
  theme,
  active,
  onPick,
}: {
  theme: ThemePreset;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      onClick={onPick}
      title={`${theme.name} · ${theme.caption}`}
      className={`group relative overflow-hidden rounded-xl text-left transition-all duration-300 ${
        active ? 'ring-2 ring-offset-2 ring-offset-transparent' : 'opacity-85 hover:opacity-100'
      }`}
      style={
        active
          ? ({ ['--tw-ring-color' as string]: 'var(--olivia-accent)' } as React.CSSProperties)
          : undefined
      }
    >
      <span className="relative block h-[74px] w-full overflow-hidden">
        <img
          src={themeAsset(theme.poster ?? theme.file)}
          alt=""
          className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 group-hover:scale-105"
          style={{ objectPosition: theme.position ?? 'center' }}
          loading="lazy"
        />
        <span className="absolute inset-0 bg-gradient-to-t from-black/78 via-black/20 to-black/5" />
        <span className="absolute left-2 top-2 flex items-center gap-1 rounded-full bg-black/45 px-1.5 py-0.5 text-[9px] tracking-wide text-white/85 backdrop-blur-sm">
          <Icon name={theme.kind === 'video' ? 'play' : 'file'} size={8} />
          {theme.kind === 'video' ? '动态' : '静态'}
        </span>
        <span className="absolute left-2 bottom-1.5 block text-[12px] font-semibold text-white drop-shadow">
          {theme.name}
        </span>
        <span className="absolute right-2 bottom-1.5 block text-[9.5px] text-white/65">
          {theme.caption.split(' · ')[0]}
        </span>
        {active && (
          <span className="absolute right-2 top-2 grid h-4 w-4 place-items-center rounded-full bg-white/90 text-black">
            <Icon name="check" size={9} />
          </span>
        )}
      </span>
    </button>
  );
}

export function ThemePicker() {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((value) => !value)}
        className={`w-7 h-7 shrink-0 grid place-items-center rounded-lg transition-colors ${
          open
            ? 'bg-white/[0.12] text-light-ink dark:text-dark-ink'
            : 'text-light-inkMuted dark:text-dark-inkMuted hover:bg-white/[0.08] hover:text-light-ink dark:hover:text-dark-ink'
        }`}
        title="切换主题背景"
      >
        <Icon name="palette" size={14} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="absolute left-0 top-full mt-2 z-50 w-[286px] p-3 rounded-xl border border-light-line dark:border-dark-line bg-[rgba(14,18,23,0.94)] backdrop-blur-2xl shadow-2xl"
          >
            <div className="flex items-center justify-between mb-2.5">
              <span className="eyebrow !text-light-inkFaint dark:!text-dark-inkFaint">主题背景</span>
              <span className="text-[10.5px] text-light-inkFaint dark:text-dark-inkFaint">
                {THEMES.length} 套 · 点击切换
              </span>
            </div>
            <div className="space-y-2">
              {THEMES.map((item) => (
                <ThemeTile
                  key={item.id}
                  theme={item}
                  active={item.id === theme.id}
                  onPick={() => {
                    setTheme(item.id);
                    setOpen(false);
                  }}
                />
              ))}
            </div>
            <p className="mt-2.5 text-[10px] leading-relaxed text-light-inkFaint dark:text-dark-inkFaint">
              背景渐显，点击任意处会有水纹；视频静音循环。
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}