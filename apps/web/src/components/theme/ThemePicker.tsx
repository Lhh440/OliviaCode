import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Icon } from '../../icons';
import { useTheme } from '../../hooks/useTheme';
import { FAMILIES, type Skin } from './skins';

function SkinThumb({ skin, active, onClick }: { skin: Skin; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={`${skin.name} · ${skin.caption}`}
      className={`group relative overflow-hidden rounded-lg text-left transition-all duration-200 ${
        active
          ? 'ring-2 ring-offset-2 ring-offset-transparent'
          : 'opacity-80 hover:opacity-100'
      }`}
      style={active ? ({ ['--tw-ring-color' as string]: 'var(--olivia-accent)' } as React.CSSProperties) : undefined}
    >
      <span className="relative block h-14 w-full overflow-hidden">
        <img src={skin.image} alt="" className="absolute inset-0 h-full w-full object-cover" style={{ filter: skin.art.filter }} />
        {skin.art.tint && (
          <span
            className="absolute inset-0"
            style={{
              backgroundColor: skin.art.tint.color,
              mixBlendMode: skin.art.tint.blend,
              opacity: skin.art.tint.opacity,
            }}
          />
        )}
        <span className="absolute inset-0 bg-gradient-to-t from-black/55 via-black/10 to-transparent" />
        <span className="absolute left-1.5 bottom-1 text-[10.5px] font-medium text-white drop-shadow">
          {skin.name}
        </span>
        <span className="absolute right-1.5 bottom-1 text-[9px] uppercase tracking-wider text-white/70">
          {skin.mode === 'light' ? '亮' : '暗'}
        </span>
      </span>
    </button>
  );
}

export function ThemePicker() {
  const { skin, setSkin } = useTheme();
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
        title="切换主题"
      >
        <Icon name="palette" size={14} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            className="absolute left-0 top-full mt-2 z-50 w-[272px] p-3 rounded-xl border border-light-line dark:border-dark-line bg-light-panelStrong dark:bg-[rgba(20,16,22,0.95)] backdrop-blur-2xl shadow-2xl"
          >
            <div className="flex items-center justify-between mb-2.5">
              <span className="eyebrow !text-light-inkFaint dark:!text-dark-inkFaint">主题</span>
              <span className="text-[10.5px] text-light-inkFaint dark:text-dark-inkFaint">共 4 套</span>
            </div>

            <div className="space-y-3">
              {FAMILIES.map((family) => (
                <div key={family.id}>
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <span className="text-[11px] font-medium text-light-ink dark:text-dark-ink">
                      {family.name}
                    </span>
                    <span className="flex-1 h-px bg-light-line dark:bg-dark-line" />
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {[family.light, family.dark].map((item) => (
                      <SkinThumb
                        key={item.id}
                        skin={item}
                        active={item.id === skin.id}
                        onClick={() => {
                          setSkin(item.id);
                          setOpen(false);
                        }}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
