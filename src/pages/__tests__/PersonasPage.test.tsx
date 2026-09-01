import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { getDefaultSettings } from '../../../shared/defaults'
import type { Persona } from '../../../shared/types'
import { usePersonaStore } from '../../store/usePersonaStore'
import { useSettingsStore } from '../../store/useSettingsStore'
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

describe('PersonasPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    vi.mocked(window.api.persona.list).mockResolvedValue([persona])
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

  it('只显示默认身份，不再显示当前身份状态', async () => {
    render(<PersonasPage />)

    await screen.findByText('旅行者')
    expect(screen.getByText('默认')).toBeTruthy()
    expect(screen.queryByText('当前')).toBeNull()
    expect(screen.queryByText('当前 vs 默认')).toBeNull()
  })

  it('在身份页面管理用户人设注入规则', async () => {
    render(<PersonasPage />)

    await screen.findByText('用户人设注入')
    const toggle = screen.getByRole('switch', { name: '注入用户人设' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(toggle)
    expect(useSettingsStore.getState().settings.personaInjection?.enabled).toBe(false)
  })
})
