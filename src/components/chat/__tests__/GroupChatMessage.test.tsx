import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { GroupChatMessage } from '../GroupChatMessage'
import { useCharacterStore } from '../../../store/useCharacterStore'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { usePersonaStore } from '../../../store/usePersonaStore'
import { getDefaultSettings } from '../../../../shared/defaults'
import type { GroupMessage, Character } from '../../../../shared/types'

// 辅助函数：创建测试消息
function createMessage(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    id: 'msg-1',
    groupId: 'g1',
    characterId: 'char-1',
    content: 'Hello world',
    images: [],
    timestamp: Date.now(),
    round: 1,
    ...overrides,
  }
}

// 辅助函数：创建测试角色
function createCharacter(overrides: Partial<Character> = {}): Character {
  return {
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
    ...overrides,
  }
}

describe('GroupChatMessage', () => {
  beforeEach(() => {
    // 重置 stores
    useCharacterStore.setState({ characters: [] })
    useSettingsStore.setState({
      settings: { ...getDefaultSettings(), userName: 'TestUser' },
      credentials: {},
      loaded: true,
      _saveTimer: null,
    })
    usePersonaStore.setState({
      personas: [],
      loaded: true,
    })
    vi.clearAllMocks()
  })

  it('全局叙事的对方消息仍显示实际成员身份', () => {
    useCharacterStore.setState({ characters: [createCharacter()] })
    const { container, getByText, queryByText } = render(<GroupChatMessage message={createMessage({ narrativeMode: 'omniscient' })} />)
    expect(getByText('Alice')).toBeTruthy()
    expect(queryByText('旁白')).toBeNull()
    expect(container.querySelector('.bubble-narrator')).toBeNull()
  })

  it('全局叙事的我方消息显示右侧旁白身份和中性气泡', () => {
    const { container, getByText, queryByText } = render(
      <GroupChatMessage message={createMessage({ characterId: '__user__', narrativeMode: 'omniscient' })} />,
    )
    expect(getByText('旁白')).toBeTruthy()
    expect(queryByText('TestUser')).toBeNull()
    expect(container.querySelector('.bubble-narrator')).toBeTruthy()
    expect(container.querySelector('.bubble-user')).toBeNull()
    expect(container.querySelector('.mx-auto.flex')?.classList.contains('flex-row-reverse')).toBe(true)
  })

  it('显式 speakerKind 覆盖旧版模式推导但不改变消息方向', () => {
    const { container, queryByText } = render(
      <GroupChatMessage message={createMessage({ characterId: '__user__', narrativeMode: 'omniscient', speakerKind: 'persona' })} />,
    )
    expect(queryByText('旁白')).toBeNull()
    expect(container.querySelector('.bubble-user')).toBeTruthy()
    expect(container.querySelector('.mx-auto.flex')?.classList.contains('flex-row-reverse')).toBe(true)
  })

  describe('user message rendering', () => {
    it('renders user message with correct content', () => {
      const msg = createMessage({ characterId: '__user__', content: 'Hello from user' })
      const { container } = render(<GroupChatMessage message={msg} />)
      expect(container.textContent).toContain('Hello from user')
      expect(container.textContent).toContain('TestUser')
    })

    it('renders user avatar fallback with first letter of userName', () => {
      const msg = createMessage({ characterId: '__user__', content: 'Test' })
      const { container } = render(<GroupChatMessage message={msg} />)
      // 用户名首字母
      expect(container.textContent).toContain('T')
    })

    it('用户对白匹配使用与单聊相同的 bubble-user 样式入口', () => {
      const msg = createMessage({ characterId: '__user__', content: '"匹配出的对白"' })
      const { container } = render(<GroupChatMessage message={msg} />)

      expect(container.querySelector('.dialogue-inline')).toBeTruthy()
      expect(container.querySelector('.msg-bubble')?.classList.contains('bubble-user')).toBe(true)
    })

    it('用户短消息保持紧凑，消息宽度设置仅控制最大宽度', () => {
      useSettingsStore.setState((state) => ({
        settings: { ...state.settings, messageWidth: 480 },
      }))
      const msg = createMessage({ characterId: '__user__', content: '短消息' })
      const { container } = render(<GroupChatMessage message={msg} />)

      expect(container.querySelector('.bubble-user')?.classList.contains('w-fit')).toBe(true)
      expect(container.querySelector('.bubble-user')?.classList.contains('w-full')).toBe(false)
      expect((container.querySelector('.mx-auto.flex') as HTMLElement)?.style.maxWidth).toBe('480px')
    })
  })

  describe('AI character message rendering', () => {
    it('renders character message with character name', () => {
      const char = createCharacter({ id: 'char-1', name: 'Alice' })
      useCharacterStore.setState({ characters: [char] })
      const msg = createMessage({ characterId: 'char-1', content: 'Hi from Alice' })
      const { container } = render(<GroupChatMessage message={msg} memberIndex={0} />)
      expect(container.textContent).toContain('Alice')
      expect(container.textContent).toContain('Hi from Alice')
    })

    it('renders character avatar fallback with first letter of name', () => {
      const char = createCharacter({ id: 'char-1', name: 'Bob' })
      useCharacterStore.setState({ characters: [char] })
      const msg = createMessage({ characterId: 'char-1', content: 'Hello' })
      const { container } = render(<GroupChatMessage message={msg} memberIndex={0} />)
      expect(container.textContent).toContain('B')
    })

    it('shows "未知" when character is not found', () => {
      const msg = createMessage({ characterId: 'non-existent', content: 'Hello' })
      const { container } = render(<GroupChatMessage message={msg} memberIndex={0} />)
      expect(container.textContent).toContain('未知')
    })

    it('角色气泡表面使用与单聊相同的中性卡片样式', () => {
      const char = createCharacter({ id: 'char-1', name: 'Alice' })
      useCharacterStore.setState({ characters: [char] })
      const { container } = render(<GroupChatMessage message={createMessage()} memberIndex={0} />)
      const bubble = container.querySelector('.msg-bubble')

      expect(bubble?.classList.contains('bg-tavern-bg-card')).toBe(true)
      expect(bubble?.classList.contains('border-tavern-border')).toBe(true)
      expect(bubble?.classList.contains('text-slate-900')).toBe(true)
      expect(bubble?.classList.contains('border-l-[3px]')).toBe(false)
    })

    it('可展开显示模型思考内容且正文保持可见', () => {
      const char = createCharacter({ id: 'char-1', name: 'Alice' })
      useCharacterStore.setState({ characters: [char] })
      const msg = createMessage({ content: '<thought>先检查前文线索</thought>\n这是最终回复' })
      const { container } = render(<GroupChatMessage message={msg} memberIndex={0} />)

      expect(container.textContent).toContain('这是最终回复')
      expect(container.textContent).toContain('💭 内心想法')
      expect(container.textContent).not.toContain('先检查前文线索')
      fireEvent.click(container.querySelector('[aria-label="展开思考内容"]') as HTMLButtonElement)
      expect(container.textContent).toContain('先检查前文线索')
    })

    it('孤立的 thought 结束标签不会把思考内容泄漏到正文', () => {
      const char = createCharacter({ id: 'char-1', name: 'Alice' })
      useCharacterStore.setState({ characters: [char] })
      const msg = createMessage({ content: '先分析系统提示和上下文\n</thought>\n这是最终回复' })
      const { container } = render(<GroupChatMessage message={msg} memberIndex={0} />)

      expect(container.textContent).toContain('这是最终回复')
      expect(container.textContent).not.toContain('先分析系统提示和上下文')
      expect(container.textContent).not.toContain('</thought>')

      fireEvent.click(container.querySelector('[aria-label="展开思考内容"]') as HTMLButtonElement)
      expect(container.textContent).toContain('先分析系统提示和上下文')
    })

    it('遵循自动展开思考内容设置', () => {
      const char = createCharacter({ id: 'char-1', name: 'Alice' })
      useCharacterStore.setState({ characters: [char] })
      useSettingsStore.setState((state) => ({
        settings: { ...state.settings, autoExpandThought: true },
      }))

      const msg = createMessage({ content: '<thought>自动显示这段思考</thought>\n正文' })
      const { container } = render(<GroupChatMessage message={msg} memberIndex={0} />)

      expect(container.textContent).toContain('自动显示这段思考')
      expect(container.querySelector('[aria-label="收起思考内容"]')).toBeTruthy()
    })

    it('只有内心想法而没有正文时仍可收起', () => {
      const char = createCharacter({ id: 'char-1', name: 'Alice' })
      useCharacterStore.setState({ characters: [char] })
      useSettingsStore.setState((state) => ({
        settings: { ...state.settings, autoExpandThought: true },
      }))

      const msg = createMessage({ content: '<thought>尚未生成正文的内心想法</thought>' })
      const { container } = render(<GroupChatMessage message={msg} memberIndex={0} />)

      const collapseButton = container.querySelector('[aria-label="收起思考内容"]') as HTMLButtonElement
      expect(collapseButton).toBeTruthy()
      expect(container.textContent).toContain('尚未生成正文的内心想法')

      fireEvent.click(collapseButton)

      expect(container.querySelector('[aria-label="展开思考内容"]')).toBeTruthy()
      expect(container.textContent).not.toContain('尚未生成正文的内心想法')
    })
  })

  describe('streaming indicator', () => {
    it('shows "生成中..." indicator when isStreamingMessage is true', () => {
      const msg = createMessage({ characterId: 'char-1', content: '' })
      const { container } = render(
        <GroupChatMessage message={msg} memberIndex={0} isStreamingMessage={true} />
      )
      expect(container.textContent).toContain('生成中')
    })

    it('does not show streaming indicator when isStreamingMessage is false', () => {
      const msg = createMessage({ characterId: 'char-1', content: 'Done' })
      const { container } = render(
        <GroupChatMessage message={msg} memberIndex={0} isStreamingMessage={false} />
      )
      expect(container.textContent).not.toContain('生成中')
    })
  })

  describe('reply quote block', () => {
    it('shows reply quote block when repliedMessage is provided', () => {
      const repliedMsg = createMessage({
        id: 'msg-0',
        characterId: 'char-1',
        content: 'Original message text',
      })
      const char = createCharacter({ id: 'char-1', name: 'Alice' })
      useCharacterStore.setState({ characters: [char] })
      const msg = createMessage({ content: 'Reply text', replyToId: 'msg-0' })

      const { container } = render(
        <GroupChatMessage message={msg} memberIndex={0} repliedMessage={repliedMsg} />
      )
      expect(container.textContent).toContain('Alice')
      expect(container.textContent).toContain('Original message text')
    })

    it('shows "用户" in quote when replied message is from user', () => {
      const repliedMsg = createMessage({
        id: 'msg-0',
        characterId: '__user__',
        content: 'User said something',
      })
      const msg = createMessage({ content: 'Reply', replyToId: 'msg-0' })

      const { container } = render(
        <GroupChatMessage message={msg} repliedMessage={repliedMsg} />
      )
      expect(container.textContent).toContain('用户')
      expect(container.textContent).toContain('User said something')
    })

    it('truncates long replied message to 50 chars', () => {
      const longContent = 'A'.repeat(100)
      const repliedMsg = createMessage({
        id: 'msg-0',
        characterId: '__user__',
        content: longContent,
      })
      const msg = createMessage({ content: 'Reply', replyToId: 'msg-0' })

      const { container } = render(
        <GroupChatMessage message={msg} repliedMessage={repliedMsg} />
      )
      // 原文 100 字符应被截断
      const text = container.textContent || ''
      expect(text).toContain('...')
      expect(text).not.toContain('A'.repeat(100))
    })

    it('does not show quote block when repliedMessage is not provided', () => {
      const msg = createMessage({ content: 'No reply' })
      const { container } = render(<GroupChatMessage message={msg} />)
      // 没有 reply-quote 元素
      const quoteElements = container.querySelectorAll('.reply-quote')
      expect(quoteElements).toHaveLength(0)
    })
  })

  describe('send status icon', () => {
    it('shows Check icon for user messages with status "sent"', () => {
      const msg = createMessage({
        characterId: '__user__',
        content: 'Sent message',
        status: 'sent',
      })
      const { container } = render(<GroupChatMessage message={msg} />)
      // Check 图标存在（svg 元素）
      const svgElements = container.querySelectorAll('svg')
      expect(svgElements.length).toBeGreaterThan(0)
    })

    it('shows Loader2 spinning icon for user messages with status "sending"', () => {
      const msg = createMessage({
        characterId: '__user__',
        content: 'Sending message',
        status: 'sending',
      })
      const { container } = render(<GroupChatMessage message={msg} />)
      // Loader2 有 animate-spin class
      const spinning = container.querySelector('.animate-spin')
      expect(spinning).toBeTruthy()
    })

    it('shows Check icon for user messages with no status (defaults to sent)', () => {
      const msg = createMessage({
        characterId: '__user__',
        content: 'Default status',
      })
      const { container } = render(<GroupChatMessage message={msg} />)
      // 不应有 spinning 图标
      const spinning = container.querySelector('.animate-spin')
      expect(spinning).toBeNull()
    })
  })

  describe('@mention highlight', () => {
    it('renders mention-highlight span when message has mentionedCharacterIds', () => {
      const char = createCharacter({ id: 'char-2', name: 'Bob' })
      useCharacterStore.setState({ characters: [char] })
      const msg = createMessage({
        characterId: '__user__',
        content: 'Hello @Bob how are you',
        mentionedCharacterIds: ['char-2'],
      })
      const { container } = render(<GroupChatMessage message={msg} />)
      const highlightElements = container.querySelectorAll('.mention-highlight')
      expect(highlightElements.length).toBeGreaterThan(0)
      expect(highlightElements[0].textContent).toContain('@Bob')
    })

    it('does not render mention-highlight when no mentionedCharacterIds', () => {
      const msg = createMessage({
        characterId: '__user__',
        content: 'Hello world',
      })
      const { container } = render(<GroupChatMessage message={msg} />)
      const highlightElements = container.querySelectorAll('.mention-highlight')
      expect(highlightElements).toHaveLength(0)
    })

    it('S7：语义分块（blocks）路径同样高亮 @提及', () => {
      const char = createCharacter({ id: 'char-2', name: 'Bob' })
      useCharacterStore.setState({ characters: [char] })
      const msg = createMessage({
        characterId: 'char-1',
        content: '“@Bob 你来了。”\n\n她朝门口看了一眼。',
        contentRenderMode: 'blocks',
        mentionedCharacterIds: ['char-2'],
      })
      const { container } = render(<GroupChatMessage message={msg} />)
      const highlightElements = container.querySelectorAll('.mention-highlight')
      expect(highlightElements).toHaveLength(1)
      expect(highlightElements[0].textContent).toBe('@Bob')
      // 正文其余部分完整保留
      expect(container.textContent).toContain('她朝门口看了一眼。')
    })

    it('S7：长名优先匹配，避免被更短的名字抢先', () => {
      const long = createCharacter({ id: 'char-3', name: '千夏' })
      const short = createCharacter({ id: 'char-4', name: '千' })
      useCharacterStore.setState({ characters: [long, short] })
      const msg = createMessage({
        characterId: 'char-1',
        content: '“@千夏 也一起。”',
        contentRenderMode: 'blocks',
        mentionedCharacterIds: ['char-4', 'char-3'],
      })
      const { container } = render(<GroupChatMessage message={msg} />)
      expect(container.querySelector('.mention-highlight')?.textContent).toBe('@千夏')
    })
  })

  describe('action buttons', () => {
    it('calls onReply when reply button is clicked', () => {
      const onReply = vi.fn()
      const msg = createMessage({ content: 'Test message' })
      const { container } = render(
        <GroupChatMessage message={msg} memberIndex={0} onReply={onReply} />
      )
      // 找到 title="引用回复" 的按钮
      const replyBtn = container.querySelector('[title="引用回复"]') as HTMLButtonElement
      expect(replyBtn).toBeTruthy()
      fireEvent.click(replyBtn)
      expect(onReply).toHaveBeenCalledTimes(1)
    })

    it('calls onDelete when delete button is clicked', () => {
      const onDelete = vi.fn()
      const msg = createMessage({ content: 'Test' })
      const { container } = render(
        <GroupChatMessage message={msg} memberIndex={0} onDelete={onDelete} />
      )
      const deleteBtn = container.querySelector('[title="删除"]') as HTMLButtonElement
      expect(deleteBtn).toBeTruthy()
      fireEvent.click(deleteBtn)
      expect(onDelete).toHaveBeenCalledTimes(1)
    })

    it('enters edit mode when edit button is clicked', () => {
      const onEdit = vi.fn()
      const msg = createMessage({ content: 'Test' })
      const { container } = render(
        <GroupChatMessage message={msg} memberIndex={0} onEdit={onEdit} />
      )
      const editBtn = container.querySelector('[title="编辑"]') as HTMLButtonElement
      expect(editBtn).toBeTruthy()
      fireEvent.click(editBtn)
      // 编辑按钮切换到编辑模式，显示文本框
      const textarea = container.querySelector('textarea')
      expect(textarea).toBeTruthy()
    })
  })

  describe('free message (hidden)', () => {
    it('renders null for __free__ characterId', () => {
      const msg = createMessage({ characterId: '__free__', content: 'Should not show' })
      const { container } = render(<GroupChatMessage message={msg} />)
      expect(container.textContent).not.toContain('Should not show')
    })
  })

  describe('下一步方向卡片', () => {
    const directions = [
      { id: 'safe', label: '追问封锁原因', content: '先不与守卫冲突，试着追问港口突然封锁的原因。', tendency: 'safe' as const },
      { id: 'explore', label: '寻找其他入口', content: '暂时离开正门，沿港口外围查看是否存在无人值守的通道。', tendency: 'explore' as const },
      { id: 'risky', label: '冒险直接闯关', content: '趁守卫注意力被分散时尝试突破封锁，承担立即暴露的风险。', tendency: 'risky' as const },
    ]

    beforeEach(() => {
      useCharacterStore.setState({ characters: [createCharacter()] })
    })

    it('开启且消息带方向时渲染卡片，点选回填群聊草稿', async () => {
      const { registerDraftBridge } = await import('../draftBridge')
      let draft = ''
      const setDraft = vi.fn((value: string) => { draft = value })
      registerDraftBridge('group', { getText: () => draft, setDraft })

      const { getByRole } = render(
        <GroupChatMessage message={createMessage({ dialogueDirections: directions })} isLast dialogueDirectionsEnabled />,
      )

      fireEvent.click(getByRole('button', { name: /寻找其他入口/ }))
      expect(setDraft).toHaveBeenCalledWith(directions[1].content)
      registerDraftBridge('group', null)
    })

    it('会话未开启方向时不渲染卡片', () => {
      const { queryByText } = render(
        <GroupChatMessage message={createMessage({ dialogueDirections: directions })} isLast dialogueDirectionsEnabled={false} />,
      )
      expect(queryByText('选择下一步方向')).toBeNull()
    })

    it('用户消息与流式消息不渲染卡片', () => {
      const { queryByText } = render(
        <GroupChatMessage
          message={createMessage({ characterId: '__user__', dialogueDirections: directions })}
          isLast
          dialogueDirectionsEnabled
        />,
      )
      expect(queryByText('选择下一步方向')).toBeNull()

      const streaming = render(
        <GroupChatMessage
          message={createMessage({ dialogueDirections: directions })}
          isLast
          isStreamingMessage
          dialogueDirectionsEnabled
        />,
      )
      expect(streaming.queryByText('选择下一步方向')).toBeNull()
    })

    it('仅最新一条显示换一批', () => {
      const last = render(
        <GroupChatMessage
          message={createMessage({ dialogueDirections: directions })}
          isLast
          dialogueDirectionsEnabled
          onRegenerateDirections={() => {}}
        />,
      )
      expect(last.getByRole('button', { name: /换一批/ })).toBeTruthy()
      last.unmount()
    })

    it('历史消息保留方向展示但不提供换一批', () => {
      const history = render(
        <GroupChatMessage
          message={createMessage({ id: 'msg-2', dialogueDirections: directions })}
          isLast={false}
          dialogueDirectionsEnabled
          onRegenerateDirections={() => {}}
        />,
      )
      expect(history.getByText('选择下一步方向')).toBeTruthy()
      expect(history.queryByRole('button', { name: /换一批/ })).toBeNull()
    })
  })
})
