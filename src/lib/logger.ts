/**
 * 前端日志工具
 *
 * 统一格式化控制台输出，添加模块上下文标签，便于定位问题。
 * 错误日志同步写入后端日志文件（best-effort，不阻塞 UI）。
 *
 * 使用方式：
 *   import { logError } from '@/lib/logger'
 *   promise.catch((e) => logError('ChatStore:saveMessage', e))
 *
 * 控制台输出示例：
 *   [ChatStore:saveMessage] Network request failed
 */

/** 从任意错误值提取可读消息 */
function formatError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/**
 * 记录错误日志（带上下文标签）
 * @param context 模块:操作，如 'ChatStore:saveMessage'
 * @param err 错误对象
 */
export function logError(context: string, err: unknown): void {
  const msg = formatError(err)
  console.error(`[${context}]`, msg)
  // best-effort 同步到后端日志文件
  try {
    window.api?.log?.write('error', context, msg).catch(() => {})
  } catch {
    // window.api 未就绪时忽略
  }
}

/**
 * 记录警告日志
 * @param context 模块:操作
 * @param msg 警告消息
 */
export function logWarn(context: string, msg: string): void {
  console.warn(`[${context}]`, msg)
  try {
    window.api?.log?.write('warn', context, msg).catch(() => {})
  } catch {
    // window.api 未就绪时忽略
  }
}
