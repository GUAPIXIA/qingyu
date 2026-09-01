import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { getDefaultSettings } from '../../../../shared/defaults'
import { useGroupChatStore } from '../../../store/useGroupChatStore'
import { usePersonaStore } from '../../../store/usePersonaStore'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { GroupPersonaSwitcher } from '../GroupPersonaSwitcher'

describe('GroupPersonaSwitcher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({
      settings: getDefaultSettings(), credentials: {}, loaded: true, _saveTimer: null,
    })
    usePersonaStore.setState({
      personas: [
        { id: 'p1', name: '林舟', description: '', persona: '', avatar: '', createdAt: 0, updatedAt: 0 },
        { id: 'p2', name: '沈知夏', description: '', persona: '', avatar: '', createdAt: 0, updatedAt: 0 },
      ],
      loaded: true,
    })
    useGroupChatStore.setState({
      currentGroup: { id: 'g1' } as never,
      currentSessionId: 's1',
      sessions: [{ id: 's1', groupId: 'g1', personaId: 'p1' } as never],
    })
  })

  it('在群聊顶栏直接显示并切换当前用户身份', async () => {
    render(<GroupPersonaSwitcher />)

    fireEvent.click(screen.getByRole('button', { name: /当前身份：林舟/ }))
    fireEvent.click(screen.getByRole('button', { name: /切换为身份：沈知夏/ }))

    await waitFor(() => {
      expect(window.api.group.updateSession).toHaveBeenCalledWith('g1', 's1', { personaId: 'p2' })
    })
    expect(screen.getByRole('button', { name: /当前身份：沈知夏/ })).toBeTruthy()
  })
})
