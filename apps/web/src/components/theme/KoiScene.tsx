import { useEffect, useRef } from 'react';
import type { ThemePreset } from './themes';

/**
 * 主题场景：黑鱼白水 / 白鱼黑水。
 *
 * 参考影像里的鱼不是画出来的，是「排」出来的：鱼身被切成一个个方形字块，
 * 每块里压着一个随机字符，明暗靠抖动分级；边缘不描线，靠字块稀疏散开。
 * 所以这里不用图片或视频，而是用 canvas 直接排字块：
 *
 *   1. 水面：径向底色 + 中心柔光 + 极淡网格 + 漂移的字屑 + 一圈圈椭圆水纹
 *   2. 鱼：在世界坐标里按屏幕网格逐格取样，把格心换算到鱼身坐标系，判断
 *      「在体内 / 在鳍上 / 在外面」，再按离鱼脊的距离分成五级明度
 *   3. 游动：鱼沿缓慢的李萨如轨迹漂移，鱼脊按正弦波摆动，尾摆幅度更大
 *
 * 浅色主题把「墨」放在鱼身上，深色主题反过来；两套主题共用同一套几何。
 */

const CELL = 12;
const LEVELS = 5;
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*+=<>/';

interface Koi {
  cx: number;
  cy: number;
  ax: number;
  ay: number;
  wx: number;
  wy: number;
  px: number;
  py: number;
  len: number;
  depth: number;
  wave: number;
}

/**
 * 鱼群的位置是构图的一部分，不是随机的：
 * 0 号鱼住在侧栏下段的空白带（「最近任务」与底栏之间）——阅读带衰减之后，
 * 鱼的真身只在这里露脸，主题的味道从侧栏出来；
 * 其余三条沿着阅读带的右缘与下缘游，作水下投影。
 * （真正兜住可读性的是下面的「阅读带」衰减，这里只是让构图好看一点。）
 */
const KOIS: Koi[] = [
  { cx: 0.115, cy: 0.63, ax: 0.02, ay: 0.012, wx: 0.13, wy: 0.09, px: 0.4, py: 1.9, len: 0.24, depth: 0.9, wave: 0 },
  { cx: 0.84, cy: 0.34, ax: 0.05, ay: 0.025, wx: 0.1, wy: 0.12, px: 2.4, py: 0.6, len: 0.26, depth: 0.65, wave: 1.7 },
  { cx: 0.6, cy: 0.8, ax: 0.07, ay: 0.02, wx: 0.08, wy: 0.11, px: 4.1, py: 3.2, len: 0.26, depth: 1, wave: 3.1 },
  { cx: 0.9, cy: 0.6, ax: 0.03, ay: 0.03, wx: 0.11, wy: 0.08, px: 5.2, py: 4.4, len: 0.2, depth: 0.55, wave: 4.6 },
];

/**
 * 阅读带：主内容区（侧栏右侧）整天都是正文——页头、标题、消息、卡片、输入框。
 *
 * 鱼可以游过去，但不能在字底下留一块硬边。所以在进入这条带之后，
 * 字块按「离侧栏越远越淡」平滑衰减（左缘 176px 的羽化），
 * 只剩一层水下投影；鱼形还在，只是被水压住了。
 * 侧栏那一条留给鱼本身，主题的味道就从那里出来。
 */
interface ReadingBand {
  /** 主内容区的左界（侧栏宽度） */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** 左缘羽化宽度 */
  feather: number;
  /** 带内的衰减强度：0 = 不衰减，1 = 完全看不见 */
  strength: number;
}

function smoothstep(t: number): number {
  const k = Math.min(1, Math.max(0, t));
  return k * k * (3 - 2 * k);
}

function bandQuiet(x: number, y: number, band: ReadingBand): number {
  const enter = smoothstep((x - band.x0) / band.feather);
  const leave = smoothstep((x - band.x1 + band.feather) / band.feather);
  const top = smoothstep((y - band.y0) / band.feather);
  const bottom = smoothstep((y - band.y1 + band.feather) / band.feather);
  // leave / bottom 都是「离开带」方向的量，取 1 减：带底（y1 撑到视口外）在屏幕上永远不衰减。
  // 这里曾漏掉 1 - bottom，quiet 恒为 0，阅读带整层失效、鱼一直全强度压在正文上。
  return Math.max(0, Math.min(enter, 1 - leave, top, 1 - bottom));
}


/** 鱼身半宽轮廓：头圆、胸腹最宽、尾柄收细。 */
const PROFILE: [number, number][] = [
  [0, 0.34],
  [0.05, 0.68],
  [0.12, 0.9],
  [0.22, 1],
  [0.45, 1],
  [0.6, 0.9],
  [0.72, 0.62],
  [0.82, 0.34],
  [0.9, 0.2],
  [1, 0.14],
];

