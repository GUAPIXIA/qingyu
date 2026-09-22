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

  it('分组选项把按天放在第一位', async () => {
    render(<UsagePage />)
    await waitFor(() => {
      expect(window.api.usage.aggregate).toHaveBeenCalledWith({}, 'day', 'Asia/Shanghai')
    })

    const labels = screen.getAllByRole('button')
      .map((button) => button.textContent)
      .filter((label) => ['按天', '按角色', '按对话', '按模型'].includes(label ?? ''))
    expect(labels).toEqual(['按天', '按角色', '按对话', '按模型'])
    expect(screen.getByRole('button', { name: '按天' }).className).toContain('bg-tavern-accent')
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

  it('每日趋势在浅色与夜间模式都使用可解析的实色柱体', async () => {
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
    expect(bar?.className.split(' ')).toContain('bg-tavern-accent')
    expect(bar?.className).not.toContain('bg-tavern-accent/85')
    expect(bar?.className).toContain('min-h-[4px]')
  })

  it('每日趋势最多显示最近 30 条，表格仍保留完整记录', async () => {
    const days = Array.from({ length: 31 }, (_, index) => ({
      key: `2026-08-${String(index + 1).padStart(2, '0')}`,
      inputChars: index + 1,
      outputChars: index + 1,
      totalChars: (index + 1) * 2,
      count: 1,
    })).reverse()
    vi.mocked(window.api.usage.aggregate).mockResolvedValue(days)
    const { container } = render(<UsagePage />)
    await waitFor(() => expect(window.api.usage.summary).toHaveBeenCalled())

    fireEvent.click(screen.getByText('按天'))

    await screen.findByText('08-31')
    expect(container.querySelectorAll('[data-usage-bar]')).toHaveLength(30)
    expect(screen.queryByText('08-01')).not.toBeInTheDocument()
    expect(screen.getByText('2026-08-01')).toBeInTheDocument()
  })
})
