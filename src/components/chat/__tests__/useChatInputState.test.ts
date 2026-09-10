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
      '你好世界', [], expect.objectContaining({ id: 'char-1' }), null, [], undefined, 'manual'
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
      '回复内容', [], expect.anything(), null, [], 'reply-1', 'manual'
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

  function mockAiHelperResponses(responses: string[]) {
    let onChunk: ((data: { requestId: string; text: string }) => void) | undefined
    let onDone: ((requestId: string) => void) | undefined
    vi.mocked(window.api.ai.onChunk).mockImplementation((callback) => {
      onChunk = callback
      return vi.fn()
    })
    vi.mocked(window.api.ai.onDone).mockImplementation((callback) => {
      onDone = callback
      return vi.fn()
    })
    vi.mocked(window.api.ai.onError).mockImplementation(() => vi.fn())
    vi.mocked(window.api.ai.chat).mockImplementation(async (params) => {
      const response = responses.shift() ?? ''
      queueMicrotask(() => {
        onChunk?.({ requestId: params.requestId, text: response })
        onDone?.(params.requestId)
      })
    })
  }

  it('续写遇到英文分析时自动重试，只将中文标签正文写入输入框', async () => {
    mockAiHelperResponses([
      'We need continue the story. Need final only.',
      '<continuation>门外忽然传来急促的敲门声，走廊里的灯随之闪烁起来。</continuation>',
    ])
    const { result } = renderHook(() => useChatInputState(createCharacter()))
    act(() => result.current.setText('夜已经很深。'))

    await act(async () => {
      await result.current.handleAiContinue()
    })

    expect(window.api.ai.chat).toHaveBeenCalledTimes(2)
    expect(vi.mocked(window.api.ai.chat).mock.calls[0][0].reasoningMode).toBe('disabled')
    expect(result.current.text).toBe('夜已经很深。门外忽然传来急促的敲门声，走廊里的灯随之闪烁起来。')
    expect(result.current.text).not.toContain('We need')
  })

  it('续写重试后仍无有效中文时恢复原输入', async () => {
    mockAiHelperResponses(['Need final only.', '<continuation>Return a third-person paragraph.</continuation>'])
    const { result } = renderHook(() => useChatInputState(createCharacter()))
    act(() => result.current.setText('保留这段原文。'))

    await act(async () => {
      await result.current.handleAiContinue()
    })

    expect(result.current.text).toBe('保留这段原文。')
    expect(result.current.notification).toContain('有效的中文正文')
  })
})
