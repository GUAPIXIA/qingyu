/**
 * QuickRepliesPage 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useToastStore } from '../../store/useToastStore'
import { confirm } from '../../store/useConfirmStore'

// 一致性：导入确认已迁移全局 confirm 通道，测试 mock 该 store（参考 src/commands/__tests__/builtin.test.ts）；
// 默认同意，取消用例单独覆写
vi.mock('../../store/useConfirmStore', () => ({
  confirm: vi.fn().mockResolvedValue(true),
}))

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

vi.mock('../../../shared/chat-core/macros', () => ({
  listMacros: vi.fn(() => []),
}))

Object.defineProperty(window, 'api', {
  value: {
    quickReply: {
      listAll: vi.fn(async () => ({ global: [], byCharacter: {} })),
      saveAll: vi.fn(async () => ({})),
      importJson: vi.fn(async () => ({ ok: true })),
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
    useToastStore.getState().dismissAll()
    vi.mocked(confirm).mockResolvedValue(true)
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

  it('UEX-P0-03：导入成功文案并入「替换 N 条」明细', async () => {
    vi.mocked(window.api.quickReply.importJson).mockResolvedValueOnce(
      { ok: true, replacedGlobal: 2 } as unknown as Awaited<ReturnType<typeof window.api.quickReply.importJson>>,
    )
    render(<QuickRepliesPage />)
    await waitFor(() => expect(window.api.quickReply.listAll).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: /导入/ }))

    await waitFor(() => {
      expect(window.api.quickReply.importJson).toHaveBeenCalled()
      expect(useToastStore.getState().toasts.some((t) => t.title === '快捷回复已导入（替换原有 2 条）')).toBe(true)
    })
  })

  it('一致性：确认后执行导入（全局 confirm 通道替代 window.confirm）', async () => {
    render(<QuickRepliesPage />)
    await waitFor(() => expect(window.api.quickReply.listAll).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: /导入/ }))

    await waitFor(() => expect(window.api.quickReply.importJson).toHaveBeenCalled())
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: '导入快捷回复',
      message: '导入将替换全部全局快捷回复，角色专属会合并。是否继续？',
    }))
  })

  it('一致性：取消确认则不导入', async () => {
    vi.mocked(confirm).mockResolvedValueOnce(false)
    render(<QuickRepliesPage />)
    await waitFor(() => expect(window.api.quickReply.listAll).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: /导入/ }))

    await waitFor(() => {
      expect(useToastStore.getState().toasts.some((t) => t.title === '已取消导入')).toBe(true)
    })
    expect(window.api.quickReply.importJson).not.toHaveBeenCalled()
  })
})
