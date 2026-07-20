import { type ReactNode } from 'react'
import { cn } from '../../lib/utils'

interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
  className?: string
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center py-16 px-4',
        className
      )}
    >
      {icon && (
        <div className="w-16 h-16 rounded-2xl bg-tavern-bg-card flex items-center justify-center mb-4 text-tavern-text-muted">
          {icon}
        </div>
      )}
      <h3 className="text-base font-medium text-tavern-text mb-1">{title}</h3>
      {description && (
        <p className="text-sm text-tavern-text-muted max-w-sm">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
