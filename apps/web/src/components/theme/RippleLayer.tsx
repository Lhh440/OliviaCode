import { useEffect, useRef } from 'react';

/**
 * 点击水波纹。
 *
 * 一块覆盖全窗口的 canvas，`pointer-events: none`，不干扰任何交互。
 * 每次 pointerdown 在点击处画三圈扩散的水纹 + 一点高光，1.1s 内淡出；
 * 没有波纹时停止 rAF，不空转。
 */
interface Ripple {
  x: number;
  y: number;
  at: number;
  rgb: string;
  strength: number;
}

export function RippleLayer() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let frame = 0;
    const ripples: Ripple[] = [];
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    if (reduceMotion) return;

    const resize = (): void => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const accent = (): string => {
      const value = getComputedStyle(document.documentElement)
        .getPropertyValue('--olivia-accent-rgb')
        .trim();
      return value || '160,190,210';
    };

    const draw = (now: number): void => {
      ctx.clearRect(0, 0, width, height);
      const life = 1150;
      for (let index = ripples.length - 1; index >= 0; index -= 1) {
        const ripple = ripples[index]!;
        const age = (now - ripple.at) / life;
        if (age >= 1) {
          ripples.splice(index, 1);
          continue;
        }
        const ease = 1 - (1 - age) ** 3;
        const fade = (1 - age) ** 1.6;
        for (let ring = 0; ring < 3; ring += 1) {
          const radius = 10 + ease * (92 + ring * 52);
          const alpha = fade * (0.38 - ring * 0.09) * ripple.strength;
          if (alpha <= 0) continue;
          ctx.beginPath();
          ctx.arc(ripple.x, ripple.y, radius, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${ripple.rgb},${alpha.toFixed(3)})`;
          ctx.lineWidth = Math.max(0.6, 2.2 * (1 - age) - ring * 0.4);
          ctx.stroke();
        }
        // 中心的一点高光，像水被按下时的反光
        const glow = fade * 0.22 * ripple.strength;
        const grad = ctx.createRadialGradient(ripple.x, ripple.y, 0, ripple.x, ripple.y, 42 + ease * 60);
        grad.addColorStop(0, `rgba(255,255,255,${(glow * 0.9).toFixed(3)})`);
        grad.addColorStop(0.4, `rgba(${ripple.rgb},${(glow * 0.5).toFixed(3)})`);
        grad.addColorStop(1, `rgba(${ripple.rgb},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(ripple.x, ripple.y, 42 + ease * 60, 0, Math.PI * 2);
        ctx.fill();
      }
      frame = ripples.length > 0 ? requestAnimationFrame(draw) : 0;
      if (frame === 0) ctx.clearRect(0, 0, width, height);
    };

    const onDown = (event: PointerEvent): void => {
      // 右键 / 中键不画，避免菜单操作也冒水
      if (event.button !== 0) return;
      ripples.push({
        x: event.clientX,
        y: event.clientY,
        at: performance.now(),
        rgb: accent(),
        strength: event.target instanceof HTMLElement && event.target.closest('button, a, select, input') ? 0.75 : 1,
      });
      if (ripples.length > 12) ripples.shift();
      if (frame === 0) frame = requestAnimationFrame(draw);
    };

    window.addEventListener('pointerdown', onDown, { passive: true });
    return () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointerdown', onDown);
      if (frame) cancelAnimationFrame(frame);
      ctx.clearRect(0, 0, width, height);
    };
  }, []);

  return <canvas ref={ref} className="ripple-layer" aria-hidden="true" />;
}