function halfProfile(t: number): number {
  for (let index = 1; index < PROFILE.length; index += 1) {
    const point = PROFILE[index]!;
    if (t <= point[0]) {
      const previous = PROFILE[index - 1]!;
      const k = (t - previous[0]) / (point[0] - previous[0] || 1);
      const smooth = k * k * (3 - 2 * k);
      return previous[1] + (point[1] - previous[1]) * smooth;
    }
  }
  return PROFILE[PROFILE.length - 1]![1];
}

/** 鱼脊的侧向摆动：头部几乎不动，越到尾摆幅越大。 */
function spineOffset(t: number, phase: number): number {
  const amplitude = 0.03 + 0.75 * t ** 2;
  return Math.sin(t * 3.1 - phase) * amplitude;
}

function hash3(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

interface Atlas {
  canvas: HTMLCanvasElement;
  /** 图集里一格的设备像素 */
  cell: number;
  /** 画到界面上的一格 CSS 像素 */
  draw: number;
}

function buildAtlas(theme: ThemePreset, cell: number, draw: number): Atlas {
  const canvas = document.createElement('canvas');
  canvas.width = GLYPHS.length * cell;
  canvas.height = LEVELS * cell;
  const ctx = canvas.getContext('2d')!;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${Math.max(7, Math.round(cell * 0.6))}px ui-monospace, SFMono-Regular, Consolas, monospace`;
  for (let level = 0; level < LEVELS; level += 1) {
    for (let index = 0; index < GLYPHS.length; index += 1) {
      const x = index * cell;
      const y = level * cell;
      ctx.fillStyle = theme.palette.cells[level]!;
      ctx.fillRect(x, y, cell, cell);
      ctx.fillStyle = theme.palette.glyph;
      ctx.fillText(GLYPHS[index]!, x + cell / 2, y + cell / 2 + cell * 0.03);
    }
  }
  return { canvas, cell, draw };
}

function drawKoi(
  ctx: CanvasRenderingContext2D,
  atlas: Atlas,
  koi: Koi,
  time: number,
  width: number,
  height: number,
  alpha: number,
  band: ReadingBand,
): void {
  const minSide = Math.min(width, height);
  const length = koi.len * minSide;
  const maxHalf = length * 0.135;
  const phase = time * (0.5 + koi.depth * 0.4) + koi.wave;

  const cx = koi.cx * width + Math.sin(time * koi.wx + koi.px) * koi.ax * width;
  const cy = koi.cy * height + Math.sin(time * koi.wy + koi.py) * koi.ay * height;
  const vx = Math.cos(time * koi.wx + koi.px) * koi.ax * width * koi.wx;
  const vy = Math.cos(time * koi.wy + koi.py) * koi.ay * height * koi.wy;
  const angle = Math.atan2(vy, vx) + 0.1;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const draw = atlas.draw;
  const seed = Math.round(koi.len * 1000 + koi.depth * 100);

  const reachX = length * 0.76 + maxHalf * 2;
  const reachY = length * 0.42 + maxHalf * 2;
  const startX = Math.floor((cx - reachX) / draw) * draw;
  const startY = Math.floor((cy - reachY) / draw) * draw;
  const endX = cx + reachX;
  const endY = cy + reachY;

  const baseAlpha = alpha * (0.62 + koi.depth * 0.38);

  for (let wx = startX; wx <= endX; wx += draw) {
    for (let wy = startY; wy <= endY; wy += draw) {
      const dx = wx - cx;
      const dy = wy - cy;
      const lx = dx * cos + dy * sin;
      const ly = -dx * sin + dy * cos;

      // 鱼身坐标系：t 从头 0 到尾 1，lateral 是相对鱼脊的侧向距离
      const t = lx / length + 0.5;
      if (t < -0.02 || t > 1.32) continue;
      const tt = Math.min(1, Math.max(0, t));
      const half = halfProfile(tt) * maxHalf;
      const spine = spineOffset(tt, phase) * maxHalf * 0.85;
      const lateral = ly - spine;
      const offset = Math.abs(lateral);
      const k = offset / Math.max(1, half);

      const gx = Math.round(wx / draw);
      const gy = Math.round(wy / draw);
      const noise = hash3(gx, gy, seed);

      let level = -1;

      // 尾鳍：向后分叉的两片，只有边缘有字块
      if (t > 0.9 && t < 1.22) {
        const lobe = maxHalf * (0.3 + 2.5 * (t - 0.9));
        const gap = Math.abs(offset - lobe);
        if (gap < maxHalf * 0.48 && noise < 0.66) {
          level = 2 + (noise > 0.34 ? 1 : 0);
        }
      }

      if (level < 0 && k <= 1) {
        // 鱼身：靠鱼脊最浓，越往外越淡；边缘抖散
        if (k > 0.9 && noise > 0.4) continue;
        level = Math.min(LEVELS - 1, Math.floor(k * k * 3 + noise * 1.05));
        // 背部再压一档，像鳞片顺着光
        if (lateral < 0 && level > 0 && noise > 0.3) level -= 1;
      }

      if (level < 0 && t > 0.22 && t < 0.8 && lateral < 0) {
        // 背鳍：贴着脊背的一层薄膜
        const finHeight = maxHalf * 0.62 * Math.sin(((t - 0.22) / 0.58) * Math.PI);
        const reach = offset - half;
        if (finHeight > 3 && reach > 0 && reach < finHeight && noise < 0.55 - (reach / finHeight) * 0.3) {
          level = Math.min(LEVELS - 1, 2 + Math.floor((reach / finHeight) * 2));
        }
      }

      if (level < 0 && t > 0.12 && t < 0.34 && lateral > 0) {
        // 胸鳍：头后下方的一小片
        const finHeight = maxHalf * 0.5 * Math.sin(((t - 0.12) / 0.22) * Math.PI);
        const reach = offset - half;
        if (finHeight > 3 && reach > 0 && reach < finHeight && noise < 0.5 - (reach / finHeight) * 0.25) {
          level = Math.min(LEVELS - 1, 2 + Math.floor((reach / finHeight) * 2));
        }
      }

      if (level < 0 && t > 0.98 && t < 1.3) {
        // 尾后拖曳的长鳍：两缕飘带
        const drift = Math.sin(phase * 0.7 + t * 7) * maxHalf * 0.3;
        const target = maxHalf * 0.35 + (t - 0.98) * 3.4 * maxHalf + drift;
        if (Math.abs(offset - target) < maxHalf * 0.42 && noise < 0.46) {
          level = 3;
        }
      }

      if (level < 0) continue;
      const glyphIndex = Math.floor(noise * GLYPHS.length);
      // 阅读带里按格子衰减：同一块鱼，左半（侧栏）是本体，右半（正文）是投影
      const quiet = bandQuiet(wx, wy, band);
      ctx.globalAlpha = baseAlpha * (1 - band.strength * quiet);
      ctx.drawImage(
        atlas.canvas,
        glyphIndex * atlas.cell,
        level * atlas.cell,
        atlas.cell,
        atlas.cell,
        wx - draw / 2,
        wy - draw / 2,
        draw + 0.5,
        draw + 0.5,
      );
    }
  }

  ctx.globalAlpha = 1;
}

/**
 * 阅读带左缘 = 侧栏宽度。宽度定在 `--olivia-sidebar-w`（base.css），
 * 侧栏与这里共用同一个值，不再各写一份 272。
 */
let bandLeftCache: number | null = null;

function readingBandLeft(): number {
  if (bandLeftCache !== null) return bandLeftCache;
  let value = 272;
  if (typeof document !== 'undefined') {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue('--olivia-sidebar-w')
      .trim();
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed) && parsed > 0) value = parsed;
  }
  bandLeftCache = value;
  return value;
}

if (typeof window !== 'undefined') {
  // 视口变化可能带动侧栏宽度（窄屏样式），缓存随之失效
  window.addEventListener('resize', () => {
    bandLeftCache = null;
  });
}

function paint(
  ctx: CanvasRenderingContext2D,
  atlas: Atlas,
  theme: ThemePreset,
  time: number,
  width: number,
  height: number,
): void {
  const palette = theme.palette;
  const dark = theme.mode === 'dark';
  const centerX = width * 0.5;
  const centerY = height * 0.44;
  const band: ReadingBand = {
    // 左缘跟着侧栏走（--olivia-sidebar-w），其余三边都撑到视口外，
    // 只让左缘那一段做羽化，页头与输入区一样落在带内。
    x0: readingBandLeft(),
    x1: width + 176,
    y0: -176,
    y1: height + 176,
    feather: 176,
    // 0.9：带内只剩约一成的鱼——标题、消息卡片与输入框底下是一层
    // 水下投影，看得出鱼游过，但压不住字。鱼的本体留给侧栏那一条。
    strength: 0.9,
  };

  ctx.clearRect(0, 0, width, height);

  // 水面：中心亮、四周沉
  const gradient = ctx.createRadialGradient(
    centerX,
    centerY,
    0,
    centerX,
    centerY,
    Math.max(width, height) * 0.82,
  );
  gradient.addColorStop(0, palette.waterInner);
  gradient.addColorStop(1, palette.waterOuter);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // 中心柔光：像水面被上方照亮的一块
  const glow = ctx.createRadialGradient(
    centerX,
    centerY,
    0,
    centerX,
    centerY,
    Math.min(width, height) * 0.52,
  );
  glow.addColorStop(0, dark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.55)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  // 网格：细线 + 每 5 格一条略重的刻度
  const gridStep = 62;
  ctx.lineWidth = 1;
  ctx.strokeStyle = palette.grid;
  ctx.beginPath();
  for (let x = 0; x <= width; x += gridStep) {
    if (Math.round(x / gridStep) % 5 === 0) continue;
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, height);
  }
  for (let y = 0; y <= height; y += gridStep) {
    if (Math.round(y / gridStep) % 5 === 0) continue;
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(width, y + 0.5);
  }
  ctx.stroke();
  ctx.beginPath();
  for (let x = 0; x <= width; x += gridStep * 5) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, height);
  }
  for (let y = 0; y <= height; y += gridStep * 5) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(width, y + 0.5);
  }
  ctx.stroke();

  // 水纹：一圈圈缓慢外扩的椭圆
  for (let index = 0; index < 5; index += 1) {
    const progress = (((time * 0.035 + index * 0.2) % 1) + 1) % 1;
    const radius = 90 + progress * Math.max(width, height) * 0.62;
    ctx.beginPath();
    ctx.ellipse(centerX, centerY, radius, radius * 0.62, 0, 0, Math.PI * 2);
    ctx.strokeStyle = palette.ring;
    ctx.globalAlpha = (1 - progress) * 0.6;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // 字屑：稀疏的字符浮在水里，像没擦干净的注脚
  ctx.font = `${Math.round(9 + Math.min(width, height) * 0.004)}px ui-monospace, SFMono-Regular, Consolas, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = palette.dust;
  for (let index = 0; index < 150; index += 1) {
    const baseX = hash3(index, 1, 7);
    const baseY = hash3(index, 2, 7);
    const drift = Math.sin(time * 0.22 + index) * 6;
    const x = (baseX * width + drift + width) % width;
    const y = (baseY * height + Math.cos(time * 0.18 + index * 1.7) * 5 + height) % height;
    // 字屑比鱼更靠近正文，衰减得也更狠
    ctx.globalAlpha =
      (0.22 + hash3(index, 3, 7) * 0.55) * (1 - band.strength * 0.8 * bandQuiet(x, y, band));
    ctx.fillText(GLYPHS[Math.floor(hash3(index, 4, 7) * GLYPHS.length)]!, x, y);
  }
  ctx.globalAlpha = 1;

  // 鱼：远的先画
  const ordered = [...KOIS].sort((a, b) => a.depth - b.depth);
  for (const koi of ordered) drawKoi(ctx, atlas, koi, time, width, height, theme.fishAlpha, band);
}

export function KoiScene({ theme, still = false }: { theme: ThemePreset; still?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const themeRef = useRef(theme);
  themeRef.current = theme;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = (): number => Math.min(1.5, window.devicePixelRatio || 1);
    let width = 0;
    let height = 0;
    let atlas = buildAtlas(themeRef.current, Math.round(CELL * dpr()), CELL);
    let atlasTheme = themeRef.current.id;
    let frame = 0;
    let startedAt = performance.now();
    let lastDraw = 0;

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    const resize = (): void => {
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * dpr());
      canvas.height = Math.round(height * dpr());
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
      ctx.imageSmoothingEnabled = false;
      atlas = buildAtlas(themeRef.current, Math.round(CELL * dpr()), CELL);
      atlasTheme = themeRef.current.id;
    };
    resize();
    window.addEventListener('resize', resize);

    const loop = (now: number): void => {
      frame = requestAnimationFrame(loop);
      if (document.hidden) return;
      // 30fps：字块够稳，也不占满 GPU
      if (now - lastDraw < 32) return;
      lastDraw = now;
      if (atlasTheme !== themeRef.current.id) {
        atlas = buildAtlas(themeRef.current, Math.round(CELL * dpr()), CELL);
        atlasTheme = themeRef.current.id;
      }
      paint(ctx, atlas, themeRef.current, (now - startedAt) / 1000, width, height);
    };

    if (reduceMotion || still) {
      paint(ctx, atlas, themeRef.current, 0, width, height);
    } else {
      startedAt = performance.now();
      frame = requestAnimationFrame(loop);
    }

    const onVisible = (): void => {
      if (!document.hidden) startedAt = performance.now();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [still]);

  return <canvas ref={ref} className="koi-canvas" aria-hidden="true" />;
}