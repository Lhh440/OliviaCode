import { useTheme } from '../../hooks/useTheme';
import type { Ornament, Skin } from './skins';

/**
 * 背景层 —— 一块蚀刻版画。
 * 每套皮肤自带图片、色调、遮罩与装饰纹样；重色处理的统一算法在 .art-plate 里。
 * 空闲时显形，进入对话后退为氛围（html[data-density='work']）。
 */
export function BackgroundLayer() {
  const { skin } = useTheme();
  const dark = skin.mode === 'dark';

  return (
    <div className="fixed inset-0 z-0 pointer-events-none overflow-hidden" aria-hidden="true">
      {/* 底：极重模糊的色温层 */}
      <div
        className="art-wash absolute inset-0"
        style={{
          backgroundImage: `url(${skin.image})`,
          backgroundSize: 'cover',
          backgroundPosition: skin.art.position,
          filter: 'blur(90px) saturate(1.15)',
          transform: 'scale(1.15)',
        }}
      />

      {/* 主：版画本体，占据右侧，左侧溶进纸里 */}
      <div
        className="art-plate absolute right-0"
        style={{
          left: skin.art.maskFrom,
          top: skin.art.box?.top ?? 0,
          bottom: skin.art.box?.bottom ?? 0,
          maskImage: skin.art.fadeY
            ? 'linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.4) 12%, #000 34%, #000 100%), linear-gradient(180deg, transparent 0%, #000 16%, #000 82%, transparent 100%)'
            : 'linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.28) 10%, rgba(0,0,0,0.72) 26%, #000 44%, #000 100%)',
          WebkitMaskImage: skin.art.fadeY
            ? 'linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.4) 12%, #000 34%, #000 100%), linear-gradient(180deg, transparent 0%, #000 16%, #000 82%, transparent 100%)'
            : 'linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.28) 10%, rgba(0,0,0,0.72) 26%, #000 44%, #000 100%)',
          maskComposite: skin.art.fadeY ? 'intersect' : undefined,
          WebkitMaskComposite: skin.art.fadeY ? 'source-in' : undefined,
        }}
      >
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `url(${skin.image})`,
            backgroundSize: 'cover',
            backgroundPosition: skin.art.position,
            filter: skin.art.filter,
          }}
        />
        {skin.art.tint && (
          <div
            className="absolute inset-0"
            style={{
              backgroundColor: skin.art.tint.color,
              mixBlendMode: skin.art.tint.blend,
              opacity: skin.art.tint.opacity,
            }}
          />
        )}
      </div>

      {/* 纵向渐晕：上下边缘压回纸色，避免硬边 */}
      <div
        className="absolute inset-0"
        style={{
          background: dark
            ? 'linear-gradient(180deg, rgba(7,6,10,0.9) 0%, rgba(7,6,10,0.1) 22%, rgba(7,6,10,0.08) 66%, rgba(7,6,10,0.86) 100%)'
            : 'linear-gradient(180deg, rgba(242,239,232,0.86) 0%, rgba(242,239,232,0.04) 20%, rgba(242,239,232,0.02) 62%, rgba(242,239,232,0.82) 100%)',
        }}
      />

      {/* 内容区的柔光衬底：让正文在版画上依然读得清（也是「若隐若现」的来源） */}
      <div
        className="absolute inset-0"
        style={{
          background: dark
            ? 'radial-gradient(64% 72% at 46% 42%, rgba(7,6,10,0.82) 0%, rgba(7,6,10,0.44) 46%, rgba(7,6,10,0) 80%)'
            : 'radial-gradient(64% 72% at 46% 42%, rgba(242,239,232,0.93) 0%, rgba(242,239,232,0.62) 46%, rgba(242,239,232,0) 80%)',
        }}
      />

      <Ornaments kind={skin.ornament} dark={dark} />

      {/* 纸纹 / 胶片颗粒 */}
      <div className="absolute inset-0 mix-blend-overlay opacity-[0.05]" style={{ backgroundImage: GRAIN }} />
    </div>
  );
}

