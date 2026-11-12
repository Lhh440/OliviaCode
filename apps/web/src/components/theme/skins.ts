import lightAngel from '../../assets/backgrounds/light-angel.jpg';
import darkSurreal from '../../assets/backgrounds/dark-surreal.jpg';
import lilyLitany from '../../assets/backgrounds/lily-litany.jpg';
import madonnaGloria from '../../assets/backgrounds/madonna-gloria.jpg';

export type SkinMode = 'light' | 'dark';

/** 装饰层类型：不同主题配不同的几何/超现实纹样 */
export type Ornament = 'sunburst' | 'eyewheel' | 'lace' | 'starfall';

export interface Skin {
  id: string;
  name: string;
  caption: string;
  mode: SkinMode;
  family: string;
  image: string;
  /** 版画本体参数 */
  art: {
    position: string;
    filter: string;
    tint?: { color: string; blend: 'color' | 'soft-light' | 'overlay'; opacity: number };
    /** 左侧遮罩起点 */
    maskFrom: string;
    /** 纵向占位：极宽的图用横带，避免被 cover 裁成局部 */
    box?: { top: string; bottom: string };
    /** 横带需要在上下边缘做羽化 */
    fadeY?: boolean;
  };
  ornament: Ornament;
  /** 该主题的强调色（主按钮 / 焦点 / 标题渐变） */
  accent: string;
  accentStrong: string;
  gold: string;
}

export const SKINS: Skin[] = [
  {
    id: 'angel',
    name: '钴蓝天使',
    caption: '古典 × 蒸汽波',
    mode: 'light',
    family: 'atelier',
    image: lightAngel,
    art: {
      position: 'center 38%',
      filter: 'grayscale(1) brightness(1.2) contrast(1.1)',
      tint: { color: '#2f5bd7', blend: 'color', opacity: 0.92 },
      maskFrom: '16%',
    },
    ornament: 'sunburst',
    accent: '#2f5bd7',
    accentStrong: '#2449b8',
    gold: '#a8853f',
  },
  {
    id: 'collage',
    name: '朱红拼贴',
    caption: '超现实',
    mode: 'dark',
    family: 'atelier',
    image: darkSurreal,
    art: {
      position: 'center 44%',
      filter: 'blur(2px) saturate(0.95) contrast(1.06)',
      tint: { color: '#7a1520', blend: 'soft-light', opacity: 0.34 },
      maskFrom: '16%',
    },
    ornament: 'eyewheel',
    accent: '#f0354a',
    accentStrong: '#d92b3f',
    gold: '#e0b45a',
  },
  {
    id: 'lily',
    name: '白百合',
    caption: '织物 × 挽歌',
    mode: 'light',
    family: 'litany',
    image: lilyLitany,
    art: {
      position: 'center 46%',
      filter: 'grayscale(0.55) brightness(1.05) contrast(0.98)',
      tint: { color: '#8d857a', blend: 'color', opacity: 0.42 },
      maskFrom: '8%',
      box: { top: '26%', bottom: '20%' },
      fadeY: true,
    },
    ornament: 'lace',
    accent: '#413b33',
    accentStrong: '#2b2721',
    gold: '#9c8b6b',
  },
  {
    id: 'madonna',
    name: '荆棘圣母',
    caption: '圣像 × 巨眼',
    mode: 'dark',
    family: 'litany',
    image: madonnaGloria,
    art: {
      position: 'center 44%',
      filter: 'saturate(1.02) contrast(1.04) brightness(0.94)',
      maskFrom: '14%',
    },
    ornament: 'starfall',
    accent: '#d8323f',
    accentStrong: '#b8242f',
    gold: '#cfc8bd',
  },
];

export const DEFAULT_SKIN_ID = 'angel';

export function skinById(id: string | null | undefined): Skin {
  return SKINS.find((skin) => skin.id === id) ?? SKINS[0]!;
}

/** 同一「组」里的另一套（亮 ↔ 暗） */
export function pairedSkin(skin: Skin): Skin {
  return SKINS.find((item) => item.family === skin.family && item.mode !== skin.mode) ?? skin;
}

export interface SkinFamily {
  id: string;
  name: string;
  light: Skin;
  dark: Skin;
}

export const FAMILIES: SkinFamily[] = ['atelier', 'litany'].map((family) => ({
  id: family,
  name: family === 'atelier' ? '工坊' : '祷歌',
  light: SKINS.find((skin) => skin.family === family && skin.mode === 'light')!,
  dark: SKINS.find((skin) => skin.family === family && skin.mode === 'dark')!,
}));
