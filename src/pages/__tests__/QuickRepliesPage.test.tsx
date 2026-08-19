/**
 * QuickRepliesPage 单元测试
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

vi.mock('../../utils/quickReply', () => ({
  createQuickReply: vi.fn(() => ({ id: 'new', text: '', hotkey: 0, scope: 'global' })),
}))

vi.mock('../../utils/macros', () => ({
  listMacros: vi.fn(() => []),
}))

Object.defineProperty(window, 'api', {
  value: {
    quickReply: {
      listAll: vi.fn(async () => ({ global: [], byCharacter: {} })),
      saveAll: vi.fn(async () => ({})),
    },
    character: {
      list: vi.fn(async () => []),
    },
    preset: {
      list: vi.fn(async () => []),
    },
  },
})

import { QuickRepliesPage } from '../QuickRepliesPage'

describe('QuickRepliesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('渲染页面标题', async () => {
    render(<QuickRepliesPage />)
    await waitFor(() => expect(window.api.quickReply.listAll).toHaveBeenCalled())
    expect(screen.getByText('快捷回复')).toBeInTheDocument()
  })

  it('显示导入和导出按钮', async () => {
    render(<QuickRepliesPage />)
    await waitFor(() => expect(window.api.quickReply.listAll).toHaveBeenCalled())
    expect(screen.getByText('导入')).toBeInTheDocument()
    expect(screen.getByText('导出')).toBeInTheDocument()
  })
})
