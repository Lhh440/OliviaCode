import { useCallback, useEffect, useState } from 'react';
import type { ProviderConfig } from '@olivia/core';

/**
 * M8：提供商目录来自主进程（不含明文 Key，只有 hasKey）。
 * 保存/删除/启停由主进程广播 `olivia:provider.event`，这里跟着刷新。
 */
export function useProviders(): {
  providers: ProviderConfig[];
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (): Promise<void> => {
    const bridge = window.olivia?.provider;
    if (!bridge) {
      setProviders([]);
      setLoading(false);
      return;
    }
    try {
      const list = await bridge.list();
      setProviders(list);
    } catch {
      setProviders([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const bridge = window.olivia?.provider;
    if (!bridge) return;
    return bridge.onEvent((list) => {
      setProviders(list);
      setLoading(false);
    });
  }, [refresh]);

  return { providers, loading, refresh };
}
