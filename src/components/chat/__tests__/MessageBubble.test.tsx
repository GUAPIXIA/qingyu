import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { MessageBubble } from '../MessageBubble'
import { useChatStore } from '../../../store/useChatStore'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { usePersonaStore } from '../../../store/usePersonaStore'
import { getDefaultSettings } from '../../../../shared/defaults'
import type { Message, Character } from '../../../../shared/types'

// 辅助函数：创建测试消息
function createMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    sessionId: 's1',
    characterId: 'char-1',
    role: 'assistant',
    content: 'Hello world',
    images: [],
    isEditing: false,
    timestamp: 1700000000000,
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

function setupStores() {
  useSettingsStore.setState({
    settings: { ...getDefaultSettings(), userName: 'TestUser' },
    credentials: {},
    loaded: true,
    _saveTimer: null,
  })
  usePersonaStore.setState({ personas: [], loaded: true })
  useChatStore.setState({
    messages: [],
    sessions: [],
    currentSessionId: 's1',
    isStreaming: false,
    streamingContent: '',
    error: null,
    activePresetId: null,
    activeLorebookIds: [],
    translatingMessages: {},
    showTranslationIds: new Set(),
  })
}

describe('MessageBubble', () => {
  beforeEach(() => {
    setupStores()
    vi.clearAllMocks()
    // clipboard mock
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    })
  })

  describe('基础渲染', () => {
    it('渲染角色消息内容', () => {
      const { getByText } = render(
        <MessageBubble message={createMessage({ content: '你好，世界' })} character={createCharacter()} isLast={false} />
      )
      expect(getByText('你好，世界')).toBeTruthy()
    })

    it('渲染角色显示名', () => {
      const { getByText } = render(
        <MessageBubble message={createMessage()} character={createCharacter({ name: 'Alice' })} isLast={false} />
      )
      expect(getByText('Alice')).toBeTruthy()
    })

    it('用户消息使用用户侧气泡样式', () => {
      const { container } = render(
        <MessageBubble message={createMessage({ role: 'user', content: 'hi' })} character={createCharacter()} isLast={false} />
      )
      expect(container.querySelector('.bubble-user')).toBeTruthy()
    })

    it('系统消息不渲染对话正文', () => {
      const { queryByText } = render(
        <MessageBubble message={createMessage({ role: 'system', content: '生成结果' })} character={createCharacter()} isLast={false} />
      )
      // system 消息正文不显示（只显示图片）
      expect(queryByText('生成结果')).toBeNull()
    })

    it('空消息显示占位文本', () => {
      const { getByText } = render(
        <MessageBubble message={createMessage({ content: '' })} character={createCharacter()} isLast={false} />
      )
      expect(getByText('（空消息）')).toBeTruthy()
    })

    it('markdown 内容被渲染', () => {
      const { getByText } = render(
        <MessageBubble message={createMessage({ content: '**加粗**文本' })} character={createCharacter()} isLast={false} />
      )
      expect(getByText('加粗')).toBeTruthy()
    })
  })

  describe('引用回复（BUG-05 回归）', () => {
    it('显示被引用消息的内容摘要', () => {
      const replied = createMessage({ id: 'replied-1', role: 'user', content: '被引用的内容' })
      const { getByText } = render(
        <MessageBubble message={createMessage()} character={createCharacter()} isLast={false} repliedMessage={replied} />
      )
      expect(getByText('被引用的内容')).toBeTruthy()
    })

    it('被引用消息 content 为空时不崩溃（BUG-05）', () => {
      const replied = createMessage({ id: 'replied-1', role: 'user', content: '' })
      const { container } = render(
        <MessageBubble message={createMessage()} character={createCharacter()} isLast={false} repliedMessage={replied} />
      )
      expect(container).toBeTruthy()
    })

    it('长内容截断为 80 字符并显示省略号', () => {
      const longContent = 'x'.repeat(120)
      const replied = createMessage({ id: 'replied-1', role: 'user', content: longContent })
      const { container } = render(
        <MessageBubble message={createMessage()} character={createCharacter()} isLast={false} repliedMessage={replied} />
      )
      // 相邻文本节点被 React 合并，用容器文本断言
      expect(container.textContent).toContain('...')
      expect(container.textContent).toContain('x'.repeat(80))
    })
  })

  describe('内心想法（thought）折叠', () => {
    it('显示折叠按钮并可展开内容', () => {
      const msg = createMessage({ content: '<thought>内心独白</thought>正文内容' })
      const { getByText, queryByText } = render(
        <MessageBubble message={msg} character={createCharacter()} isLast={false} />
      )
      expect(getByText('💭 内心想法')).toBeTruthy()
      // 默认折叠：内容不可见
      expect(queryByText('内心独白')).toBeNull()
      // 展开
      fireEvent.click(getByText('💭 内心想法'))
      expect(getByText('内心独白')).toBeTruthy()
    })
  })

  describe('图片消息', () => {
    it('纯图片系统消息不渲染正文', () => {
      const msg = createMessage({
        role: 'system',
        content: '图片描述',
        images: ['data:image/png;base64,AAAA'],
      })
      const { queryByText } = render(
        <MessageBubble message={msg} character={createCharacter()} isLast={false} />
      )
      expect(queryByText('图片描述')).toBeNull()
    })
  })

  describe('操作栏', () => {
    it('编辑按钮打开编辑态', () => {
      const { getByTitle, getByText } = render(
        <MessageBubble message={createMessage()} character={createCharacter()} isLast={false} />
      )
      fireEvent.click(getByTitle('编辑'))
      expect(getByText('保存')).toBeTruthy()
    })

    it('复制按钮调用 clipboard API（BUG-31）', async () => {
      const msg = createMessage({ content: '要复制的内容' })
      const { getByTitle } = render(
        <MessageBubble message={msg} character={createCharacter()} isLast={false} />
      )
      fireEvent.click(getByTitle('复制'))
      await waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith('要复制的内容')
      })
    })

    it('删除按钮调用 store.deleteMessage', () => {
      const deleteMessage = vi.fn().mockResolvedValue(undefined)
      useChatStore.setState({ deleteMessage } as any)
      const { getByTitle } = render(
        <MessageBubble message={createMessage()} character={createCharacter()} isLast={false} />
      )
      fireEvent.click(getByTitle('删除'))
      expect(deleteMessage).toHaveBeenCalledWith('msg-1', expect.anything())
    })

    it('流式时隐藏操作栏', () => {
      useChatStore.setState({ isStreaming: true } as any)
      const { queryByTitle } = render(
        <MessageBubble message={createMessage()} character={createCharacter()} isLast={true} />
      )
      expect(queryByTitle('编辑')).toBeNull()
      expect(queryByTitle('删除')).toBeNull()
    })
  })

  describe('Swipe 候选', () => {
    it('多条候选时显示切换指示器', () => {
      const msg = createMessage({
        swipes: ['候选1', '候选2'],
        swipeIndex: 0,
      })
      const { getByText } = render(
        <MessageBubble message={msg} character={createCharacter()} isLast={false} />
      )
      expect(getByText('1/2')).toBeTruthy()
    })

    it('单条候选不显示指示器', () => {
      const msg = createMessage({ content: '仅一条' })
      const { queryByText } = render(
        <MessageBubble message={msg} character={createCharacter()} isLast={false} />
      )
      expect(queryByText('1/1')).toBeNull()
    })
  })

  describe('翻译状态', () => {
    it('翻译中显示加载指示', () => {
      useChatStore.setState({
        translatingMessages: { 'msg-1': { status: 'translating', content: '' } },
      } as any)
      const { getByText } = render(
        <MessageBubble message={createMessage()} character={createCharacter()} isLast={false} />
      )
      expect(getByText('翻译中...')).toBeTruthy()
    })

    it('翻译失败显示错误信息', () => {
      useChatStore.setState({
        translatingMessages: { 'msg-1': { status: 'error', content: '', errorMsg: '网络错误' } },
        showTranslationIds: new Set(['msg-1']),
      } as any)
      const { getByText } = render(
        <MessageBubble message={createMessage()} character={createCharacter()} isLast={false} />
      )
      expect(getByText(/翻译失败/)).toBeTruthy()
    })
  })
})
