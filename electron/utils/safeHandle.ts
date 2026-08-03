import type { IpcMain } from 'electron'
import { createLogger } from '../services/logger'
import { sanitizeApiKey } from './pathGuard'

const log = createLogger('ipc')

type IpcHandler = Parameters<IpcMain['handle']>[1]

/**
 * 包装 ipcMain.handle，自动捕获并记录异常后再抛出。
 * 确保所有 IPC 处理器的错误都有日志可查，避免静默丢失。
 * 行为不变：错误仍以 rejected promise 形式传递给渲染进程。
 */
export function safeHandle(
  ipcMain: IpcMain,
  channel: string,
  handler: IpcHandler,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...args)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const stack = err instanceof Error ? err.stack?.split('\n').slice(0, 3).join(' | ') : undefined
      // 修复：错误消息/堆栈可能包含 API Key，统一脱敏后记录
      log.error(`IPC ${channel} 处理失败`, { error: sanitizeApiKey(msg), stack: stack ? sanitizeApiKey(stack) : undefined })
      throw err
    }
  })
}
