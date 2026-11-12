import { createContext, useContext, useEffect, useState } from 'react';
import { DEFAULT_SKIN_ID, pairedSkin, skinById, type Skin, type SkinMode } from '../components/theme/skins';

interface ThemeContextType {
  skin: Skin;
  /** 当前皮肤的明暗（由皮肤本身决定） */
  mode: SkinMode;
  setSkin: (id: string) => void;
  /** 在同一组的亮/暗之间切换 */
  toggleMode: () => void;
}

export const ThemeContext = createContext<ThemeContextType | null>(null);

const STORAGE_KEY = 'olivia.skin';
const LEGACY_KEY = 'olivia.theme';

function readInitial(): string {
  if (typeof window === 'undefined') return DEFAULT_SKIN_ID;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) return stored;
  // 兼容旧版本只存了 light / dark 的情况
  const legacy = localStorage.getItem(LEGACY_KEY);
  if (legacy === 'dark') return 'collage';
  if (legacy === 'light') return 'angel';
  return DEFAULT_SKIN_ID;
}

export function useTheme(): ThemeContextType {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme 必须在 ThemeProvider 内使用');
  return context;
}

export function useThemeState(): [Skin, (id: string) => void] {
  const [skinId, setSkinId] = useState<string>(readInitial);
  const skin = skinById(skinId);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.skin = skin.id;
    if (skin.mode === 'dark') root.classList.add('dark');
    else root.classList.remove('dark');
    // 每套皮肤换掉主强调色，按钮/焦点/标题跟着变
    root.style.setProperty('--olivia-accent', skin.accent);
    root.style.setProperty('--olivia-accent-strong', skin.accentStrong);
    root.style.setProperty('--olivia-gold', skin.gold);
    localStorage.setItem(STORAGE_KEY, skin.id);
    localStorage.removeItem(LEGACY_KEY);
  }, [skin]);

  return [skin, setSkinId];
}

export { pairedSkin };
