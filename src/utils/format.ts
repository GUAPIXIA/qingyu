import { format } from 'date-fns'
import { zhCN } from 'date-fns/locale'

/** 格式化时间戳 */
export function formatTime(timestamp: number): string {
  return format(timestamp, 'HH:mm')
}

/** 格式化日期时间 */
export function formatDateTime(timestamp: number): string {
  return format(timestamp, 'yyyy-MM-dd HH:mm', { locale: zhCN })
}

/** 格式化相对时间 */
export function formatRelativeTime(timestamp: number): string {
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
