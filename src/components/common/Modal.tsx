import { type ReactNode, useEffect, useRef, useId } from 'react'
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
  const overlayRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const prevFocusRef = useRef<HTMLElement | null>(null)
  const titleId = useId()
  // onClose 通常是内联箭头函数，每次渲染都会变化；用 ref 持有，
  // 避免焦点管理 effect 因 onClose 变化而反复重跑（导致输入时焦点被抢回关闭按钮）
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })

  // S2-D 可访问性：焦点管理与 trap
  useEffect(() => {
    if (!open) return
    prevFocusRef.current = document.activeElement as HTMLElement | null
    // 初始焦点：优先关闭按钮，否则首个可聚焦元素
    const timer = setTimeout(() => {
      const dialog = dialogRef.current
      if (!dialog) return
      const closeBtn = dialog.querySelector<HTMLButtonElement>('[data-modal-close]')
      if (closeBtn) closeBtn.focus()
      else {
        const focusable = dialog.querySelector<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
        focusable?.focus()
      }
    }, 0)

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCloseRef.current(); return }
      if (e.key !== 'Tab') return
      const dialog = dialogRef.current
      if (!dialog) return
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )).filter(el => el.offsetParent !== null || el.getAttribute('data-modal-close') !== null)
      if (focusable.length === 0) { e.preventDefault(); return }
      const first = focusable[0]; const last = focusable[focusable.length - 1]
      if (e.shiftKey) { if (document.activeElement === first) { e.preventDefault(); last.focus() } }
      else { if (document.activeElement === last) { e.preventDefault(); first.focus() } }
    }
    window.addEventListener('keydown', handleKeyDown)
    // 防止背景滚动
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      clearTimeout(timer)
      window.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = prevOverflow
      // 焦点恢复
      prevFocusRef.current?.focus?.()
    }
  }, [open])

  if (!open) return null

  const widths = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
    custom: widthClassName ?? '',
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" ref={overlayRef}>
      <div className={cn('motion-overlay absolute inset-0 bg-black/60 backdrop-blur-[2px]', overlayClassName)} onClick={onClose} aria-hidden />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        className={cn(
          'modal-pop relative w-full bg-tavern-bg-card border border-tavern-border rounded-2xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden',
          widths[width],
        )}
      >
        {(title || header) && (
          <div className={cn(
            'flex items-center justify-between px-5 py-4 border-b border-tavern-border-soft shrink-0',
            headerClassName,
          )}>
            {header ?? (
              <h2 id={titleId} className="font-display text-lg font-bold text-tavern-text">{title}</h2>
            )}
            <button
              data-modal-close
              onClick={onClose}
              aria-label="关闭"
              className="p-1 rounded-lg text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover transition-colors shrink-0 focus-visible:ring-2 focus-visible:ring-tavern-accent focus-visible:outline-none"
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
