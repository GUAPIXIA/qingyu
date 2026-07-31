import { formatCharCount } from '../../utils/charCounter'
import { cn } from '../../lib/utils'

interface TokenUsageProps {
  chars: number
}

export function TokenUsage({ chars }: TokenUsageProps) {
  return (
    <span
      className={cn('text-xs tabular-nums text-tavern-text-muted')}
      title={`当前对话总字符数: ${chars}`}
    >
      {formatCharCount(chars)}
    </span>
  )
}
