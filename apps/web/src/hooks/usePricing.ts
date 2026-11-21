import { useEffect, useState } from 'react';
import { DEFAULT_CONTEXT_WINDOW, type PricingFile } from '@olivia/core';

/**
 * 价格/窗口表：桌面端从主进程读（无人值守预算共用同一份）；
 * 浏览器 dev 模式没有主进程，回退到 core 的内置参考值。
 */
export function usePricing(): PricingFile {
  const [pricing, setPricing] = useState<PricingFile>(() => ({
    defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
    models: {},
  }));

  useEffect(() => {
    let alive = true;
    const bridge = window.olivia?.pricing;
    if (!bridge) return;
    void bridge
      .get()
      .then((file) => {
        if (alive && file) setPricing(file);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  return pricing;
}
