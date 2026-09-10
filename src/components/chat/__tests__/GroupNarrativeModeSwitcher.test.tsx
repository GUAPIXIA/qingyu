import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GroupNarrativeModeSwitcher } from '../GroupNarrativeModeSwitcher'
import { useGroupChatStore } from '../../../store/useGroupChatStore'
import type { GroupChat, GroupSession } from '../../../../shared/types'

describe('GroupNarrativeModeSwitcher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useGroupChatStore.setState({
      currentGroup: { id: 'group-1' } as GroupChat,
      currentSessionId: 'session-1',
      sessions: [{ id: 'session-1', groupId: 'group-1', narrativeMode: 'immersive' } as GroupSession],
      isStreaming: false,
    })
  })

  it('切换并持久化当前群聊会话模式', async () => {
    render(<GroupNarrativeModeSwitcher isStreaming={false} />)

    fireEvent.click(screen.getByRole('radio', { name: '全局叙事' }))

    await waitFor(() => expect(window.api.group.updateSession).toHaveBeenCalledWith(
      'group-1', 'session-1', { narrativeMode: 'omniscient' },
    ))
    expect(useGroupChatStore.getState().sessions[0].narrativeMode).toBe('omniscient')
    expect(await screen.findByText(/仅影响后续回复/)).toBeTruthy()
  })

  it('生成中禁用切换', () => {
    render(<GroupNarrativeModeSwitcher isStreaming />)
    expect(screen.getByRole('radio', { name: '全局叙事' })).toBeDisabled()
  })
})
