/**
 * UsagePage 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

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
      onDone: vi.fn(() => vi.fn()),
    },
  },
})

import { UsagePage } from '../UsagePage'

describe('UsagePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('渲染页面标题', async () => {
    render(<UsagePage />)
    expect(screen.getByText('用量统计')).toBeInTheDocument()
  })

  it('显示导出按钮', () => {
    render(<UsagePage />)
    expect(screen.getByText('导出 CSV')).toBeInTheDocument()
  })
})
