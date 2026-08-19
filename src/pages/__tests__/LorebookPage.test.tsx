/**
 * LorebookPage 单元测试
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

vi.mock('../../lib/safeOps', () => ({
  safeSave: vi.fn(async (fn: () => Promise<void>) => await fn()),
}))

Object.defineProperty(window, 'api', {
  value: {
    lorebook: {
      list: vi.fn(async () => []),
      save: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
      importJson: vi.fn(async () => null),
    },
  },
})

import { LorebookPage } from '../LorebookPage'

describe('LorebookPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('渲染页面标题', async () => {
    render(<LorebookPage />)
    await waitFor(() => expect(window.api.lorebook.list).toHaveBeenCalled())
    expect(screen.getByText('世界书')).toBeInTheDocument()
  })

  it('显示导入和新建按钮', async () => {
    render(<LorebookPage />)
    await waitFor(() => expect(window.api.lorebook.list).toHaveBeenCalled())
    expect(screen.getByText('导入')).toBeInTheDocument()
    expect(screen.getByText('新建')).toBeInTheDocument()
  })
})
