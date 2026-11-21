import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons';
import { usePopoverExclusive } from '../hooks/usePopoverExclusive';

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
}

export interface SelectMenuProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** 输入区在底部，菜单往上弹；设置页往下弹 */
  placement?: 'up' | 'down';
  align?: 'left' | 'right';
  className?: string;
  buttonClassName?: string;
  /** 收起状态下的显示值；默认用当前选项的 label */
  renderValue?: (option: SelectOption | undefined) => string;
  title?: string;
  ariaLabel?: string;
  disabled?: boolean;
}

/**
 * 自定义下拉：原生 <select> 的弹层在暗色主题下是白底浅灰字，几乎看不清，
 * 所以模型、审批这类选择统一用它。支持点击外部/Esc 关闭。
 */
export function SelectMenu({
  value,
  options,
  onChange,
  placement = 'down',
  align = 'left',
  className,
  buttonClassName,
  renderValue,
  title,
  ariaLabel,
  disabled,
}: SelectMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // 全局只留一个浮层：打开这个菜单就把别的菜单/抽屉收起来
  usePopoverExclusive(open, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const onDocument = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDocument);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDocument);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = options.find((option) => option.value === value);
  const shown = renderValue ? renderValue(current) : current?.label ?? value;

  return (
    <div ref={rootRef} className={`relative ${className ?? ''}`}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        onClick={() => setOpen((state) => !state)}
        className={
          buttonClassName ??
          'flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-light-line dark:border-dark-line bg-white/55 dark:bg-white/[0.05] text-[13px] text-light-ink dark:text-dark-ink hover:bg-white/80 dark:hover:bg-white/[0.08] transition-colors'
        }
      >
        <span className="truncate">{shown}</span>
        <Icon
          name="chevron"
          size={11}
          className={`shrink-0 opacity-70 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={ariaLabel}
          className={`absolute z-50 min-w-full w-max max-w-[280px] p-1 rounded-xl border border-light-line dark:border-dark-line bg-light-panelStrong dark:bg-[rgba(14,20,26,0.98)] backdrop-blur-2xl shadow-2xl ${
            placement === 'up' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
          } ${align === 'right' ? 'right-0' : 'left-0'}`}
        >
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={`w-full flex items-start gap-2 px-2.5 py-1.5 rounded-lg text-left transition-colors ${
                  selected
                    ? 'bg-light-accent/[0.12] dark:bg-dark-accent/[0.18] text-light-ink dark:text-dark-ink'
                    : 'text-light-inkMuted dark:text-dark-inkMuted hover:bg-black/[0.04] dark:hover:bg-white/[0.06] hover:text-light-ink dark:hover:text-dark-ink'
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{option.label}</span>
                  {option.hint && (
                    <span
                      className="block truncate text-[11.5px] text-light-inkFaint dark:text-dark-inkFaint"
                      title={option.hint}
                    >
                      {option.hint}
                    </span>
                  )}
                </span>
                {selected && (
                  <Icon
                    name="check"
                    size={11}
                    className="mt-0.5 shrink-0 text-light-accent dark:text-dark-gold"
                  />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
