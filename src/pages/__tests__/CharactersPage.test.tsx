import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { CharactersPage } from '../CharactersPage'
import { useCharacterStore } from '../../store/useCharacterStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { getDefaultSettings } from '../../../shared/defaults'
import type { Character } from '../../../shared/types'

function makeCharacter(id: string, name: string): Character {
  return {
    id, name, avatar: '', description: '', personality: '',
    scenario: '', firstMessage: '', exampleDialog: '', tags: [], lorebookId: null,
    creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [],
  }
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/characters']}>
      <CharactersPage />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  useCharacterStore.setState({ characters: [], loaded: false, importError: null, importNotice: null, importProgress: null, importingBatch: false, lorebookSuggestions: null })
  // UEX-P1-17：隔离冲突策略的 localStorage 持久化
  localStorage.removeItem('char-import-conflict')
  useSettingsStore.setState({
    settings: getDefaultSettings(),
    credentials: {},
    loaded: true,
    _saveTimer: null,
  })
})

describe('CharactersPage（UEX-P2-05 / UEX-P2-06）', () => {
  it('UEX-P2-05：未加载完成显示加载态，不闪现「还没有角色」空态', () => {
    useCharacterStore.setState({ characters: [], loaded: false })
    renderPage()
    expect(screen.getByText('正在加载角色…')).toBeInTheDocument()
    expect(screen.queryByText('还没有角色')).not.toBeInTheDocument()
  })

  it('UEX-P2-05：加载完成且确实无角色才显示空态', () => {
    useCharacterStore.setState({ characters: [], loaded: true })
    renderPage()
    expect(screen.getByText('还没有角色')).toBeInTheDocument()
    expect(screen.queryByText('正在加载角色…')).not.toBeInTheDocument()
  })

  it('UEX-P2-06：搜索无结果时提供「清空搜索」，点击后恢复列表', async () => {
    useCharacterStore.setState({ characters: [makeCharacter('c1', '艾莉娅')], loaded: true })
    renderPage()
    fireEvent.change(screen.getByPlaceholderText('搜索角色或标签...'), { target: { value: 'zzz' } })
    expect(await screen.findByText('未找到匹配的角色')).toBeInTheDocument()
    fireEvent.click(screen.getByText('清空搜索'))
    expect(await screen.findByText('艾莉娅')).toBeInTheDocument()
    expect(screen.queryByText('未找到匹配的角色')).not.toBeInTheDocument()
  })
})

describe('CharactersPage（UEX-P2-04 批量导入取消/防重入）', () => {
  it('进度中展示「取消导入」，点击后变「正在取消…」并禁用', async () => {
    const cancelMock = vi.fn().mockResolvedValue(undefined)
    ;(window.api.character as unknown as Record<string, unknown>).importBatchCancel = cancelMock
    useCharacterStore.setState({
      characters: [makeCharacter('c1', '艾莉娅')],
      loaded: true,
      importProgress: { current: 1, total: 5, fileName: 'a.png', status: 'processing' },
      importingBatch: true,
    })
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: '取消导入' }))
    expect(cancelMock).toHaveBeenCalledTimes(1)
    const cancelingBtn = await screen.findByRole('button', { name: '正在取消…' })
    expect(cancelingBtn).toBeDisabled()
  })

  it('进度期间导入按钮禁用（防重入），点击不触发导入', () => {
    const importBatchMock = vi.fn()
    ;(window.api.character as unknown as Record<string, unknown>).importBatch = importBatchMock
    useCharacterStore.setState({
      characters: [makeCharacter('c1', '艾莉娅')],
      loaded: true,
      importProgress: { current: 1, total: 5, fileName: 'a.png', status: 'processing' },
    })
    renderPage()

    const batchBtn = screen.getByRole('button', { name: '批量导入' })
    expect(batchBtn).toBeDisabled()
    expect(screen.getByRole('button', { name: 'PNG' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'JSON' })).toBeDisabled()
    fireEvent.click(batchBtn)
    expect(importBatchMock).not.toHaveBeenCalled()
  })

  it('取消结束后结果条展示「已取消」汇总与失败明细（不自动消失）', async () => {
    ;(window.api.character as unknown as Record<string, unknown>).importBatch = vi.fn().mockResolvedValue({
      success: true,
      canceled: true,
      results: [{ name: '坏卡.png', success: false, error: '解析失败' }],
      total: 5,
      successCount: 1,
      failCount: 1,
      skippedCount: 3,
    })
    ;(window.api.character as unknown as Record<string, unknown>).onImportProgress = vi.fn(() => () => {})
    ;(window.api.character as unknown as Record<string, unknown>).list = vi.fn().mockResolvedValue([makeCharacter('c1', '艾莉娅')])
    useCharacterStore.setState({ characters: [makeCharacter('c1', '艾莉娅')], loaded: true })
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: '批量导入' }))

    expect(await screen.findByText(/批量导入已取消/)).toBeInTheDocument()
    expect(screen.getByText(/未处理/)).toBeInTheDocument()
    expect(screen.getByText(/坏卡\.png/)).toBeInTheDocument()
  })
})

