import { ReactNode } from 'react';
import { ThemeContext, pairedSkin, useThemeState } from '../../hooks/useTheme';

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [skin, setSkin] = useThemeState();

  const toggleMode = () => {
    setSkin(pairedSkin(skin).id);
  };

  return (
    <ThemeContext.Provider value={{ skin, mode: skin.mode, setSkin, toggleMode }}>
      {children}
    </ThemeContext.Provider>
  );
}
