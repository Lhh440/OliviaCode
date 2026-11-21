import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Icon } from '../../icons';
import { useTheme } from '../../hooks/useTheme';
import { THEMES, type ThemePreset } from './themes';

/**
 * 预览里的鱼：14×9 的字块剪影。
 * 用 SVG 画，比截背景更清楚，也省得为两套主题各存一张图。
 */
const FISH_MASK = [
  '..........####',
  '.......########',
  '#.#############',
  '.##############',
  '###############',
  '.##############',
  '#.#############',
  '.......########',
  '..........####',
];

function KoiPreview({ theme }: { theme: ThemePreset }) {
  const { palette } = theme;
  const cell = 4.1;
  return (
    <svg viewBox="0 0 62 40" className="h-full w-full" aria-hidden="true">
      <defs>
        <radialGradient id={`water-${theme.id}`} cx="50%" cy="42%" r="70%">
          <stop offset="0%" stopColor={palette.waterInner} />
          <stop offset="100%" stopColor={palette.waterOuter} />
        </radialGradient>
      </defs>
      <rect width="62" height="40" fill={`url(#water-${theme.id})`} />
      <g opacity="0.55">
        {Array.from({ length: 9 }, (_item, index) => (
          <line
            key={`h${index}`}
            x1="0"
            x2="62"
            y1={index * 5 + 2.5}
            y2={index * 5 + 2.5}
            stroke={palette.grid}
            strokeWidth="0.4"
          />
        ))}
        {Array.from({ length: 11 }, (_item, index) => (
          <line
            key={`v${index}`}
            y1="0"
            y2="40"
            x1={index * 6 + 1}
            x2={index * 6 + 1}
            stroke={palette.grid}
            strokeWidth="0.4"
          />
        ))}
      </g>
      {FISH_MASK.map((row, y) =>
        row.split('').map((mark, x) =>
          mark === '#' ? (
            <rect
              key={`${x}-${y}`}
              x={7 + x * cell}
              y={3 + y * cell}
              width={cell + 0.3}
              height={cell + 0.3}
              fill={palette.cells[(x + y) % 2 === 0 ? 1 : 2]}
              opacity={0.72 + ((x * 7 + y * 3) % 5) * 0.055}
            />
          ) : null,
        ),
      )}
      <text
        x="52"
        y="37"
        fontSize="3.4"
        fill={palette.dust}
        fontFamily="ui-monospace, Consolas, monospace"
      >
        #
      </text>
    </svg>
  );
}

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
      className={`group relative block w-full overflow-hidden rounded-xl border text-left transition-all duration-300 ${
        active
          ? 'border-[color:var(--olivia-accent)] ring-1 ring-[color:var(--olivia-accent)]'
          : 'border-light-line dark:border-dark-line opacity-90 hover:opacity-100'
      }`}
    >
      <span className="relative block h-[78px] w-full overflow-hidden">
        <KoiPreview theme={theme} />
        <span className="absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-transparent dark:from-black/55" />
        <span className="absolute left-2 top-2 flex items-center gap-1 rounded-full bg-black/45 px-1.5 py-0.5 text-[10px] tracking-wide text-white/85 backdrop-blur-sm">
          <Icon name={theme.mode === 'light' ? 'sun' : 'moon'} size={8} />
          {theme.mode === 'light' ? '浅色' : '深色'}
        </span>
        <span className="absolute left-2 bottom-1.5 block text-[13.5px] font-semibold text-white drop-shadow">
          {theme.name}
        </span>
        <span className="absolute right-2 bottom-1.5 block text-[10.5px] text-white/65">
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
            ? 'bg-black/[0.06] dark:bg-white/[0.12] text-light-ink dark:text-dark-ink'
            : 'text-light-inkMuted dark:text-dark-inkMuted hover:bg-black/[0.05] dark:hover:bg-white/[0.08] hover:text-light-ink dark:hover:text-dark-ink'
        }`}
        title="切换明暗主题"
      >
        <Icon name={theme.mode === 'light' ? 'sun' : 'moon'} size={14} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="absolute left-0 top-full mt-2 z-50 w-[280px] p-3 rounded-xl border border-light-line dark:border-dark-line bg-light-panelStrong dark:bg-[rgba(12,13,15,0.96)] backdrop-blur-2xl shadow-2xl"
          >
            <div className="flex items-center justify-between mb-2.5">
              <span className="eyebrow">明暗</span>
              <span className="text-[12px] text-light-inkFaint dark:text-dark-inkFaint">
                两套 · 一张画的正负片
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
            <p className="mt-2.5 text-[11px] leading-relaxed text-light-inkFaint dark:text-dark-inkFaint">
              鱼身上的每一格都是一个字符；点击任意处会有水纹。
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}