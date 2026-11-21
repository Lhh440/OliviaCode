/**
 * 主题：黑鱼白水 / 白鱼黑水
 *
 * 取自一段参考影像：近乎无色的水面上，锦鲤由「字块」拼成——每一格是一个方形像素，
 * 格子里压着随机字符，明暗靠抖动（dither）过渡；四周漂着零散的字屑，水纹是一圈圈
 * 极淡的椭圆。整套视觉只有两件事：水的底色，和鱼的明度。
 *
 * 所以这里只有两套主题，互为负片：
 *   koi-light 浅色 · 黑鱼白水 —— 纸白的水，墨黑的鱼
 *   koi-dark  深色 · 白鱼黑水 —— 墨黑的水，骨白的鱼
 *
 * 强调色不再是蓝/红这类彩色，而是「墨」本身：浅色主题用近黑，深色主题用近白，
 * 只保留一点暖赭（warm）作为刻度线、标签与代码的提示色，像影像里偶尔混进去的暖色块。
 */

export type ThemeMode = 'light' | 'dark';

export interface KoiPalette {
  /** 页面底色（canvas 还没画出来时可见） */
  bg: string;
  /** 水面：中心与边缘 */
  waterInner: string;
  waterOuter: string;
  /** 水面网格线 / 浮尘字屑 / 涟漪 */
  grid: string;
  dust: string;
  ring: string;
  /** 鱼身主色（用于图例与强调） */
  fish: string;
  /** 字块五级明度，索引 0 = 最靠近鱼脊 */
  cells: [string, string, string, string, string];
  /** 字块里的字符色 */
  glyph: string;
  /** 强调（按钮、链接、选中） */
  accent: string;
  accentStrong: string;
  onAccent: string;
  /** 暖赭：细节、标签、代码 */
  warm: string;
  ink: string;
  inkMuted: string;
  inkFaint: string;
  line: string;
  lineStrong: string;
  panel: string;
  panelStrong: string;
}

export interface ThemePreset {
  id: 'koi-light' | 'koi-dark';
  name: string;
  caption: string;
  mode: ThemeMode;
  /** 鱼的整体明度：鱼要能看见，但不能压过正文 */
  fishAlpha: number;
  palette: KoiPalette;
}

export const THEMES: ThemePreset[] = [
  {
    id: 'koi-light',
    name: '黑鱼白水',
    caption: '纸白 · 墨鱼 · 淡墨字屑',
    mode: 'light',
    fishAlpha: 0.8,
    palette: {
      bg: '#f2f1ec',
      waterInner: '#fbfaf6',
      waterOuter: '#e8e6de',
      grid: 'rgba(20, 22, 26, 0.045)',
      dust: 'rgba(20, 22, 26, 0.16)',
      ring: 'rgba(20, 22, 26, 0.11)',
      fish: '#14161a',
      cells: ['#0d0f12', '#202329', '#3a3e45', '#6d7076', '#a8a7a1'],
      glyph: 'rgba(250, 249, 244, 0.42)',
      accent: '#14161a',
      accentStrong: '#2b2e34',
      onAccent: '#fbfaf6',
      warm: '#a07850',
      ink: '#14161a',
      inkMuted: '#565a61',
      inkFaint: '#83868d',
      line: '#dedcd5',
      lineStrong: '#c8c5bc',
      panel: 'rgba(252, 251, 247, 0.72)',
      panelStrong: 'rgba(255, 254, 250, 0.95)',
    },
  },
  {
    id: 'koi-dark',
    name: '白鱼黑水',
    caption: '夜水 · 骨白鱼 · 微光字屑',
    mode: 'dark',
    fishAlpha: 0.62,
    palette: {
      bg: '#08090a',
      waterInner: '#121417',
      waterOuter: '#050607',
      grid: 'rgba(242, 241, 236, 0.05)',
      dust: 'rgba(242, 241, 236, 0.2)',
      ring: 'rgba(242, 241, 236, 0.12)',
      fish: '#f2f1ec',
      cells: ['#faf9f4', '#d9d8d1', '#a9a8a2', '#6b6d72', '#3a3d42'],
      glyph: 'rgba(8, 9, 10, 0.46)',
      accent: '#f2f1ec',
      accentStrong: '#d8d7d0',
      onAccent: '#0a0b0c',
      warm: '#c9a887',
      ink: '#f2f1ec',
      inkMuted: '#a5a6a4',
      inkFaint: '#7a7c80',
      line: '#232529',
      lineStrong: '#33363b',
      panel: 'rgba(12, 13, 15, 0.74)',
      panelStrong: 'rgba(15, 16, 18, 0.94)',
    },
  },
];

export const DEFAULT_THEME_ID = 'koi-light';

/** 旧版本（视频/静图主题）的 id 已经不存在，统一迁移到最接近的深色。 */
export function migrateThemeId(stored: string | null | undefined): string {
  if (!stored) return DEFAULT_THEME_ID;
  if (THEMES.some((item) => item.id === stored)) return stored;
  return 'koi-dark';
}

export function themeById(id: string | null | undefined): ThemePreset {
  return THEMES.find((item) => item.id === id) ?? THEMES[0]!;
}

/** `#6ea6c9` → `110,166,201`，给 canvas / rgba 用。 */
export function hexToRgb(hex: string): string {
  const value = hex.replace('#', '').trim();
  const full =
    value.length === 3
      ? value
          .split('')
          .map((char) => char + char)
          .join('')
      : value;
  const number = Number.parseInt(full, 16);
  if (!Number.isFinite(number)) return '160,190,210';
  return `${(number >> 16) & 255},${(number >> 8) & 255},${number & 255}`;
}