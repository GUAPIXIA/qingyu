/**
 * LorebookPage 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { getDefaultSettings } from '../../../shared/defaults'
import { useSettingsStore } from '../../store/useSettingsStore'

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
      importJsonDetailed: vi.fn(async () => null),
      exportJson: vi.fn(async () => ({ ok: true })),
    },
    embedding: {
      indexStatus: vi.fn(async () => ({})),
      indexLorebook: vi.fn(async () => ({ ok: true })),
    },
  },
})

import { LorebookPage } from '../LorebookPage'

describe('LorebookPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ settings: getDefaultSettings() })
  })

  it('渲染页面标题', async () => {
    render(<LorebookPage />)
    await waitFor(() => expect(window.api.lorebook.list).toHaveBeenCalled())
    expect(screen.getByText('世界书')).toBeInTheDocument()
  })

  it('显示导入和新建按钮', async () => {
    render(<LorebookPage />)
    await waitFor(() => expect(window.api.lorebook.list).toHaveBeenCalled())
    const importButton = screen.getByRole('button', { name: /^导入$/ })
    const newButton = screen.getByRole('button', { name: /^新建$/ })
    expect(importButton).toHaveClass('btn-primary')
    expect(newButton).toHaveClass('btn-secondary')
    expect(importButton.compareDocumentPosition(newButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('圆圈感叹号可切换导入与映射向导说明', async () => {
    render(<LorebookPage />)
    await waitFor(() => expect(window.api.lorebook.list).toHaveBeenCalled())
    const importGroup = screen.getByRole('group', { name: '导入、映射向导与说明' })
    expect(within(importGroup).getByRole('button', { name: '导入' })).toBeInTheDocument()
    expect(within(importGroup).getByRole('button', { name: '映射向导' })).toBeInTheDocument()
    const helpButton = within(importGroup).getByRole('button', { name: '查看导入方式说明' })

    expect(helpButton).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/自动识别轻语、SillyTavern/)).not.toBeInTheDocument()

    fireEvent.click(helpButton)
    expect(helpButton).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/自动识别轻语、SillyTavern/)).toBeInTheDocument()
    expect(screen.getByText(/用于无法自动识别的自定义 JSON/)).toBeInTheDocument()

    fireEvent.click(helpButton)
    expect(helpButton).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/自动识别轻语、SillyTavern/)).not.toBeInTheDocument()
  })

  it('书级扫描深度允许配置为 0', async () => {
    vi.mocked(window.api.lorebook.list).mockResolvedValueOnce([{
      id: 'depth-zero',
      name: '零深度世界书',
      description: '',
      enabled: true,
      scanDepth: 0,
      entries: [],
    }])
    render(<LorebookPage />)
    const input = await screen.findByDisplayValue('0')
    expect(input).toHaveAttribute('min', '0')
  })

  it('点击编辑条目时使用角色卡风格的模态窗口', async () => {
    vi.mocked(window.api.lorebook.list).mockResolvedValueOnce([{
      id: 'book-with-entry',
      name: '王国设定',
      description: '',
      enabled: true,
      scanDepth: 4,
      entries: [{
        id: 'entry-1',
        keywords: ['王城'],
        content: '王城位于大陆中央。',
        position: 'before_char',
        order: 100,
        probability: 100,
        enabled: true,
        matchMode: 'both',
      }],
    }])

    render(<LorebookPage />)
    await screen.findByText('王城位于大陆中央。')

    fireEvent.click(screen.getByTitle('编辑'))

    const dialog = screen.getByRole('dialog', { name: '编辑世界书条目' })
    expect(dialog).toBeInTheDocument()
    expect(dialog).toHaveClass('max-w-5xl')
    expect(screen.getByRole('button', { name: '保存条目' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '保存条目' }))
    expect(screen.queryByRole('dialog', { name: '编辑世界书条目' })).not.toBeInTheDocument()
    await waitFor(() => expect(window.api.lorebook.save).toHaveBeenCalled())
  })

  it('批量将符合条件的关键词条目改为混合匹配，保存完成后再生成索引', async () => {
    vi.mocked(window.api.lorebook.list).mockResolvedValueOnce([{
      id: 'batch-book',
      name: '批量测试世界书',
      description: '',
      enabled: true,
      scanDepth: 4,
      entries: [
        { id: 'eligible', keywords: ['王城'], content: '王城设定', position: 'before_char', order: 100, probability: 100, enabled: true, matchMode: 'keyword' },
        { id: 'disabled', keywords: ['禁用'], content: '禁用设定', position: 'before_char', order: 100, probability: 100, enabled: false, matchMode: 'keyword' },
        { id: 'empty', keywords: ['空'], content: '  ', position: 'before_char', order: 100, probability: 100, enabled: true, matchMode: 'keyword' },
        { id: 'semantic', keywords: ['语义'], content: '已有语义', position: 'before_char', order: 100, probability: 100, enabled: true, matchMode: 'semantic' },
      ],
    }])
    vi.mocked(window.api.lorebook.save).mockResolvedValue({ revision: 1 })
    vi.mocked(window.api.embedding.indexLorebook).mockResolvedValue({ ok: true })

    render(<LorebookPage />)
    const semanticGroup = await screen.findByRole('group', { name: '语义索引操作' })
    const batchButton = within(semanticGroup).getByRole('button', { name: /批量启用语义 1/ })
    expect(within(semanticGroup).getByRole('button', { name: '生成语义索引' })).toBeInTheDocument()
    fireEvent.click(batchButton)

    const dialog = screen.getByRole('dialog', { name: '批量启用语义匹配' })
    expect(screen.getByText('1 个条目')).toBeInTheDocument()
    expect(screen.getByText(/不会修改已禁用、正文为空/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '修改并生成索引' }))

    await waitFor(() => expect(window.api.embedding.indexLorebook).toHaveBeenCalledWith(
      'batch-book',
      expect.objectContaining({ model: 'nomic-embed-text' }),
    ))
    const saved = vi.mocked(window.api.lorebook.save).mock.calls[0][0]
    expect(saved.entries.find((entry) => entry.id === 'eligible')?.matchMode).toBe('both')
    expect(saved.entries.find((entry) => entry.id === 'disabled')?.matchMode).toBe('keyword')
    expect(saved.entries.find((entry) => entry.id === 'empty')?.matchMode).toBe('keyword')
    expect(saved.entries.find((entry) => entry.id === 'semantic')?.matchMode).toBe('semantic')
    expect(vi.mocked(window.api.lorebook.save).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(window.api.embedding.indexLorebook).mock.invocationCallOrder[0])
    expect(dialog).not.toBeInTheDocument()
  })

  it('导入后展示 adapter 格式、置信度和兼容性摘要', async () => {
    vi.mocked(window.api.lorebook.importJsonDetailed).mockResolvedValueOnce({
      lorebook: {
        id: 'imported', name: '导入书', description: '', enabled: true, scanDepth: 4, entries: [],
      },
      detection: {
        adapterId: 'sillytavern.world-info', formatLabel: 'SillyTavern World Info',
        formatVersion: '2026-07', confidence: 97,
        reasons: ['entries 使用 ST 常见的 uid 键控对象'], conflicts: [],
      },
      report: {
        adapterId: 'sillytavern.world-info', formatLabel: 'SillyTavern World Info',
        formatVersion: '2026-07', status: 'preserved', issues: [],
        summary: { mapped: 0, preserved: 1, approximated: 0, dropped: 0, rejected: 0, warnings: 0, errors: 0 },
      },
    })
    render(<LorebookPage />)
    await waitFor(() => expect(window.api.lorebook.list).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: /^导入$/ }))

    expect(await screen.findByRole('dialog', { name: '世界书导入报告' })).toBeInTheDocument()
    expect(screen.getByText(/SillyTavern World Info/)).toBeInTheDocument()
    expect(screen.getByText(/置信度 97%/)).toBeInTheDocument()
    expect(screen.getByText('已保留扩展字段')).toBeInTheDocument()
  })
})
