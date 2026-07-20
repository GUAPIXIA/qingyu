import { formatTokens } from '../../utils/tokenCounter'
import { cn } from '../../lib/utils'

interface TokenUsageProps {
  tokens: number
  maxTokens: number
}

export function TokenUsage({ tokens, maxTokens }: TokenUsageProps) {
  const percent = maxTokens > 0 ? Math.min(100, (tokens / maxTokens) * 100) : 0
  const status = percent > 95 ? 'danger' : percent > 80 ? 'warning' : 'normal'

  return (
    <div className="flex items-center gap-2" title={`当前: ${tokens} / 最大: ${maxTokens} (${percent.toFixed(1)}%)`}>
      <div className="flex items-center gap-1.5 text-xs">
        <span className={cn(
          'tabular-nums',
          status === 'danger' && 'text-tavern-danger',
          status === 'warning' && 'text-tavern-warning',
          status === 'normal' && 'text-tavern-text-muted'
        )}>
          {formatTokens(tokens)}
        </span>
        <span className="text-tavern-text-muted/50">/</span>
        <span className="text-tavern-text-muted tabular-nums">{formatTokens(maxTokens)}</span>
      </div>
      {/* 进度条 */}
      <div className="w-16 h-1.5 rounded-full bg-tavern-bg-hover overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all',
            status === 'danger' && 'bg-tavern-danger',
            status === 'warning' && 'bg-tavern-warning',
            status === 'normal' && 'bg-tavern-accent'
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}
