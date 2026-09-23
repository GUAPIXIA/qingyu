/**
 * RegexPage 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

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

  it('UEX-P1-27：删除确认文案包含规则实际作用范围与处理阶段', async () => {
    vi.mocked(window.api.regex.list).mockResolvedValueOnce([{
      id: 'r1',
      name: '清理状态标签',
      pattern: '\\[Status:.*?\\]',
      replacement: '',
      scope: 'output',
      stage: 'markdown',
      enabled: true,
    }])
    render(<RegexPage />)
    await screen.findByText('清理状态标签')

    fireEvent.click(screen.getByTitle('删除'))
    const dialog = await screen.findByRole('dialog', { name: '删除规则' })
    const message = within(dialog).getByText(/作用于/).textContent ?? ''
    expect(message).toContain('「清理状态标签」')
    expect(message).toContain('输出')
    expect(message).toContain('Markdown')
    expect(message).toContain('（当前启用）')
  })
})
