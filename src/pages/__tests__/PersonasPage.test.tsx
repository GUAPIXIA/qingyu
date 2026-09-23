import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { getDefaultSettings } from '../../../shared/defaults'
import type { Persona } from '../../../shared/types'
import { usePersonaStore } from '../../store/usePersonaStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { useToastStore } from '../../store/useToastStore'
import { PersonasPage } from '../PersonasPage'

const persona: Persona = {
  id: 'persona-1',
  name: '旅行者',
  description: '来自远方',
  persona: '冷静',
  avatar: '',
  createdAt: 1,
  updatedAt: 1,
}

// setup.ts 的 persona mock 仅有 list，补 save/delete 供保存/删除激活路径使用
Object.assign(window.api.persona, {
  save: vi.fn(async (p: Persona) => p),
  delete: vi.fn(async () => {}),
})

describe('PersonasPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useToastStore.getState().dismissAll()
    vi.mocked(window.api.persona.list).mockResolvedValue([persona])
    vi.mocked(window.api.persona.save).mockImplementation(async (p: Persona) => p)
    usePersonaStore.setState({ personas: [persona], loaded: true })
    useSettingsStore.setState({
      settings: {
        ...getDefaultSettings(),
        activePersonaId: persona.id,
        defaultPersonaId: persona.id,
      },
      loaded: true,
      _saveTimer: null,
    })
  })

  it('显示默认身份说明与当前身份徽章', async () => {
    render(<PersonasPage />)

    await screen.findByText('旅行者')
    expect(screen.getByText('默认')).toBeTruthy()
    // M10：当前身份显示「当前」徽章
    expect(screen.getAllByText('当前').length).toBeGreaterThan(0)
  })

  it('在身份页面管理用户人设注入规则', async () => {
    render(<PersonasPage />)

    await screen.findByText('用户人设注入')
    const toggle = screen.getByRole('switch', { name: '注入用户人设' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(toggle)
    expect(useSettingsStore.getState().settings.personaInjection?.enabled).toBe(false)
  })

  it('在身份页面编辑并恢复全局叙事规则', async () => {
    render(<PersonasPage />)

    const editor = await screen.findByRole('textbox', { name: '全局叙事规则' })
    expect(editor).toBeTruthy()
    fireEvent.change(editor, { target: { value: '{{user}}只观察，由{{char}}推进世界。' } })
    expect(useSettingsStore.getState().settings.omniscientNarrativeRules).toBe('{{user}}只观察，由{{char}}推进世界。')
    expect(screen.getByText('自定义规则')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '恢复默认规则' }))
    expect(useSettingsStore.getState().settings.omniscientNarrativeRules).toBeUndefined()
    expect(screen.getByText('内置规则')).toBeTruthy()
  })

  it('一致性：操作反馈走全局 toast（默认身份切换 success）', async () => {
    render(<PersonasPage />)

    await screen.findByText('旅行者')
    fireEvent.click(screen.getByTitle('取消默认身份（新对话将不再默认使用）'))

    await waitFor(() => {
      expect(useToastStore.getState().toasts.some(
        (t) => t.title === '已取消「旅行者」的默认身份' && t.variant === 'success',
      )).toBe(true)
    })
  })

  it('UEX-P1-30：编辑当前激活身份保存后，settings 快照经唯一写入口同步', async () => {
    render(<PersonasPage />)

    await screen.findByText('旅行者')
    fireEvent.click(screen.getByText('旅行者'))
    const nameInput = await screen.findByPlaceholderText('你的名字')
    fireEvent.change(nameInput, { target: { value: '新旅行者' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      const s = useSettingsStore.getState().settings
      expect(s.activePersonaId).toBe(persona.id)
      expect(s.userName).toBe('新旅行者')
      expect(s.userDescription).toBe('来自远方')
      expect(s.userPersona).toBe('冷静')
    })
  })
})
