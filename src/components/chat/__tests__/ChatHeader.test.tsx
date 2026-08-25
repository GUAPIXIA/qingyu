import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { getDefaultSettings } from '../../../../shared/defaults'
import type { Character } from '../../../../shared/types'
import { useCharacterStore } from '../../../store/useCharacterStore'
import { useChatStore } from '../../../store/useChatStore'
import { usePersonaStore } from '../../../store/usePersonaStore'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { ChatHeader } from '../ChatHeader'

const character: Character = {
  id: 'char-1',
  name: 'Alice',
  avatar: '',
  description: '',
  personality: '',
  scenario: '',
  firstMessage: '',
  exampleDialog: '',
  tags: [],
  lorebookId: null,
  creator: '',
  createdAt: 0,
  updatedAt: 0,
  alternateGreetings: [],
}

describe('ChatHeader', () => {
  beforeEach(() => {
    useChatStore.setState({ sessions: [], currentSessionId: null })
    useCharacterStore.setState({ characters: [character], currentCharacter: character })
    usePersonaStore.setState({ personas: [], loaded: true })
    useSettingsStore.setState({
      settings: getDefaultSettings(),
      credentials: {},
      loaded: true,
      _saveTimer: null,
    })
  })

  it('右上角直接提供快捷设置入口，不再使用更多菜单', () => {
    const onShowQuickSettings = vi.fn()
    render(
      <MemoryRouter>
        <ChatHeader
          currentCharacter={character}
          isStreaming={false}
          totalChars={9000}
          showQuickSettings={false}
          onShowQuickSettings={onShowQuickSettings}
          onCreateSession={vi.fn()}
        />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: '快捷设置' }))

    expect(onShowQuickSettings).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: '更多操作' })).toBeNull()
  })
})