function Ornaments({ kind, dark }: { kind: Ornament; dark: boolean }) {
  if (kind === 'sunburst') {
    return (
      <>
        <div
          className="absolute inset-0 opacity-[0.3]"
          style={{
            backgroundImage:
              'linear-gradient(rgba(47,91,215,0.16) 1px, transparent 1px), linear-gradient(90deg, rgba(47,91,215,0.16) 1px, transparent 1px)',
            backgroundSize: '68px 32px',
            maskImage: 'linear-gradient(180deg, transparent, black 66%)',
            WebkitMaskImage: 'linear-gradient(180deg, transparent, black 66%)',
            transform: 'perspective(300px) rotateX(60deg) scale(1.7)',
            transformOrigin: 'bottom center',
          }}
        />
        <div
          className="absolute left-[62%] top-[40%] -translate-x-1/2 -translate-y-1/2 opacity-[0.14]"
          style={{ width: '120vmin', height: '120vmin' }}
        >
          <svg viewBox="0 0 800 800" className="w-full h-full">
            {Array.from({ length: 48 }).map((_, i) => (
              <line
                key={i}
                x1="400"
                y1="400"
                x2="400"
                y2="40"
                stroke="#2f5bd7"
                strokeWidth="0.8"
                transform={`rotate(${i * 7.5} 400 400)`}
              />
            ))}
            <circle cx="400" cy="400" r="250" fill="none" stroke="#2f5bd7" strokeWidth="0.7" opacity="0.7" />
          </svg>
        </div>
      </>
    );
  }

  if (kind === 'eyewheel') {
    return (
      <>
        <div
          className="absolute left-[70%] top-[40%] -translate-x-1/2 -translate-y-1/2 opacity-[0.13]"
          style={{ width: '74vmin', height: '74vmin' }}
        >
          <svg viewBox="0 0 400 400" className="w-full h-full">
            <defs>
              <radialGradient id="irisG">
                <stop offset="0%" stopColor="#f0354a" stopOpacity="0.95" />
                <stop offset="58%" stopColor="#6d1019" stopOpacity="0.45" />
                <stop offset="100%" stopColor="#07060a" stopOpacity="0" />
              </radialGradient>
            </defs>
            <circle cx="200" cy="200" r="188" fill="none" stroke="#f0354a" strokeWidth="0.5" />
            <circle cx="200" cy="200" r="152" fill="none" stroke="#e0b45a" strokeWidth="0.4" opacity="0.45" />
            <circle cx="200" cy="200" r="96" fill="url(#irisG)" />
            <circle cx="200" cy="200" r="34" fill="#07060a" stroke="#f0354a" strokeWidth="1.1" />
            <circle cx="213" cy="187" r="6.5" fill="#e0b45a" opacity="0.8" />
            <path d="M18 200 Q200 38 382 200 Q200 362 18 200 Z" fill="none" stroke="#f0354a" strokeWidth="0.7" opacity="0.5" />
          </svg>
        </div>
        <div
          className="absolute inset-0 opacity-[0.12]"
          style={{
            backgroundImage:
              'repeating-linear-gradient(0deg, rgba(255,255,255,0.1) 0px, rgba(255,255,255,0.1) 1px, transparent 1px, transparent 3px)',
          }}
        />
      </>
    );
  }

  if (kind === 'lace') {
    return (
      <>
        {/* 织物菱格 */}
        <div
          className="absolute inset-0 opacity-[0.5]"
          style={{
            backgroundImage:
              'repeating-linear-gradient(45deg, rgba(122,116,104,0.07) 0 1px, transparent 1px 14px), repeating-linear-gradient(-45deg, rgba(122,116,104,0.07) 0 1px, transparent 1px 14px)',
          }}
        />
        {/* 细长纵向光线，像旧照片的划痕 */}
        <div
          className="absolute inset-0 opacity-[0.25]"
          style={{
            backgroundImage:
              'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.5) 50%, transparent 100%)',
            backgroundSize: '38% 100%',
            backgroundRepeat: 'no-repeat',
            backgroundPosition: '62% 0',
            maskImage: 'linear-gradient(180deg, transparent, black 30%, black 70%, transparent)',
            WebkitMaskImage: 'linear-gradient(180deg, transparent, black 30%, black 70%, transparent)',
          }}
        />
      </>
    );
  }

  // starfall
  return (
    <>
      <div
        className="absolute inset-0 opacity-[0.45]"
        style={{
          backgroundImage: SPARKLES,
          backgroundSize: '190px 190px',
          opacity: 0.4,
        }}
      />
      <div
        className="absolute -right-10 top-0 h-full w-[46%] opacity-[0.16]"
        style={{
          background: 'linear-gradient(112deg, transparent 44%, rgba(216,50,63,0.9) 44%, rgba(216,50,63,0.9) 52%, transparent 52%)',
          transform: 'rotate(-6deg)',
        }}
      />
      {dark && (
        <div
          className="absolute inset-0 opacity-[0.1]"
          style={{
            backgroundImage:
              'repeating-linear-gradient(0deg, rgba(255,255,255,0.14) 0px, rgba(255,255,255,0.14) 1px, transparent 1px, transparent 4px)',
          }}
        />
      )}
    </>
  );
}

const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E\")";

/** 四角星点阵（圣母像周围的星） */
const SPARKLES =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='190' height='190'%3E%3Cg fill='%23cfc8bd' fill-opacity='0.55'%3E%3Cpath d='M30 18l2.6 7.4L40 28l-7.4 2.6L30 38l-2.6-7.4L20 28l7.4-2.6z'/%3E%3Cpath d='M140 96l1.8 5.2 5.2 1.8-5.2 1.8-1.8 5.2-1.8-5.2-5.2-1.8 5.2-1.8z'/%3E%3Cpath d='M84 150l2.2 6.2 6.2 2.2-6.2 2.2-2.2 6.2-2.2-6.2-6.2-2.2 6.2-2.2z'/%3E%3C/g%3E%3C/svg%3E\")";
