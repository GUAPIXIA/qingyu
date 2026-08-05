import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { CharacterCreatePage } from '../CharacterCreatePage'
import { useCharacterCreatorStore, DRAFT_KEY } from '../../store/useCharacterCreatorStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { getDefaultSettings } from '../../../shared/defaults'

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/character-create']}>
      <Routes>
        <Route path="/character-create" element={<CharacterCreatePage />} />
        <Route path="/chat" element={<div>聊天页面</div>} />
        <Route path="/characters" element={<div>角色列表页</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  useCharacterCreatorStore.getState().reset()
  useSettingsStore.setState({
    settings: {
      ...getDefaultSettings(),
      activeProfileId: null,
      connectionProfiles: [],
    },
  })
})

describe('CharacterCreatePage（向导容器）', () => {
  it('渲染标题与第一步（概念设定）', () => {
    renderPage()
    expect(screen.getByText('制作角色卡')).toBeInTheDocument()
    expect(screen.getByText('AI 一句话扩展')).toBeInTheDocument()
  })

  it('下一步/上一步切换步骤', () => {
    renderPage()
    // Step 0 → 1
    fireEvent.click(screen.getByText('下一步'))
    expect(screen.getByText('上传图片')).toBeInTheDocument()
    // Step 1 → 2
    fireEvent.click(screen.getByText('下一步'))
    expect(screen.getByText('保存角色')).toBeInTheDocument()
    // 回退
    fireEvent.click(screen.getByText('上一步'))
    expect(screen.getByText('上传图片')).toBeInTheDocument()
  })

  it('第一步时上一步禁用', () => {
    renderPage()
    expect(screen.getByText('上一步')).toBeDisabled()
  })

  it('最后一步隐藏下一步按钮', () => {
    renderPage()
    act(() => {
      useCharacterCreatorStore.getState().setStep(2)
    })
    expect(screen.queryByText('下一步')).not.toBeInTheDocument()
    expect(screen.getByText('保存角色')).toBeInTheDocument()
  })

  it('存在草稿时弹出恢复确认，可恢复', () => {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        step: 2,
        draft: { id: 'd1', name: '草稿角色甲' },
        savedAt: Date.now(),
      }),
    )
    renderPage()
    expect(screen.getByText('发现未完成的草稿')).toBeInTheDocument()
    fireEvent.click(screen.getByText('恢复草稿'))
    expect(useCharacterCreatorStore.getState().draft.name).toBe('草稿角色甲')
    expect(screen.getByText('保存角色')).toBeInTheDocument() // 恢复到第 3 步
  })

  it('草稿弹窗可选择不恢复（清除草稿）', () => {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ step: 1, draft: { id: 'd1', name: 'x' }, savedAt: Date.now() }),
    )
    renderPage()
    fireEvent.click(screen.getByText('不恢复'))
    expect(useCharacterCreatorStore.getState().draft.name).toBe('')
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull()
  })

  it('返回按钮：防抖写草稿后弹确认，确认后回到角色列表', async () => {
    renderPage()
    // 等待防抖 500ms 使 dirtyRef 置位（有草稿时才弹离开确认）
    await new Promise((r) => setTimeout(r, 600))
    fireEvent.click(screen.getByText('返回'))
    expect(screen.getByText('离开制作向导？')).toBeInTheDocument()
    fireEvent.click(screen.getByText('保存并离开'))
    expect(screen.getByText('角色列表页')).toBeInTheDocument()
  })

  it('步骤指示器点击回退到概念设定', () => {
    renderPage()
    act(() => {
      useCharacterCreatorStore.getState().setStep(1)
    })
    fireEvent.click(screen.getByText('概念设定'))
    expect(screen.getByText('AI 一句话扩展')).toBeInTheDocument()
  })
})
