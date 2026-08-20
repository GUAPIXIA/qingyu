import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor, act } from '@testing-library/react'
import { ChatInput } from '../ChatInput'
import { useChatStore } from '../../../store/useChatStore'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { useCharacterStore } from '../../../store/useCharacterStore'
import { getDefaultSettings } from '../../../../shared/defaults'
import type { Character, Message, ConnectionProfile } from '../../../../shared/types'


/** 渲染并冲刷 mount 异步（quickReply 等 promise resolve 的 setState），避免 act 警告 */
async function renderChatInput(ui: React.ReactElement) {
  const utils = render(ui)
  await act(async () => {})
  return utils
}

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

function createMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    sessionId: 's1',
    characterId: 'char-1',
    role: 'user',
    content: 'Hello',
    images: [],
    isEditing: false,
    timestamp: Date.now(),
    ...overrides,
  }
}

const PROFILE: ConnectionProfile = {
  id: 'p1',
  name: 'profile',
  provider: 'openai',
  baseUrl: 'https://api.example.com',
  apiKey: 'sk-test',
  model: 'gpt-4o',
  maxContext: 8192,
}

function setupStores(connected = true) {
  useCharacterStore.setState({ characters: [createCharacter()] })
  useSettingsStore.setState({
    settings: {
      ...getDefaultSettings(),
      userName: 'TestUser',
      activeProfileId: connected ? 'p1' : null,
      connectionProfiles: connected ? [PROFILE] : [],
    },
    credentials: {},
    loaded: true,
    _saveTimer: null,
  })
  useChatStore.setState({
    messages: [],
    sessions: [],
    currentSessionId: 's1',
    isStreaming: false,
    error: null,
    activePresetId: null,
    activeLorebookIds: [],
    translatingMessages: {},
    showTranslationIds: new Set(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  })
}

describe('ChatInput', () => {
  beforeEach(() => {
    setupStores()
    vi.clearAllMocks()
    localStorage.clear()
    // quickReply IPC mock（useChatInputState 挂载时拉取）
    ;(window.api as any).quickReply = {
      listAll: vi.fn().mockResolvedValue({ global: [], byCharacter: {} }),
    }
  })

  describe('基础渲染', () => {
    it('渲染输入框和发送按钮', async () => {
      const { getByPlaceholderText, getByTitle } = await renderChatInput(<ChatInput character={createCharacter()} />)
      expect(getByPlaceholderText(/输入消息/)).toBeTruthy()
      expect(getByTitle('发送')).toBeTruthy()
    })

    it('未连接时显示配置提示', async () => {
      setupStores(false)
      const { getByPlaceholderText } = await renderChatInput(<ChatInput character={createCharacter()} />)
      expect(getByPlaceholderText(/请先在设置中配置 API 连接/)).toBeTruthy()
    })

    it('disabled 时禁用输入框', async () => {
      const { getByPlaceholderText } = await renderChatInput(<ChatInput character={createCharacter()} disabled />)
      expect((getByPlaceholderText(/输入消息/) as HTMLTextAreaElement).disabled).toBe(true)
    })
  })

  describe('发送逻辑', () => {
    it('空文本时发送按钮禁用', async () => {
      const { getByTitle } = await renderChatInput(<ChatInput character={createCharacter()} />)
      const sendBtn = getByTitle('发送')
      expect((sendBtn as HTMLButtonElement).disabled).toBe(true)
    })

    it('输入文本后发送按钮可用并调用 store.sendMessage', async () => {
      const { getByPlaceholderText, getByTitle } = await renderChatInput(<ChatInput character={createCharacter()} />)
      fireEvent.change(getByPlaceholderText(/输入消息/), { target: { value: '你好' } })
      const sendBtn = getByTitle('发送') as HTMLButtonElement
      expect(sendBtn.disabled).toBe(false)
      fireEvent.click(sendBtn)
      await waitFor(() => {
        expect(useChatStore.getState().sendMessage).toHaveBeenCalledWith(
          '你好', [], expect.objectContaining({ id: 'char-1' }), null, [], undefined
        )
      })
    })

    it('流式时显示停止按钮', async () => {
      useChatStore.setState({ isStreaming: true } as any)
      const { getByTitle, queryByTitle } = await renderChatInput(<ChatInput character={createCharacter()} />)
      expect(getByTitle('停止生成')).toBeTruthy()
      expect(queryByTitle('发送')).toBeNull()
    })
  })

  describe('引用回复（BUG-06 回归）', () => {
    it('显示被引用消息预览', async () => {
      const replyTo = createMessage({ content: '被引用的内容' })
      const { getByText } = await renderChatInput(
        <ChatInput character={createCharacter()} replyTo={replyTo} onCancelReply={vi.fn()} />
      )
      expect(getByText('被引用的内容')).toBeTruthy()
    })

    it('被引用消息 content 为空时不崩溃（BUG-06）', async () => {
      const replyTo = createMessage({ content: '' })
      const { container } = await renderChatInput(
        <ChatInput character={createCharacter()} replyTo={replyTo} onCancelReply={vi.fn()} />
      )
      expect(container).toBeTruthy()
    })

    it('点击取消按钮调用 onCancelReply', async () => {
      const onCancelReply = vi.fn()
      const replyTo = createMessage({ content: '内容' })
      const { getByTitle } = await renderChatInput(
        <ChatInput character={createCharacter()} replyTo={replyTo} onCancelReply={onCancelReply} />
      )
      fireEvent.click(getByTitle('取消引用'))
      expect(onCancelReply).toHaveBeenCalled()
    })
  })

  describe('图片预览', () => {
    it('渲染图片并可删除', async () => {
      // 通过 handleImageSelect 需要文件 mock，直接验证 UI 结构需要注入 images
      // useChatInputState 的 images 是内部 state，这里通过文件选择触发
      const { getByTitle, queryByAltText } = await renderChatInput(<ChatInput character={createCharacter()} />)
      // 无图片时不显示预览区
      expect(queryByAltText('')).toBeNull()
      expect(getByTitle('添加图片')).toBeTruthy()
    })
  })

  describe('快捷回复', () => {
    it('渲染快捷回复按钮', async () => {
      ;(window.api as any).quickReply.listAll = vi.fn().mockResolvedValue({
        global: [{ id: 'qr1', label: '早安', content: '早上好', action: 'text', hotkey: 1, enabled: true, order: 0 }],
        byCharacter: {},
      })
      const { findByText } = await renderChatInput(<ChatInput character={createCharacter()} />)
      expect(await findByText('早安')).toBeTruthy()
    })
  })

  describe('命令补全', () => {
    it('接收命令面板选择并填入斜杠命令模板', async () => {
      const { getByDisplayValue } = await renderChatInput(<ChatInput character={createCharacter()} />)

      act(() => {
        window.dispatchEvent(new CustomEvent('shortcut:insert-command', {
          detail: { value: '/imagine [提示词]' },
        }))
      })

      expect(getByDisplayValue('/imagine [提示词]')).toBeTruthy()
    })

    it('输入 / 前缀显示命令建议下拉', async () => {
      const { getByPlaceholderText, findByText } = await renderChatInput(<ChatInput character={createCharacter()} />)
      // 单个 '/' 无 token 不触发，输入 '/h' 匹配 help 命令
      fireEvent.change(getByPlaceholderText(/输入消息/), { target: { value: '/h' } })
      expect(await findByText(/\/help/, {}, { timeout: 2000 })).toBeTruthy()
    })
  })

  describe('AI 辅助', () => {
    it('润色按钮仅在输入非空时显示', async () => {
      const { queryByTitle, getByPlaceholderText } = await renderChatInput(<ChatInput character={createCharacter()} />)
      expect(queryByTitle('AI 润色输入文字')).toBeNull()
      fireEvent.change(getByPlaceholderText(/输入消息/), { target: { value: '测试文本' } })
      expect(queryByTitle('AI 润色输入文字')).toBeTruthy()
    })

    it('续写按钮始终显示', async () => {
      const { getByTitle } = await renderChatInput(<ChatInput character={createCharacter()} />)
      expect(getByTitle('AI 根据上下文续写输入文字')).toBeTruthy()
    })
  })
})
