/**
 * 前端日志工具
 *
 * - 环境感知：开发(dev) / 测试(test) / 生产(production) 三模式
 * - 四级日志：DEBUG / INFO / WARN / ERROR
 * - 堆栈格式化：自动提取 Error.stack 并精简输出
 * - 测试模式：错误收集器 + 格式化终端输出，可在测试中断言
 * - 生产模式：error/warn best-effort 同步到后端日志文件
 *
 * 使用方式：
 *   import { logError, logWarn, logInfo, logDebug } from '@/lib/logger'
 *   logError('ChatStore:saveMessage', e)
 *   logInfo('App:init', '设置加载完成')
 *
 * 控制台输出示例：
 *   [ERROR] [ChatStore:saveMessage] Network request failed
 *     at saveMessage (useChatStore.ts:142)
 *     ...
 */

// ---- 环境检测 ----

const mode = import.meta.env?.MODE ?? 'production'
const isDev = mode === 'development'
const isTest = mode === 'test'
const isDevOrTest = isDev || isTest

// ---- 测试错误收集器（仅测试模式启用）----

export interface CollectedLog {
  level: 'debug' | 'info' | 'warn' | 'error'
  context: string
  message: string
  stack?: string
  timestamp: number
}

const logCollector: CollectedLog[] = []

if (isTest) {
  (globalThis as { __LOG_COLLECTOR__?: CollectedLog[] }).__LOG_COLLECTOR__ = logCollector
}

// ---- 工具函数 ----

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

/** 从错误值提取堆栈（仅 Error 实例有），精简到前 8 行 */
function extractStack(err: unknown): string | undefined {
  if (err instanceof Error && err.stack) {
    return err.stack.split('\n').slice(0, 8).join('\n')
  }
  return undefined
}

/** best-effort 同步到后端日志文件（主进程终端可见） */
function syncToBackend(
  level: 'debug' | 'info' | 'warn' | 'error',
  context: string,
  message: string,
  stack?: string,
): void {
  try {
    const meta = stack ? { stack } : undefined
    window.api?.log?.write(level, context, message, meta).catch(() => {})
  } catch {
    // window.api 未就绪时忽略
  }
}

// ---- 终端格式化输出（开发/测试模式）----

const LEVEL_TAGS: Record<string, string> = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
}

/** 格式化终端输出行，附带堆栈缩进展示 */
function formatTerminalLine(
  level: string,
  context: string,
  message: string,
  stack?: string,
): string {
  const tag = LEVEL_TAGS[level] ?? level.toUpperCase()
  let line = `[${tag}] [${context}] ${message}`
  if (stack && (level === 'error' || level === 'warn')) {
    // 跳过堆栈第一行（与 message 重复），剩余行缩进展示
    const stackLines = stack.split('\n').slice(1).filter(Boolean)
    if (stackLines.length > 0) {
      line += '\n' + stackLines.map((l) => '  ' + l.trim()).join('\n')
    }
  }
  return line
}

// ---- 对外 API ----

/** 记录 DEBUG 日志（仅开发/测试模式输出） */
export function logDebug(context: string, msg: string): void {
  if (isTest) {
    logCollector.push({ level: 'debug', context, message: msg, timestamp: Date.now() })
  }
  if (isDevOrTest) {
    console.log(formatTerminalLine('debug', context, msg))
  }
}

/** 记录 INFO 日志 */
export function logInfo(context: string, msg: string): void {
  if (isTest) {
    logCollector.push({ level: 'info', context, message: msg, timestamp: Date.now() })
  }
  if (isDevOrTest) {
    console.log(formatTerminalLine('info', context, msg))
  }
}

/**
 * 记录警告日志
 * @param context 模块:操作
 * @param msg 警告消息
 */
export function logWarn(context: string, msg: string): void {
  if (isTest) {
    logCollector.push({ level: 'warn', context, message: msg, timestamp: Date.now() })
  }
  if (isDevOrTest) {
    console.warn(formatTerminalLine('warn', context, msg))
  }
  syncToBackend('warn', context, msg)
}

/**
 * 记录错误日志（带上下文标签和堆栈）
 * @param context 模块:操作，如 'ChatStore:saveMessage'
 * @param err 错误对象、字符串或任意值
 */
export function logError(context: string, err: unknown): void {
  const msg = formatError(err)
  const stack = extractStack(err)

  if (isTest) {
    logCollector.push({ level: 'error', context, message: msg, stack, timestamp: Date.now() })
  }

  if (isDevOrTest) {
    console.error(formatTerminalLine('error', context, msg, stack))
  } else {
    console.error(`[${context}]`, msg)
  }

  syncToBackend('error', context, msg, stack)
}

// ---- 测试辅助 API ----

/** 获取收集的日志（仅测试模式有数据） */
export function getCollectedLogs(): CollectedLog[] {
  return logCollector
}

/** 清空收集的日志（每个测试 afterEach 自动调用） */
export function clearCollectedLogs(): void {
  logCollector.length = 0
}

/** 获取收集到的 error 级别日志 */
export function getCollectedErrors(): CollectedLog[] {
  return logCollector.filter((l) => l.level === 'error')
}
