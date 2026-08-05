import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useChatInputState } from '../useChatInputState'
import { useChatStore } from '../../../store/useChatStore'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { useCharacterStore } from '../../../store/useCharacterStore'
import { getDefaultSettings } from '../../../../shared/defaults'
import type { Character, Message, ConnectionProfile } from '../../../../shared/types'

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

const PROFILE: ConnectionProfile = {
  id: 'p1',
  name: 'profile',
  provider: 'openai',
  baseUrl: 'https://api.example.com',
  apiKey: 'sk-test',
  model: 'gpt-4o',
  maxContext: 8192,
}

function setupStores() {
  useCharacterStore.setState({ characters: [createCharacter()] })
  useSettingsStore.setState({
    settings: {
      ...getDefaultSettings(),
      userName: 'TestUser',
      activeProfileId: 'p1',
      connectionProfiles: [PROFILE],
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
    streamingContent: '',
    error: null,
    activePresetId: null,
    activeLorebookIds: [],
    translatingMessages: {},
    showTranslationIds: new Set(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  })
}

describe('useChatInputState', () => {
  beforeEach(() => {
    setupStores()
    vi.clearAllMocks()
    localStorage.clear()
    ;(window.api as any).quickReply = {
      listAll: vi.fn().mockResolvedValue({ global: [], byCharacter: {} }),
    }
  })

  it('初始状态：文本为空、无图片', async () => {
    const { result } = renderHook(() => useChatInputState(createCharacter()))
    await act(async () => {}) // 冲刷挂载异步（quickReply）
    expect(result.current.text).toBe('')
    expect(result.current.images).toEqual([])
    expect(result.current.isAiProcessing).toBe(false)
  })

  it('恢复草稿到输入框', async () => {
    localStorage.setItem('chat-draft:char-1:s1', '草稿内容')
    const { result } = renderHook(() => useChatInputState(createCharacter()))
    await act(async () => {}) // 冲刷挂载异步（quickReply）
    expect(result.current.text).toBe('草稿内容')
  })

  it('handleSend 空文本不发送', async () => {
    const { result } = renderHook(() => useChatInputState(createCharacter()))
    await act(async () => {}) // 冲刷挂载异步（quickReply）
    await act(async () => {
      await result.current.handleSend()
    })
    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled()
  })

  it('handleSend 发送消息并清空输入', async () => {
    const { result } = renderHook(() => useChatInputState(createCharacter()))
    await act(async () => {}) // 冲刷挂载异步（quickReply）
    act(() => {
      result.current.setText('你好世界')
    })
    await act(async () => {
      await result.current.handleSend()
    })
    expect(useChatStore.getState().sendMessage).toHaveBeenCalledWith(
      '你好世界', [], expect.objectContaining({ id: 'char-1' }), null, [], undefined
    )
    expect(result.current.text).toBe('')
  })

  it('handleSend 传递引用回复 ID 并调用 onCancelReply', async () => {
    const onCancelReply = vi.fn()
    const replyTo: Message = {
      id: 'reply-1',
      sessionId: 's1',
      characterId: 'char-1',
      role: 'user',
      content: '被引用',
      images: [],
      isEditing: false,
      timestamp: Date.now(),
    }
    const { result } = renderHook(() => useChatInputState(createCharacter(), replyTo, onCancelReply))
    act(() => {
      result.current.setText('回复内容')
    })
    await act(async () => {
      await result.current.handleSend()
    })
    expect(useChatStore.getState().sendMessage).toHaveBeenCalledWith(
      '回复内容', [], expect.anything(), null, [], 'reply-1'
    )
    expect(onCancelReply).toHaveBeenCalled()
  })

  it('/ 开头的内置命令被执行而非发送', async () => {
    const { result } = renderHook(() => useChatInputState(createCharacter()))
    await act(async () => {}) // 冲刷挂载异步（quickReply）
    act(() => {
      result.current.setText('/clear')
    })
    await act(async () => {
      await result.current.handleSend()
    })
    // 命令执行不应走 sendMessage
    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled()
    // 命令执行后输入框被清空
    expect(result.current.text).toBe('')
  })

  it('流式中 handleSend 不发送', async () => {
    useChatStore.setState({ isStreaming: true } as any)
    const { result } = renderHook(() => useChatInputState(createCharacter()))
    await act(async () => {}) // 冲刷挂载异步（quickReply）
    act(() => {
      result.current.setText('测试')
    })
    await act(async () => {
      await result.current.handleSend()
    })
    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled()
  })
})
