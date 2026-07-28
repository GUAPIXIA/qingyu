import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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
})
