import { createContext, useContext, useEffect, useState } from 'react';
import { DEFAULT_THEME_ID, hexToRgb, themeById, type ThemePreset } from '../components/theme/themes';

interface ThemeContextType {
  theme: ThemePreset;
  setTheme: (id: string) => void;
}

export const ThemeContext = createContext<ThemeContextType | null>(null);

const STORAGE_KEY = 'olivia.theme.v3';
const LEGACY_KEYS = ['olivia.skin', 'olivia.theme'];

function readInitial(): string {
  if (typeof window === 'undefined') return DEFAULT_THEME_ID;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) return themeById(stored).id;
  return DEFAULT_THEME_ID;
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
    root.dataset.theme = theme.id;
    // 只有一套暗色玻璃 UI：固定 dark，不再有亮暗切换
    root.classList.add('dark');
    root.style.setProperty('--olivia-accent', theme.palette.accent);
    root.style.setProperty('--olivia-accent-rgb', hexToRgb(theme.palette.accent));
    root.style.setProperty('--olivia-accent-strong', theme.palette.accentStrong);
    root.style.setProperty('--olivia-gold', theme.palette.gold);
    root.style.setProperty('--olivia-ink', theme.palette.ink);
    root.style.setProperty('--olivia-bg', theme.palette.bg);
    root.style.setProperty('--olivia-scrim', theme.scrimColor);
    window.olivia?.theme?.set('dark');
    localStorage.setItem(STORAGE_KEY, theme.id);
    for (const key of LEGACY_KEYS) localStorage.removeItem(key);
  }, [theme]);

  return [theme, setThemeId];
}