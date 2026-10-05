/**
 * 时间格式化回归测试（F4）
 *
 * 背景：外部 IPC 写入的不完整消息可能缺 `timestamp`，而 `date-fns.format(undefined, …)`
 * 会抛 `RangeError: Invalid time value`，在消息气泡里直接击穿整页 ErrorBoundary。
 * 这里锁定“无效时间戳一律降级为空串、绝不抛错”。
 */
import { describe, expect, it } from 'vitest'
import { formatTime, formatDateTime, formatRelativeTime } from '../format'

const VALID = new Date(2026, 9, 5, 13, 45).getTime()

describe('formatTime / formatDateTime / formatRelativeTime 的无效值降级', () => {
  it('正常时间戳照常格式化', () => {
    expect(formatTime(VALID)).toBe('13:45')
    expect(formatDateTime(VALID)).toBe('2026-10-05 13:45')
    expect(formatRelativeTime(Date.now() - 30_000)).toBe('刚刚')
  })

  it.each([undefined, null, NaN, Infinity, -Infinity, 'x' as unknown as number])(
    '无效时间戳（%s）不抛错且返回空串',
    (value) => {
      expect(() => formatTime(value as number)).not.toThrow()
      expect(formatTime(value as number)).toBe('')
      expect(formatDateTime(value as number)).toBe('')
      expect(formatRelativeTime(value as number)).toBe('')
    },
  )

  it('超出 Date 可表示范围的时间戳同样降级（不抛 RangeError）', () => {
    expect(formatTime(8.7e15)).toBe('')
    expect(formatDateTime(8.7e15)).toBe('')
    expect(formatRelativeTime(8.7e15)).toBe('')
  })

  it('0 与负数视为有效时间戳（历史消息可能为 0）', () => {
    expect(() => formatTime(0)).not.toThrow()
    expect(formatTime(0)).toMatch(/^\d{2}:\d{2}$/)
  })
})
