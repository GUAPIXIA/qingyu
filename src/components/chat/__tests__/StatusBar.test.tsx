import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { StatusBar } from '../StatusBar'
import { useChatStore } from '../../../store/useChatStore'
import { useCharacterStore } from '../../../store/useCharacterStore'
import type { Message } from '../../../../shared/types'

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1', sessionId: 's1', characterId: 'c1', role: 'assistant',
    content: '她笑了笑。', images: [], isEditing: false, timestamp: 1,
    ...overrides,
  }
}

describe('StatusBar（对话页状态条）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('勾选的世界书不在对话页展示：只有激活世界书时整条不渲染', () => {
    useChatStore.setState({ activeLorebookIds: ['lb-1'] })
    useCharacterStore.setState({
      currentCharacter: { id: 'c1', name: 'Gloomy', lorebookId: 'lb-1' } as never,
    })
    vi.mocked(window.api.lorebook.list).mockResolvedValue([
      { id: 'lb-1', name: 'Gloomy的世界书' },
    ] as never)

    const { container, queryByText } = render(<StatusBar messages={[makeMessage()]} />)

    expect(queryByText('Gloomy的世界书')).toBeNull()
    expect(container.firstChild).toBeNull()
    // 不再为展示世界书而拉取全量列表
    expect(window.api.lorebook.list).not.toHaveBeenCalled()
  })

  it('回复中解析出的状态项仍然展示', () => {
    useChatStore.setState({ activeLorebookIds: [] })
    const { getByText, queryByText } = render(
      <StatusBar messages={[makeMessage({ content: '她点头。[Status: 好感=62]' })]} />,
    )

    expect(getByText('62')).toBeTruthy()
    expect(getByText('好感:')).toBeTruthy()
    expect(queryByText('世界书')).toBeNull()
  })

  it('没有状态项时整条不渲染（不再保留空条占位）', () => {
    useChatStore.setState({ activeLorebookIds: ['lb-1'] })
    const { container } = render(<StatusBar messages={[makeMessage()]} />)
    expect(container.firstChild).toBeNull()
  })
})
