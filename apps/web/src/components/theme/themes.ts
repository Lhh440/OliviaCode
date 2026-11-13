/**
 * M7 · 动态主题
 *
 * 只有「背景」这一个维度：每套主题 = 一段动态影像（或一张静图）+ 一组配色。
 * 不再有亮/暗切换——整套界面固定为暗色玻璃质感，颜色随主题走。
 */

export type ThemeKind = 'video' | 'image';

export interface ThemePalette {
  /** 主强调色：按钮、焦点、选中态 */
  accent: string;
  accentStrong: string;
  /** 鎏金细线、标签 */
  gold: string;
  /** 正文主色 */
  ink: string;
  /** 页面底色（视频加载前可见） */
  bg: string;
}

export interface ThemePreset {
  id: string;
  name: string;
  caption: string;
  kind: ThemeKind;
  /** public/backgrounds 下的文件名 */
  file: string;
  poster?: string;
  position?: string;
  /** 静图的滤镜（视频不加，避免糊掉动态） */
  imageFilter?: string;
  /** 遮罩浓度：越大文字越清楚、背景越退后 */
  scrim: number;
  /** 遮罩基色，`r,g,b` 三段，用于拼 rgba() */
  scrimColor: string;
  palette: ThemePalette;
}

export const THEMES: ThemePreset[] = [
  {
    id: 'ink-abyss',
    name: '临渊',
    caption: '水墨 · 苍青 · 鹤影',
    kind: 'video',
    file: 'ink-abyss.mp4',
    poster: 'ink-abyss.jpg',
    position: 'center 44%',
    scrim: 0.52,
    scrimColor: '7,13,19',
    palette: {
      accent: '#5d94b8',
      accentStrong: '#457a9c',
      gold: '#c9b48a',
      ink: '#e6eef3',
      bg: '#070c11',
    },
  },
  {
    id: 'ink-mist',
    name: '烟雨',
    caption: '水墨 · 苔青 · 檐下',
    kind: 'video',
    file: 'ink-mist.mp4',
    poster: 'ink-mist.jpg',
    position: 'center 40%',
    scrim: 0.54,
    scrimColor: '9,14,10',
    palette: {
      accent: '#6f9a78',
      accentStrong: '#547a5e',
      gold: '#cfc39c',
      ink: '#e9efe5',
      bg: '#090e0a',
    },
  },
  {
    id: 'sakura',
    name: '花影',
    caption: '四月 · 樱 · 墙上春色',
    kind: 'image',
    file: 'sakura.jpg',
    position: 'center 42%',
    imageFilter: 'blur(1.5px) saturate(1.02) brightness(0.62)',
    scrim: 0.6,
    scrimColor: '16,9,13',
    palette: {
      accent: '#b5617a',
      accentStrong: '#944a61',
      gold: '#e2c4a6',
      ink: '#f4ecec',
      bg: '#120c10',
    },
  },
  {
    id: 'winter-forest',
    name: '雪林',
    caption: '冬雾 · 松影',
    kind: 'video',
    file: 'winter-forest.mp4',
    poster: 'winter-forest.jpg',
    position: 'center',
    scrim: 0.56,
    scrimColor: '10,12,15',
    palette: {
      accent: '#7b9fb5',
      accentStrong: '#5a7e96',
      gold: '#c4d1db',
      ink: '#eef3f6',
      bg: '#0a0c0f',
    },
  },
  {
    id: 'chibi',
    name: '初音',
    caption: '天蓝 · 跃动',
    kind: 'video',
    file: 'chibi.mp4',
    poster: 'chibi.jpg',
    position: 'center top',
    scrim: 0.48,
    scrimColor: '14,18,20',
    palette: {
      accent: '#39c5bb',
      accentStrong: '#2a9d96',
      gold: '#e8ba5c',
      ink: '#e8f4f3',
      bg: '#0e1214',
    },
  },
  {
    id: 'winter-sunrise',
    name: '海螺街',
    caption: '天光 · 冬晓',
    kind: 'video',
    file: 'winter-sunrise.mp4',
    poster: 'winter-sunrise.jpg',
    position: 'center',
    scrim: 0.54,
    scrimColor: '12,16,19',
    palette: {
      accent: '#6a9bc7',
      accentStrong: '#4f7ba3',
      gold: '#d4c4a8',
      ink: '#ecf1f5',
      bg: '#0c1013',
    },
  },
  {
    id: 'gojo',
    name: '无下限',
    caption: '六眼 · 领域',
    kind: 'video',
    file: 'gojo.mp4',
    poster: 'gojo.jpg',
    position: 'center top',
    scrim: 0.62,
    scrimColor: '8,10,13',
    palette: {
      accent: '#4ca9d1',
      accentStrong: '#3685aa',
      gold: '#c9b9d4',
      ink: '#e8f0f5',
      bg: '#08090d',
    },
  },
];

export const DEFAULT_THEME_ID = 'ink-abyss';

export function themeById(id: string | null | undefined): ThemePreset {
  return THEMES.find((item) => item.id === id) ?? THEMES[0]!;
}

/** 背景资源地址：兼容 dev 的 `/` 与打包后的 `./`。 */
export function themeAsset(file: string): string {
  return `${import.meta.env.BASE_URL}backgrounds/${file}`;
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