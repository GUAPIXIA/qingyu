import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ReviewStep } from '../ReviewStep'
import { useCharacterCreatorStore } from '../../../store/useCharacterCreatorStore'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { getDefaultSettings } from '../../../../shared/defaults'

function renderStep() {
  return render(
    <MemoryRouter initialEntries={['/create']}>
      <Routes>
        <Route path="/create" element={<ReviewStep />} />
        <Route path="/chat" element={<div>聊天页面</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  useCharacterCreatorStore.getState().reset()
  useSettingsStore.setState({
    settings: { ...getDefaultSettings(), activeProfileId: null, connectionProfiles: [] },
  })
  ;(window.api.character.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: 'existing', name: '已有角色' },
  ])
})

describe('ReviewStep（预览保存）', () => {
  it('渲染角色信息摘要与未命名兜底提示', () => {
    useCharacterCreatorStore.getState().updateDraft({
      name: '',
      description: '赛博朋克女黑客',
      tags: ['黑客', '御姐'],
    })
    renderStep()
    expect(screen.getByText('未命名角色')).toBeInTheDocument()
    expect(screen.getByText('赛博朋克女黑客')).toBeInTheDocument()
    expect(screen.getByText('黑客')).toBeInTheDocument()
    expect(screen.getAllByText('（未填写）').length).toBeGreaterThan(0) // 其余字段未填
  })

  it('保存成功跳转 /chat', async () => {
    useCharacterCreatorStore.getState().updateDraft({ name: '零' })
    renderStep()
    fireEvent.click(screen.getByText('保存角色'))
    await act(async () => {}) // 冲刷 saveCharacter 的异步链路（保存/加载/选中）
    expect(screen.getByText('聊天页面')).toBeInTheDocument()
    expect(window.api.character.save).toHaveBeenCalled()
  })

  it('有封面时显示头像位置选择', () => {
    useCharacterCreatorStore.getState().setCover('data:image/png;base64,cover')
    renderStep()
    expect(screen.getByText('头像裁剪位置（从封面 1:1 裁剪）')).toBeInTheDocument()
    fireEvent.click(screen.getByText('偏上'))
    expect(useCharacterCreatorStore.getState().avatarPosition).toBe('top')
  })

  it('无封面时不显示头像位置区', () => {
    renderStep()
    expect(screen.queryByText(/头像裁剪位置/)).not.toBeInTheDocument()
  })

  it('保存失败时显示错误条且不跳转', async () => {
    useCharacterCreatorStore.getState().updateDraft({ name: '零' })
    ;(window.api.character.save as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('disk full'))
    renderStep()
    fireEvent.click(screen.getByText('保存角色'))
    await act(async () => {}) // 冲刷保存失败的异步 set
    expect(screen.getByText(/保存失败：disk full/)).toBeInTheDocument()
    expect(screen.queryByText('聊天页面')).not.toBeInTheDocument()
  })
})
