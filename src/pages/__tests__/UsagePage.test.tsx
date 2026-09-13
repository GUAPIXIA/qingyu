/**
 * UsagePage 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useSettingsStore } from '../../store/useSettingsStore'
import { startOfUsageDay } from '../../../shared/usageDate'

vi.mock('react-router-dom', () => ({
  useNavigate: vi.fn(() => vi.fn()),
}))

vi.mock('../../lib/logger', () => ({
  logError: vi.fn(),
}))

vi.mock('../../lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('../../utils/charCounter', () => ({
  formatCharCount: (n: number) => n.toLocaleString(),
}))

Object.defineProperty(window, 'api', {
  value: {
    usage: {
      summary: vi.fn(async () => ({ totalInput: 0, totalOutput: 0, totalChars: 0, count: 0 })),
      aggregate: vi.fn(async () => []),
      query: vi.fn(async () => []),
      clear: vi.fn(async () => ({})),
    },
    character: {
      list: vi.fn(async () => []),
    },
    session: {
      list: vi.fn(async () => []),
    },
    ai: {
      onComplete: vi.fn(() => vi.fn()),
    },
  },
})

import { UsagePage } from '../UsagePage'

describe('UsagePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, timezone: 'Asia/Shanghai' },
    }))
  })

  it('渲染页面标题', async () => {
    render(<UsagePage />)
    await waitFor(() => expect(window.api.usage.summary).toHaveBeenCalled())
    expect(screen.getByText('用量统计')).toBeInTheDocument()
  })

  it('显示导出按钮', async () => {
    render(<UsagePage />)
    await waitFor(() => expect(window.api.usage.summary).toHaveBeenCalled())
    expect(screen.getByText('导出 CSV')).toBeInTheDocument()
  })

  it('今日使用用户时区的自然日零点，并把时区传给按天聚合', async () => {
    render(<UsagePage />)
    await waitFor(() => expect(window.api.usage.summary).toHaveBeenCalled())

    fireEvent.click(screen.getByText('按天'))
    fireEvent.click(screen.getByText('今日'))

    const expectedStart = startOfUsageDay(Date.now(), 'Asia/Shanghai')
    await waitFor(() => {
      expect(window.api.usage.summary).toHaveBeenLastCalledWith({ startTs: expectedStart })
      expect(window.api.usage.aggregate).toHaveBeenLastCalledWith(
        { startTs: expectedStart },
        'day',
        'Asia/Shanghai',
      )
    })
  })

  it('每日趋势在夜间模式使用高对比日期与实色柱体', async () => {
    vi.mocked(window.api.usage.aggregate).mockResolvedValue([{
      key: '2026-08-27', inputChars: 100, outputChars: 200, totalChars: 300, count: 1,
    }])
    render(<UsagePage />)
    await waitFor(() => expect(window.api.usage.summary).toHaveBeenCalled())

    fireEvent.click(screen.getByText('按天'))

    const dateLabel = await screen.findByText('08-27')
    const chartItem = dateLabel.parentElement
    const bar = chartItem?.querySelector('[data-usage-bar]')
    expect(dateLabel.className).toContain('dark:text-tavern-text-soft')
    expect(bar?.className).toContain('dark:bg-tavern-accent')
    expect(bar?.className).toContain('min-h-[4px]')
  })
})
