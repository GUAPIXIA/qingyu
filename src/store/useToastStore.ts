import { create } from 'zustand'

export type ToastVariant = 'info' | 'success' | 'warning' | 'error'

export interface ToastItem {
  id: string
  variant: ToastVariant
  title: string
  description?: string
  durationMs?: number
  action?: { label: string; onClick: () => void }
  requestId?: string
}

export interface ToastInput {
  variant?: ToastVariant
  title: string
  description?: string
  durationMs?: number
  action?: { label: string; onClick: () => void }
  requestId?: string
}

export const TOAST_Z_INDEX = 40

const DEFAULT_DURATION: Record<ToastVariant, number> = {
  info: 4000,
  success: 4000,
  warning: 6000,
  error: 8000,
}

const MAX_TOASTS = 5

interface ToastState {
  toasts: ToastItem[]
  push: (input: ToastInput) => string
  dismiss: (id: string) => void
  dismissAll: () => void
}

let toastSeq = 0

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (input) => {
    const variant = input.variant ?? 'info'
    const id = `toast-${++toastSeq}`
    const item: ToastItem = {
      id,
      variant,
      title: input.title,
      description: input.description,
      durationMs: input.durationMs ?? DEFAULT_DURATION[variant],
      action: input.action,
      requestId: input.requestId,
    }
    set((s) => {
      let next = s.toasts.filter((t) => !(input.requestId && t.requestId === input.requestId))
      next = [...next, item]
      if (next.length > MAX_TOASTS) next = next.slice(next.length - MAX_TOASTS)
      return { toasts: next }
    })
    return id
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  dismissAll: () => set({ toasts: [] }),
}))

export function pushToast(input: ToastInput): string {
  return useToastStore.getState().push(input)
}

export function dismissToast(id: string): void {
  useToastStore.getState().dismiss(id)
}
