import { type ReactNode } from 'react'
import { cn } from '../../lib/utils'

interface TooltipProps {
  /** 触发元素 */
  children: ReactNode
  /** tooltip 内容 */
  content: string
  /** tooltip 位置，默认 top */
  position?: 'top' | 'bottom' | 'left' | 'right'
  /** 自定义 className */
  className?: string
}

const positionClasses = {
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
  left: 'right-full top-1/2 -translate-y-1/2 mr-2',
  right: 'left-full top-1/2 -translate-y-1/2 ml-2',
}

/**
 * 基于 group-hover 的自定义 Tooltip 组件。
 * 使用方式：将触发元素包裹在 Tooltip 中，并给触发元素添加 group 类名。
 */
export function Tooltip({
  children,
  content,
  position = 'top',
  className,
}: TooltipProps) {
  return (
    <div className={cn('relative group', className)}>
      {children}
      <div
        className={cn(
          'absolute z-50 px-2 py-1 text-xs text-white bg-tavern-bg-card border border-tavern-border rounded-lg shadow-lg',
          'opacity-0 invisible group-hover:opacity-100 group-hover:visible',
          'transition-all duration-150 pointer-events-none whitespace-nowrap',
          positionClasses[position],
        )}
      >
        {content}
      </div>
    </div>
  )
}
