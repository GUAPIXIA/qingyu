/**
 * 日志系统
 * 
 * - 双输出：console + 文件（{userData}/logs/qingyu.log）
 * - 四个级别：DEBUG / INFO / WARN / ERROR
 * - 自动轮转：单文件 > 1MB 自动 rotate，保留最近 5 个文件
 * 
 * 初始化：应用启动时调用 initLogger(userDataPath)
 * 使用：const log = createLogger('模块名')
 *       log.info('消息', { key: 'value' })
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 日志级别 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

/** 日志级别名称映射 */
const LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO ',
  [LogLevel.WARN]: 'WARN ',
  [LogLevel.ERROR]: 'ERROR',
}

/** 最大文件大小 (1MB) */
const MAX_FILE_SIZE = 1 * 1024 * 1024

/** 最大保留文件数 */
const MAX_LOG_FILES = 5

/** 日志文件基础名 */
const LOG_FILE_NAME = 'qingyu.log'

/** 全局日志目录路径 */
let logDir: string | null = null

/** 全局最低日志级别 */
let minLevel: LogLevel = LogLevel.DEBUG

/** 格式时间戳 */
function formatTime(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const ms = String(now.getMilliseconds()).padStart(3, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${ms}`
}

/** 格式化 key=value 元数据 */
function formatMeta(meta?: Record<string, any>): string {
  if (!meta || Object.keys(meta).length === 0) return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined || v === null) continue
    parts.push(`${k}=${String(v)}`)
  }
  return parts.length > 0 ? ' | ' + parts.join(' | ') : ''
}

/** 日志轮转 */
function rotateIfNeeded(): void {
  if (!logDir) return
  const logPath = join(logDir, LOG_FILE_NAME)
  if (!existsSync(logPath)) return

  const stats = statSync(logPath)
  if (stats.size < MAX_FILE_SIZE) return

  // 轮转：qingyu.4.log → qingyu.5.log (删除), ... qingyu.log → qingyu.1.log
  for (let i = MAX_LOG_FILES - 1; i >= 0; i--) {
    const oldPath = join(logDir, i === 0 ? LOG_FILE_NAME : `${LOG_FILE_NAME.replace('.log', '')}.${i}.log`)
    const newPath = join(logDir, `${LOG_FILE_NAME.replace('.log', '')}.${i + 1}.log`)
    if (existsSync(oldPath)) {
      if (i >= MAX_LOG_FILES - 1) {
        // 删除最旧的
        try { require('node:fs').unlinkSync(oldPath) } catch { /* ignore */ }
      } else {
        try { renameSync(oldPath, newPath) } catch { /* ignore */ }
      }
    }
  }
}

/** 写入日志文件 */
function writeToFile(line: string): void {
  if (!logDir) return
  try {
    const logPath = join(logDir, LOG_FILE_NAME)
    rotateIfNeeded()
    appendFileSync(logPath, line + '\n', 'utf-8')
  } catch {
    // 文件写入失败，至少 console 已有输出
  }
}

/** 日志记录器 */
export class Logger {
  private module: string

  constructor(module: string) {
    this.module = module
  }

  debug(message: string, meta?: Record<string, any>): void {
    this.log(LogLevel.DEBUG, message, meta)
  }

  info(message: string, meta?: Record<string, any>): void {
    this.log(LogLevel.INFO, message, meta)
  }

  warn(message: string, meta?: Record<string, any>): void {
    this.log(LogLevel.WARN, message, meta)
  }

  error(message: string, meta?: Record<string, any>): void {
    this.log(LogLevel.ERROR, message, meta)
  }

  private log(level: LogLevel, message: string, meta?: Record<string, any>): void {
    if (level < minLevel) return

    const line = `[${formatTime()}] [${LEVEL_NAMES[level]}] [${this.module}] ${message}${formatMeta(meta)}`

    // 双输出
    if (level === LogLevel.ERROR) {
      console.error(line)
    } else if (level === LogLevel.WARN) {
      console.warn(line)
    } else {
      console.log(line)
    }
    writeToFile(line)
  }
}

/** 日志实例缓存 */
const loggerCache = new Map<string, Logger>()

/** 创建日志记录器 */
export function createLogger(module: string): Logger {
  const existing = loggerCache.get(module)
  if (existing) return existing
  const logger = new Logger(module)
  loggerCache.set(module, logger)
  return logger
}

/** 获取日志记录器（不创建） */
export function getLogger(module: string): Logger | undefined {
  return loggerCache.get(module)
}

/** 初始化日志系统 */
export function initLogger(userDataPath: string, level: LogLevel = LogLevel.DEBUG): void {
  minLevel = level
  logDir = join(userDataPath, 'logs')
  try {
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true })
    }
  } catch {
    logDir = null // 无法创建目录，只输出到 console
  }

  const log = createLogger('bootstrap')
  log.info('日志系统初始化完成', { path: logDir ?? '(console only)', level: LEVEL_NAMES[level].trim() })
}

/** 获取日志内容（供渲染进程查看） */
export function getRecentLogs(lineCount: number = 200): string {
  if (!logDir) return ''
  const logPath = join(logDir, LOG_FILE_NAME)
  if (!existsSync(logPath)) return ''

  try {
    const content = require('node:fs').readFileSync(logPath, 'utf-8')
    const lines = content.split('\n').filter(Boolean)
    return lines.slice(-lineCount).join('\n')
  } catch {
    return '(日志读取失败)'
  }
}
