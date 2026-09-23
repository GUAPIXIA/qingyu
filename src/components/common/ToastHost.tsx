import { useEffect } from 'react'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { TOAST_Z_INDEX, useToastStore, type ToastItem, type ToastVariant } from '../../store/useToastStore'

const variantClass: Record<ToastVariant, string> = {
  info: 'border-tavern-border bg-tavern-bg-card text-tavern-text',
  success: 'border-green-500/40 bg-tavern-bg-card text-tavern-text',
  warning: 'border-amber-500/50 bg-tavern-bg-card text-tavern-text',
  error: 'border-red-500/50 bg-tavern-bg-card text-tavern-text',
}

const variantIcon: Record<ToastVariant, string> = {
  info: 'ℹ',
  success: '✓',
  warning: '!',
  error: '✕',
}

function ToastCard({ toast }: { toast: ToastItem }) {
  const dismiss = useToastStore((s) => s.dismiss)

  useEffect(() => {
    if (!toast.durationMs || toast.durationMs <= 0) return
    const timer = setTimeout(() => dismiss(toast.id), toast.durationMs)
    return () => clearTimeout(timer)
  }, [toast.id, toast.durationMs, dismiss])

  return (
    <div
      role={toast.variant === 'error' ? 'alert' : 'status'}
      className={cn(
        'pointer-events-auto w-[min(22rem,calc(100vw-2rem))] rounded-xl border px-3 py-2.5 shadow-lg backdrop-blur-sm',
        variantClass[toast.variant],
      )}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 text-xs opacity-80 shrink-0" aria-hidden>
          {variantIcon[toast.variant]}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug">{toast.title}</p>
          {toast.description && (
            <p className="mt-1 text-xs text-tavern-text-muted leading-relaxed break-words">{toast.description}</p>
          )}
          {toast.action && (
            <button
              type="button"
              className="mt-2 text-xs font-medium text-tavern-accent hover:underline"
              onClick={() => {
                toast.action?.onClick()
                dismiss(toast.id)
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
        <button
          type="button"
          aria-label="关闭提示"
          className="shrink-0 p-0.5 rounded text-tavern-text-muted hover:text-tavern-text"
          onClick={() => dismiss(toast.id)}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}

/** 全局 Toast 宿主：挂在 MainLayout，z-index 固定 40（Modal 为 50） */
export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts)
  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[40] flex flex-col-reverse gap-2"
      style={{ zIndex: TOAST_Z_INDEX }}
      aria-live="polite"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  )
}
