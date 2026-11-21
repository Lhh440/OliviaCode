import { useEffect, useState } from 'react';
import { RUN_PHASE_LABEL, formatTokens, formatUsd, type UsageTotals } from '@olivia/core';

export interface UsageBadgeProps {
  usage?: UsageTotals;
  compact?: boolean;
}

/** M7：工作流/计划里的用量小结。 */
export function UsageBadge({ usage, compact }: UsageBadgeProps) {
  if (!usage || usage.steps === 0) return null;
  const title = [
    `输入 ${usage.input.toLocaleString()}`,
    `输出 ${usage.output.toLocaleString()}`,
    usage.cached ? `缓存 ${usage.cached.toLocaleString()}` : '',
    `${usage.steps} 步`,
    usage.costUsd !== undefined ? `参考费用 ${formatUsd(usage.costUsd)}` : '未配置价格',
  ]
    .filter(Boolean)
    .join(' · ');

  if (compact) {
    return (
      <span className="text-[11.5px] tabular-nums text-light-inkFaint dark:text-dark-inkFaint" title={title}>
        {formatTokens(usage.input)}/{formatTokens(usage.output)}
        {usage.costUsd !== undefined ? ` · ${formatUsd(usage.costUsd)}` : ''}
      </span>
    );
  }

  return (
    <div className="flex items-center gap-2.5 text-[12px] text-light-inkFaint dark:text-dark-inkFaint" title={title}>
      <span className="tabular-nums">输入 {formatTokens(usage.input)}</span>
      <span className="opacity-60">·</span>
      <span className="tabular-nums">输出 {formatTokens(usage.output)}</span>
      {usage.cached > 0 && (
        <>
          <span className="opacity-60">·</span>
          <span className="tabular-nums">缓存 {formatTokens(usage.cached)}</span>
        </>
      )}
      <span className="opacity-60">·</span>
      <span className="tabular-nums">{formatTokens(usage.input + usage.output)} tok</span>
      {usage.costUsd !== undefined && (
        <>
          <span className="opacity-60">·</span>
          <span className="tabular-nums">{formatUsd(usage.costUsd)}（参考）</span>
        </>
      )}
    </div>
  );
}

export function usePhaseLabels(): Record<string, string> {
  const [labels, setLabels] = useState<Record<string, string>>({});
  useEffect(() => {
    setLabels(RUN_PHASE_LABEL as unknown as Record<string, string>);
  }, []);
  return labels;
}
