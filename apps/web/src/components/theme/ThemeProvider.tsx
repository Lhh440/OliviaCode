import type { ReactNode } from 'react';
import { ThemeContext, useThemeState } from '../../hooks/useTheme';

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useThemeState();
  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}