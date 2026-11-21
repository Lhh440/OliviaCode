import { createContext, useContext, useEffect, useState } from 'react';
import {
  DEFAULT_THEME_ID,
  hexToRgb,
  migrateThemeId,
  themeById,
  type ThemePreset,
} from '../components/theme/themes';

interface ThemeContextType {
  theme: ThemePreset;
  setTheme: (id: string) => void;
}

export const ThemeContext = createContext<ThemeContextType | null>(null);

const STORAGE_KEY = 'olivia.theme.v4';
const LEGACY_KEYS = ['olivia.theme.v3', 'olivia.skin', 'olivia.theme'];

function readInitial(): string {
  if (typeof window === 'undefined') return DEFAULT_THEME_ID;
  try {
    const stored = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem('olivia.theme.v3');
    // 旧主题（视频/静图）已经不存在：有旧记录的人继续留在深色，新用户从「白水」开始
    return migrateThemeId(stored);
  } catch {
    return DEFAULT_THEME_ID;
  }
}

export function useTheme(): ThemeContextType {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme 必须在 ThemeProvider 内使用');
  return context;
}

export function useThemeState(): [ThemePreset, (id: string) => void] {
  const [themeId, setThemeId] = useState<string>(readInitial);
  const theme = themeById(themeId);

  useEffect(() => {
    const root = document.documentElement;
    const palette = theme.palette;
    root.dataset.theme = theme.id;
    root.dataset.mode = theme.mode;
    // 现在真的有两套明暗：light 主题关掉 dark 类，Tailwind 的 light-* 才会生效
    root.classList.toggle('dark', theme.mode === 'dark');
    root.style.colorScheme = theme.mode;

    root.style.setProperty('--olivia-accent', palette.accent);
    root.style.setProperty('--olivia-accent-rgb', hexToRgb(palette.accent));
    root.style.setProperty('--olivia-accent-strong', palette.accentStrong);
    root.style.setProperty('--olivia-on-accent', palette.onAccent);
    root.style.setProperty('--olivia-gold', palette.warm);
    root.style.setProperty('--olivia-ink', palette.ink);
    root.style.setProperty('--olivia-ink-muted', palette.inkMuted);
    root.style.setProperty('--olivia-ink-faint', palette.inkFaint);
    root.style.setProperty('--olivia-line', palette.line);
    root.style.setProperty('--olivia-line-strong', palette.lineStrong);
    root.style.setProperty('--olivia-panel', palette.panel);
    root.style.setProperty('--olivia-panel-strong', palette.panelStrong);
    root.style.setProperty('--olivia-bg', palette.bg);
    root.style.setProperty('--olivia-water', palette.waterInner);
    root.style.setProperty('--olivia-fish', palette.fish);
    root.style.setProperty('--olivia-scrim', hexToRgb(palette.waterOuter));

    window.olivia?.theme?.set(theme.mode);
    try {
      localStorage.setItem(STORAGE_KEY, theme.id);
      for (const key of LEGACY_KEYS) localStorage.removeItem(key);
    } catch {
      // 隐私模式写不了也不影响使用
    }
  }, [theme]);

  return [theme, setThemeId];
}