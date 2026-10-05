import { format } from 'date-fns'
import { zhCN } from 'date-fns/locale'

/**
 * 有效时间戳判定。
 *
 * F4 修复：消息数据可能缺 `timestamp`（例如由外部 IPC 写入的不完整消息），
 * 而 `date-fns.format(undefined, …)` 会抛 `RangeError: Invalid time value`，
 * 在消息气泡里直接击穿整页 ErrorBoundary。所有格式化入口先做有效性判定并降级。
 */
function isValidTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8.64e15
}

/** 格式化时间戳；无效值返回空串（由调用方决定占位样式） */
export function formatTime(timestamp: number | null | undefined): string {
  if (!isValidTimestamp(timestamp)) return ''
  return format(timestamp, 'HH:mm')
}

/** 格式化日期时间；无效值返回空串 */
export function formatDateTime(timestamp: number | null | undefined): string {
  if (!isValidTimestamp(timestamp)) return ''
  return format(timestamp, 'yyyy-MM-dd HH:mm', { locale: zhCN })
}

/** 格式化相对时间；无效值返回空串 */
export function formatRelativeTime(timestamp: number | null | undefined): string {
  if (!isValidTimestamp(timestamp)) return ''
  const diff = Date.now() - timestamp
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour

  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`
  return format(timestamp, 'MM-dd', { locale: zhCN })
}
