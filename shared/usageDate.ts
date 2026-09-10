const DATE_PARTS = ['year', 'month', 'day', 'hour', 'minute', 'second'] as const
type DatePart = typeof DATE_PARTS[number]
type ZonedDateParts = Record<DatePart, number>

/** 校验设置中的 IANA 时区；非法或空值回退到运行环境时区。 */
export function resolveUsageTimeZone(candidate?: string): string {
  if (candidate) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(0)
      return candidate
    } catch {
      // 继续回退系统时区。
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function getZonedParts(timestamp: number, timeZone: string): ZonedDateParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  const values = Object.fromEntries(
    formatter.formatToParts(new Date(timestamp))
      .filter((part) => DATE_PARTS.includes(part.type as DatePart))
      .map((part) => [part.type, Number(part.value)]),
  ) as Partial<ZonedDateParts>
  return {
    year: values.year ?? 1970,
    month: values.month ?? 1,
    day: values.day ?? 1,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
  }
}

function getTimeZoneOffset(timestamp: number, timeZone: string): number {
  const secondTimestamp = Math.floor(timestamp / 1000) * 1000
  const parts = getZonedParts(secondTimestamp, timeZone)
  const representedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  )
  return representedAsUtc - secondTimestamp
}

function zonedMidnightToTimestamp(year: number, month: number, day: number, timeZone: string): number {
  const midnightAsUtc = Date.UTC(year, month - 1, day)
  let candidate = midnightAsUtc
  // 迭代两次可覆盖午夜前后发生的夏令时偏移变化。
  for (let index = 0; index < 3; index++) {
    candidate = midnightAsUtc - getTimeZoneOffset(candidate, timeZone)
  }
  return candidate
}

/** 返回指定时区的 YYYY-MM-DD 日期键。 */
export function getUsageDayKey(timestamp: number, requestedTimeZone?: string): string {
  const timeZone = resolveUsageTimeZone(requestedTimeZone)
  const parts = getZonedParts(timestamp, timeZone)
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

/** 返回指定时区某个自然日的起始时间；dayOffset=-6 表示六天前的零点。 */
export function startOfUsageDay(timestamp: number, requestedTimeZone?: string, dayOffset = 0): number {
  const timeZone = resolveUsageTimeZone(requestedTimeZone)
  const current = getZonedParts(timestamp, timeZone)
  const shifted = new Date(Date.UTC(current.year, current.month - 1, current.day + dayOffset, 12))
  return zonedMidnightToTimestamp(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    timeZone,
  )
}
