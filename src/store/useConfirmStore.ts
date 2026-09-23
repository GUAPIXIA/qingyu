import { create } from 'zustand'
import type { ReactNode } from 'react'

/**
 * UEX-P1-04：全局确认通道（可在 React 树外调用）。
 * zustand store 只持有 pending 请求，UI 由 ConfirmHost（MainLayout 挂载）消费；
 * confirm() 返回 Promise<boolean>，调用方 await 用户选择（确认 true / 取消、Esc false）。
 * 后续任何危险操作（删除/清空/覆盖）均可复用此通道。
 */
export interface ConfirmOptions {
  title: string
  message: ReactNode
  confirmText?: string
  cancelText?: string
  danger?: boolean
}

export interface ConfirmRequest {
  id: string
  options: ConfirmOptions
  /** 结清本次请求的 Promise；幂等，重复调用自动忽略 */
  resolve: (ok: boolean) => void
}

interface ConfirmState {
  /** 当前待确认请求（null = 无弹窗） */
  pending: ConfirmRequest | null
  /** 发起确认请求，等待用户选择 */
  request: (options: ConfirmOptions) => Promise<boolean>
  /** 结清当前请求（由 ConfirmHost 调用） */
  settle: (ok: boolean) => void
}

let confirmSeq = 0

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  pending: null,
  request: (options) =>
    new Promise<boolean>((resolve) => {
      // 已有未结请求时先按取消结清，避免旧 Promise 永久悬挂
      const prev = get().pending
      if (prev) prev.resolve(false)
      let settled = false
      const resolveOnce = (ok: boolean) => {
        if (settled) return
        settled = true
        resolve(ok)
      }
      set({
        pending: {
          id: `confirm-${++confirmSeq}`,
          options,
          resolve: resolveOnce,
        },
      })
    }),
  settle: (ok) => {
    const cur = get().pending
    if (!cur) return
    set({ pending: null })
    cur.resolve(ok)
  },
}))

/** 在 React 树外发起全局确认：await confirm({ title, message, ... }) */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return useConfirmStore.getState().request(options)
}
