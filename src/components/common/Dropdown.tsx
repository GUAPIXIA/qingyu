import { type ReactNode, useRef, useEffect, useCallback } from 'react'
import { cn } from '../../lib/utils'

interface DropdownProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger: ReactNode
  children: ReactNode
  align?: 'left' | 'right'
  panelClassName?: string
  /** 点击面板内容时不关闭（默认 true） */
  closeOnContentClick?: boolean
  /**
   * F5：面板语义角色（如 'menu'）。默认不设置（保持既有 DOM 结构）。
   * 需要时由消费者声明，使面板内的条目能被无障碍技术与自动化按角色区分于触发器。
   */
  panelRole?: string
  /** 面板的无障碍名称（与 panelRole 搭配使用） */
  panelAriaLabel?: string
}

/**
 * 通用下拉菜单容器组件。
 * 负责管理打开/关闭状态、遮罩层点击关闭、Escape 键关闭。
 * 触发器和面板内容由消费者提供。
 */
export function Dropdown({
  open,
  onOpenChange,
  trigger,
  children,
  align = 'left',
  panelClassName,
  closeOnContentClick = false,
  panelRole,
  panelAriaLabel,
}: DropdownProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  const handleClose = useCallback(() => onOpenChange(false), [onOpenChange])

  // Escape 键关闭
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, handleClose])

  return (
    <div className="relative">
      {/* 触发器 */}
      <div onClick={() => onOpenChange(!open)}>
        {trigger}
      </div>

      {/* 遮罩 + 面板 */}
      {open && (
        <>
          {/* 全屏遮罩，阻止点击穿透 */}
          <div className="fixed inset-0 z-20" onClick={handleClose} />
          {/* 下拉面板 */}
          <div
            ref={panelRef}
            role={panelRole}
            aria-label={panelRole ? panelAriaLabel : undefined}
            onClick={closeOnContentClick ? undefined : (e) => e.stopPropagation()}
            className={cn(
              'dropdown-pop absolute top-full mt-1 z-50 bg-tavern-bg-card border border-tavern-border rounded-xl shadow-xl py-1',
              align === 'right' ? 'right-0' : 'left-0',
              panelClassName,
            )}
          >
            {children}
          </div>
        </>
      )}
    </div>
  )
}
