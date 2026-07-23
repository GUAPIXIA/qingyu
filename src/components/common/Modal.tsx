import { type ReactNode, useEffect } from 'react'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: string
  /** 自定义 header，优先级高于 title */
  header?: ReactNode
  /** 自定义 header 容器 className */
  headerClassName?: string
  children: ReactNode
  width?: 'sm' | 'md' | 'lg' | 'xl' | 'custom'
  /** width 为 custom 时使用的自定义宽度类名 */
  widthClassName?: string
  footer?: ReactNode
  /** 遮罩层 className，默认 backdrop-blur-sm */
  overlayClassName?: string
  /** 内容区 className */
  contentClassName?: string
}

export function Modal({
  open,
  onClose,
  title,
  header,
  headerClassName,
  children,
  width = 'md',
  widthClassName,
  footer,
  overlayClassName,
  contentClassName,
}: ModalProps) {
  useEffect(() => {
    if (open) {
      const handleEsc = (e: KeyboardEvent) => {
        if (e.key === 'Escape') onClose()
      }
      window.addEventListener('keydown', handleEsc)
      return () => window.removeEventListener('keydown', handleEsc)
    }
  }, [open, onClose])

  if (!open) return null

  const widths = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
    custom: widthClassName ?? '',
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in">
      <div className={cn('absolute inset-0 bg-black/60 backdrop-blur-sm', overlayClassName)} onClick={onClose} />
      <div
        className={cn(
          'relative w-full bg-tavern-bg-card border border-tavern-border rounded-2xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden',
          widths[width],
        )}
      >
        {(title || header) && (
          <div className={cn(
            'flex items-center justify-between px-5 py-4 border-b border-tavern-border-soft shrink-0',
            headerClassName,
          )}>
            {header ?? (
              <h2 className="font-display text-lg font-bold text-tavern-text">{title}</h2>
            )}
            <button
              onClick={onClose}
              className="p-1 rounded-lg text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover transition-colors shrink-0"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        )}
        <div className={cn('flex-1 overflow-y-auto p-5', contentClassName)}>{children}</div>
        {footer && (
          <div className="px-5 py-4 border-t border-tavern-border-soft flex justify-end gap-2 shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