describe('CharactersPage（UEX-P1-17 导入查重）', () => {
  it('同名冲突策略默认「另存副本」，切换「覆盖原卡」后透传给导入接口并记住选择', async () => {
    const importJsonMock = vi.fn().mockResolvedValue({ success: true, outcome: 'skippedIdentical', note: '已存在相同角色：艾莉娅' })
    ;(window.api.character as unknown as Record<string, unknown>).importJson = importJsonMock
    ;(window.api.character as unknown as Record<string, unknown>).onImportProgress = vi.fn(() => () => {})
    useCharacterStore.setState({ characters: [makeCharacter('c1', '艾莉娅')], loaded: true })
    renderPage()

    const select = screen.getByRole('combobox', { name: '同名冲突时' }) as HTMLSelectElement
    expect(select).toHaveValue('copy')

    // store 的导入是异步落状态，用 act 包住点击避免 update 警告
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'JSON' })) })
    expect(importJsonMock).toHaveBeenCalledWith('copy')

    fireEvent.change(select, { target: { value: 'overwrite' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'JSON' })) })
    expect(importJsonMock).toHaveBeenLastCalledWith('overwrite')
    expect(localStorage.getItem('char-import-conflict')).toBe('overwrite')
  })

  it('单张导入内容相同时提示「已存在相同角色：{name}」（不产生新卡）', async () => {
    ;(window.api.character as unknown as Record<string, unknown>).importJson = vi.fn().mockResolvedValue({
      success: true, outcome: 'skippedIdentical', note: '已存在相同角色：艾莉娅',
    })
    ;(window.api.character as unknown as Record<string, unknown>).onImportProgress = vi.fn(() => () => {})
    useCharacterStore.setState({ characters: [makeCharacter('c1', '艾莉娅')], loaded: true })
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'JSON' }))

    expect(await screen.findByText(/已存在相同角色：艾莉娅/)).toBeInTheDocument()
  })

  it('批量结果条区分「跳过 N 个相同 / 副本 M 个 / 覆盖 K 个」并展示查重明细', async () => {
    ;(window.api.character as unknown as Record<string, unknown>).importBatch = vi.fn().mockResolvedValue({
      success: true,
      results: [
        { name: '艾莉娅', success: true, outcome: 'skippedIdentical', note: '已存在相同角色：艾莉娅' },
        { name: '贝拉（副本）', success: true, outcome: 'copied', note: '已另存副本：贝拉（副本）' },
        { name: '卡莲', success: true, outcome: 'overwritten', note: '已覆盖同名角色：卡莲' },
        { name: '新角色', success: true, outcome: 'imported', note: '已导入：新角色' },
      ],
      total: 4,
      successCount: 3,
      failCount: 0,
      skippedCount: 0,
      skippedIdentical: 1,
      copied: 1,
      overwritten: 1,
    })
    ;(window.api.character as unknown as Record<string, unknown>).onImportProgress = vi.fn(() => () => {})
    ;(window.api.character as unknown as Record<string, unknown>).list = vi.fn().mockResolvedValue([makeCharacter('c1', '艾莉娅')])
    useCharacterStore.setState({ characters: [makeCharacter('c1', '艾莉娅')], loaded: true })
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: '批量导入' }))

    expect(await screen.findByText(/批量导入完成/)).toBeInTheDocument()
    expect(screen.getByText(/跳过 1 个相同 \/ 副本 1 个 \/ 覆盖 1 个/)).toBeInTheDocument()
    expect(screen.getByText(/已存在相同角色：艾莉娅/)).toBeInTheDocument()
    expect(screen.getByText(/已覆盖同名角色：卡莲/)).toBeInTheDocument()
    // 正常导入不进查重明细
    expect(screen.queryByText(/已导入：新角色/)).not.toBeInTheDocument()
  })
})
