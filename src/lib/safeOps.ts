import { logError } from './logger'

/**
 * 安全执行异步写操作，失败时记录错误日志。
 * 用于流式控制器中 fire-and-forget 的 API 调用（saveMessage、updateSession 等）。
 * 比静默丢弃好：错误会被 logger 记录，可在控制台或日志文件中追溯。
 */
export async function safeSave(
  fn: () => Promise<void>,
  label: string
): Promise<void> {
  try {
    await fn()
  } catch (err) {
    logError(`[SafeSave] ${label}`, err)
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
