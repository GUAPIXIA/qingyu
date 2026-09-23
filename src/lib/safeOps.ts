import { logError } from './logger'
import { pushToast } from '../store/useToastStore'

/** 仅这些用户可感知的保存失败才 Toast（防流式落盘刷屏） */
const USER_VISIBLE_SAVE_LABELS = new Set(['编辑', '删除', '清空', 'settings', 'character', 'session'])

/**
 * 安全执行异步写操作，失败时记录错误日志。
 * 返回是否成功，关键事务可据此决定提交或回滚；非关键调用也能只依赖统一日志/Toast。
 */
export async function safeSave(
  fn: () => Promise<void>,
  label: string
): Promise<boolean> {
  try {
    await fn()
    return true
  } catch (err) {
    logError(`[SafeSave] ${label}`, err)
    if (USER_VISIBLE_SAVE_LABELS.has(label)) {
      pushToast({ variant: 'warning', title: `保存失败：${label}`, requestId: `safeSave:${label}` })
    }
    return false
  }
}

/**
 * 安全执行异步读/埋点操作，失败时仅记录日志。
 * 用于非关键路径（如 usage.record），不阻塞主流程。
 */
export function safeFire(
  fn: () => Promise<unknown>,
  label: string
): void {
  fn().catch((err) => logError(`[SafeFire] ${label}`, err))
}
