import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

  it('在身份切换右侧显示并持久化当前会话的叙事模式', async () => {
    useChatStore.setState({
      sessions: [{
        id: 'session-1', characterId: character.id, title: '测试会话', createdAt: 0, updatedAt: 0,
        memoryEnabled: false, memoryMode: 'manual', autoMemoryInterval: 10, memory: '', memoryUpdatedAt: 0,
        messageCount: 0, lastMessage: '', narrativeMode: 'immersive',
      }],
      currentSessionId: 'session-1',
    })
    vi.mocked(window.api.chat.updateSession).mockResolvedValueOnce({} as never)

    render(
      <MemoryRouter>
        <ChatHeader
          currentCharacter={character}
          isStreaming={false}
          totalChars={0}
          showQuickSettings={false}
          onShowQuickSettings={vi.fn()}
          onCreateSession={vi.fn()}
        />
      </MemoryRouter>,
    )

    const personaSwitcher = screen.getByTitle('切换身份')
    const narrativeSwitcher = screen.getByRole('radiogroup', { name: '叙事模式' })
    expect(personaSwitcher.compareDocumentPosition(narrativeSwitcher) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('radio', { name: '代入式角色扮演' }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByRole('radio', { name: '全局叙事' }))

    await waitFor(() => {
      expect(window.api.chat.updateSession).toHaveBeenCalledWith(character.id, 'session-1', { narrativeMode: 'omniscient' })
      expect(useChatStore.getState().sessions[0].narrativeMode).toBe('omniscient')
    })
    expect(screen.getByRole('status').textContent).toContain('已切换为全局叙事')
  })

  it('顶部工具栏在深色背景使用清晰的次要文字色和不透明控件底色', () => {
    useChatStore.setState({
      sessions: [{
        id: 'session-1', characterId: character.id, title: '新对话 3', createdAt: 0, updatedAt: 0,
        memoryEnabled: false, memoryMode: 'manual', autoMemoryInterval: 10, memory: '', memoryUpdatedAt: 0,
        messageCount: 0, lastMessage: '', narrativeMode: 'immersive',
      }],
      currentSessionId: 'session-1',
    })

    render(
      <MemoryRouter>
        <ChatHeader
          currentCharacter={character}
          isStreaming={false}
          totalChars={0}
          showQuickSettings={false}
          onShowQuickSettings={vi.fn()}
          onCreateSession={vi.fn()}
        />
      </MemoryRouter>,
    )

    expect(screen.getByRole('radiogroup', { name: '叙事模式' }).className).toContain('bg-tavern-bg-card')
    expect(screen.getByRole('radio', { name: '全局叙事' }).className).toContain('text-tavern-text-soft')
    expect(screen.getByTitle('切换对话').className).toContain('text-tavern-text-soft')
    expect(screen.getByTitle('新建会话').className).toContain('text-tavern-text-soft')
    expect(screen.getByRole('button', { name: '长记忆设置' }).className).toContain('text-tavern-text-soft')
  })

  it('全局叙事下身份切换器显示旁白标识而非所选身份', () => {
    useChatStore.setState({
      sessions: [{
        id: 'session-1', characterId: character.id, title: '测试会话', createdAt: 0, updatedAt: 0,
        memoryEnabled: false, memoryMode: 'manual', autoMemoryInterval: 10, memory: '', memoryUpdatedAt: 0,
        messageCount: 0, lastMessage: '', narrativeMode: 'omniscient',
      }],
      currentSessionId: 'session-1',
    })

    render(
      <MemoryRouter>
        <ChatHeader
          currentCharacter={character}
          isStreaming={false}
          totalChars={0}
          showQuickSettings={false}
          onShowQuickSettings={vi.fn()}
          onCreateSession={vi.fn()}
        />
      </MemoryRouter>,
    )

    // 顶栏显示“旁白”与中性图标，不再显示身份头像/名称
    expect(screen.getByLabelText('旁白')).toBeTruthy()
    expect(screen.getByTitle('旁白（身份：未使用身份）').textContent).toContain('旁白')
  })
})
