/**
 * RegexPage 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

vi.mock('react-router-dom', () => ({
  useNavigate: vi.fn(() => vi.fn()),
}))

vi.mock('../../lib/logger', () => ({
  logError: vi.fn(),
}))

vi.mock('../../lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

Object.defineProperty(window, 'api', {
  value: {
    regex: {
      list: vi.fn(async () => []),
      save: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
      create: vi.fn(async () => ({ id: 'new', name: '新规则', pattern: '', replacement: '', enabled: true })),
    },
  },
})

import { RegexPage } from '../RegexPage'

describe('RegexPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('渲染页面标题', async () => {
    render(<RegexPage />)
    await waitFor(() => expect(window.api.regex.list).toHaveBeenCalled())
    expect(screen.getByText('正则表达式')).toBeInTheDocument()
  })

  it('显示新建按钮', async () => {
    render(<RegexPage />)
    await waitFor(() => expect(window.api.regex.list).toHaveBeenCalled())
    expect(screen.getByText('新建规则')).toBeInTheDocument()
  })
})
