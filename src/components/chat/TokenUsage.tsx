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
    <span
      className={cn(
        'text-xs tabular-nums',
        status === 'danger' && 'text-tavern-danger',
        status === 'warning' && 'text-tavern-warning',
        status === 'normal' && 'text-tavern-text-muted'
      )}
      title={`已用: ${formatTokens(tokens)} / 最大: ${formatTokens(maxTokens)} (${percent.toFixed(1)}%)`}
    >
      {formatTokens(tokens)}
    </span>
  )
}
