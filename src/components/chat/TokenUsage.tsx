import { formatTokens } from '../../utils/tokenCounter'
import { cn } from '../../lib/utils'

interface TokenUsageProps {
  tokens: number
  maxTokens: number
}

export function TokenUsage({ tokens, maxTokens }: TokenUsageProps) {
  const percentage = Math.min((tokens / maxTokens) * 100, 100)
  const isWarning = percentage > 80
  const isDanger = percentage > 95

  return (
    <div className="flex items-center gap-2 px-2 py-1 rounded-lg bg-tavern-bg-card text-xs">
      <div className="flex items-center gap-1.5">
        <div className="w-1.5 h-1.5 rounded-full bg-tavern-text-muted" />
        <span className={cn(
          'font-mono',
          isDanger ? 'text-tavern-danger' : isWarning ? 'text-tavern-warning' : 'text-tavern-text-muted'
        )}>
          {formatTokens(tokens)}
        </span>
        <span className="text-tavern-text-muted">/ {formatTokens(maxTokens)}</span>
      </div>
    </div>
  )
}
