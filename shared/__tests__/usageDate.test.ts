import { describe, expect, it } from 'vitest'
import { getUsageDayKey, resolveUsageTimeZone, startOfUsageDay } from '../usageDate'

describe('usageDate', () => {
  it('按指定时区生成自然日日期键，而不是固定使用 UTC', () => {
    const timestamp = Date.parse('2026-09-09T16:30:00.000Z')
    expect(getUsageDayKey(timestamp, 'Asia/Shanghai')).toBe('2026-09-10')
    expect(getUsageDayKey(timestamp, 'America/New_York')).toBe('2026-09-09')
  })

  it('今日从指定时区零点开始', () => {
    const timestamp = Date.parse('2026-09-09T12:00:00.000Z')
    expect(startOfUsageDay(timestamp, 'Asia/Shanghai')).toBe(Date.parse('2026-09-08T16:00:00.000Z'))
  })

  it('自然日偏移包含今天并正确跨月', () => {
    const timestamp = Date.parse('2026-09-02T04:00:00.000Z')
    expect(startOfUsageDay(timestamp, 'Asia/Shanghai', -6)).toBe(Date.parse('2026-08-26T16:00:00.000Z'))
  })

  it('非法时区安全回退运行环境时区', () => {
    expect(() => resolveUsageTimeZone('Not/A_Timezone')).not.toThrow()
  })
})
