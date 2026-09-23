/**
 * LorebookPage 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { getDefaultSettings } from '../../../shared/defaults'
import { useSettingsStore } from '../../store/useSettingsStore'
import type { LorebookIndexProgress } from '../../../shared/ipc-api'

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

/** UEX-P1-28：捕获页面订阅的索引进度监听器（由 onIndexProgress mock 注入） */
let indexProgressListener: ((progress: LorebookIndexProgress) => void) | null = null

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
      cancelIndex: vi.fn(async () => ({ ok: true })),
      onIndexProgress: vi.fn((listener: (progress: LorebookIndexProgress) => void) => {
        indexProgressListener = listener
        return () => { indexProgressListener = null }
      }),
    },
  },
})

import { LorebookPage } from '../LorebookPage'

describe('LorebookPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    indexProgressListener = null
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

  it('UEX-P1-22：新建保存失败时移除乐观新建的世界书并给出错误提示', async () => {
    vi.mocked(window.api.lorebook.save).mockRejectedValueOnce(new Error('磁盘写入失败'))
    render(<LorebookPage />)
    await waitFor(() => expect(window.api.lorebook.list).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: /^新建$/ }))

    expect(await screen.findByRole('dialog', { name: '世界书保存失败' })).toBeInTheDocument()
    expect(screen.getByText('磁盘写入失败')).toBeInTheDocument()
    // 乐观新建项已从列表移除，回到空态
    expect(screen.getByText('还没有世界书')).toBeInTheDocument()
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

  it('UEX-P1-28：索引进度显示 x/y、条目名与百分比，完成后收起并保留「已索引 N 个条目」', async () => {
    vi.mocked(window.api.lorebook.list).mockResolvedValueOnce([{
      id: 'progress-book',
      name: '进度世界书',
      description: '',
      enabled: true,
      scanDepth: 4,
      entries: [
        { id: 'e1', keywords: ['王城'], content: '王城设定', position: 'before_char', order: 100, probability: 100, enabled: true, matchMode: 'both' },
        { id: 'e2', keywords: ['森林'], content: '森林设定', position: 'before_char', order: 100, probability: 100, enabled: true, matchMode: 'both' },
        { id: 'e3', keywords: ['河流'], content: '河流设定', position: 'before_char', order: 100, probability: 100, enabled: true, matchMode: 'both' },
      ],
    }])
    vi.mocked(window.api.embedding.indexStatus).mockResolvedValue({
      'progress-book': { indexed: 3, model: 'bge-small-zh@1.2.3', updatedAt: 1, stale: 0 },
    })
    let resolveIndex!: (result: { ok: boolean; canceled?: boolean; total?: number; indexed?: number; failed?: number }) => void
    vi.mocked(window.api.embedding.indexLorebook).mockImplementationOnce(() => new Promise((resolve) => { resolveIndex = resolve }))

    render(<LorebookPage />)
    const semanticGroup = await screen.findByRole('group', { name: '语义索引操作' })
    fireEvent.click(within(semanticGroup).getByRole('button', { name: '生成语义索引' }))

    // 逐条目进度：x/y + 条目名 + 百分比（进度条样式对齐角色批量导入）
    act(() => { indexProgressListener?.({ lorebookId: 'progress-book', current: 1, total: 3, entryName: '王城' }) })
    const progress = screen.getByRole('status', { name: '语义索引进度' })
    expect(progress.textContent).toContain('索引中 1 / 3')
    expect(within(progress).getByText('王城')).toBeInTheDocument()
    expect(progress.textContent).toContain('33%')
    const bar = progress.querySelector('[style*="width"]') as HTMLElement
    expect(bar.style.width).toBe('33%')
    expect(within(progress).getByRole('button', { name: '取消索引' })).toBeInTheDocument()

    // 完成后进度区收起，保留「已索引 N 个条目」
    await act(async () => { resolveIndex({ ok: true, canceled: false, total: 3, indexed: 3, failed: 0 }) })
    expect(screen.queryByRole('status', { name: '语义索引进度' })).not.toBeInTheDocument()
    expect(await screen.findByText('已索引 3 个条目')).toBeInTheDocument()
  })

  it('UEX-P1-28：取消后结果条「已取消：已索引 x/y」，手动关闭前不消失', async () => {
    vi.mocked(window.api.lorebook.list).mockResolvedValueOnce([{
      id: 'cancel-book',
      name: '取消世界书',
      description: '',
      enabled: true,
      scanDepth: 4,
      entries: [
        { id: 'e1', keywords: ['王城'], content: '王城设定', position: 'before_char', order: 100, probability: 100, enabled: true, matchMode: 'both' },
        { id: 'e2', keywords: ['森林'], content: '森林设定', position: 'before_char', order: 100, probability: 100, enabled: true, matchMode: 'both' },
        { id: 'e3', keywords: ['河流'], content: '河流设定', position: 'before_char', order: 100, probability: 100, enabled: true, matchMode: 'both' },
      ],
    }])
    vi.mocked(window.api.embedding.indexLorebook).mockResolvedValueOnce({ ok: true, canceled: true, total: 3, indexed: 1 })

    render(<LorebookPage />)
    const semanticGroup = await screen.findByRole('group', { name: '语义索引操作' })
    fireEvent.click(within(semanticGroup).getByRole('button', { name: '生成语义索引' }))

    // 取消汇总（已完成条目已保留），手动关闭前不自动消失
    expect(await screen.findByText('已取消：已索引 1/3')).toBeInTheDocument()
    expect(screen.getByText('（已完成条目已保留）')).toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(screen.getByText('已取消：已索引 1/3')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('关闭'))
    expect(screen.queryByText('已取消：已索引 1/3')).not.toBeInTheDocument()
  })

  it('UEX-P1-28：索引期间禁用全部入口（防重入），「取消索引」触发幂等取消', async () => {
    vi.mocked(window.api.lorebook.list).mockResolvedValueOnce([{
      id: 'guard-book',
      name: '防重入世界书',
      description: '',
      enabled: true,
      scanDepth: 4,
      entries: [
        { id: 'kw', keywords: ['王城'], content: '仅关键词', position: 'before_char', order: 100, probability: 100, enabled: true, matchMode: 'keyword' },
      ],
    }])
    let resolveIndex!: (result: { ok: boolean; canceled?: boolean; total?: number; indexed?: number }) => void
    vi.mocked(window.api.embedding.indexLorebook).mockImplementationOnce(() => new Promise((resolve) => { resolveIndex = resolve }))

    render(<LorebookPage />)
    const semanticGroup = await screen.findByRole('group', { name: '语义索引操作' })
    const batchButton = within(semanticGroup).getByRole('button', { name: /批量启用语义/ })
    expect(batchButton).not.toBeDisabled()

    fireEvent.click(within(semanticGroup).getByRole('button', { name: '生成语义索引' }))
    await waitFor(() => expect(window.api.embedding.indexLorebook).toHaveBeenCalledTimes(1))

    // 防重入：单条索引入口（索引中…）与批量启用语义（含批量启用后的自动索引）全部禁用
    const indexingButton = within(semanticGroup).getByRole('button', { name: /索引中/ })
    expect(indexingButton).toBeDisabled()
    expect(batchButton).toBeDisabled()
    fireEvent.click(indexingButton)
    expect(window.api.embedding.indexLorebook).toHaveBeenCalledTimes(1)

    // 取消（主进程侧幂等）；点击后按钮进入「正在取消…」并禁用
    fireEvent.click(screen.getByRole('button', { name: '取消索引' }))
    await waitFor(() => expect(window.api.embedding.cancelIndex).toHaveBeenCalledWith('guard-book'))
    expect(screen.getByRole('button', { name: '正在取消…' })).toBeDisabled()
    await act(async () => { resolveIndex({ ok: true, canceled: true, total: 1, indexed: 0 }) })
    expect(await screen.findByText('已取消：已索引 0/1')).toBeInTheDocument()
  })
})
