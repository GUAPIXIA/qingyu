import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { getDefaultSettings } from '../../../../shared/defaults'
import type { Character } from '../../../../shared/types'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { CharacterCard } from '../CharacterCard'

const character: Character = {
  id: 'char-1', name: 'Alice', avatar: '', description: '', personality: '',
  scenario: '', firstMessage: '', exampleDialog: '', tags: [], lorebookId: null,
  creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [],
}

describe('CharacterCard', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      settings: getDefaultSettings(),
      credentials: {},
      loaded: true,
      _saveTimer: null,
    })
  })

  it('开始对话使用纯图标按钮，同时保留无障碍名称和点击行为', () => {
    const onChat = vi.fn()
    render(
      <CharacterCard
        character={character}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onChat={onChat}
      />,
    )

    const chatButton = screen.getByRole('button', { name: '开始对话' })
    expect(chatButton.textContent).toBe('')
    fireEvent.click(chatButton)
    expect(onChat).toHaveBeenCalledWith(character)
  })
})
