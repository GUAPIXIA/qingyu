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
    // 用「短句」档让 25 字正文落在区间内，本用例只验证格式重试路径
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, continueLength: 'brief' } }))
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

  /** 生成 n 个可见字符的完整句正文（每句 2 字）。 */
  function sentenceText(n: number): string {
    return '甲。'.repeat(Math.ceil(n / 2))
  }

  it('长度偏短时发起一次补足修复，接受修复后的结果', async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, continueLength: 'brief' } }))
    // 首次 10 字（低于 20 字下限的 80%），修复后 40 字（落在 20–60 区间）
    mockAiHelperResponses([
      `<continuation>${sentenceText(10)}</continuation>`,
      `<continuation>${sentenceText(40)}</continuation>`,
    ])
    const { result } = renderHook(() => useChatInputState(createCharacter()))

    await act(async () => {
      await result.current.handleAiContinue()
    })

    expect(window.api.ai.chat).toHaveBeenCalledTimes(2)
    const repairSystem = vi.mocked(window.api.ai.chat).mock.calls[1][0].messages[0].content as string
    expect(repairSystem).toContain('请补足到目标区间')
    expect(result.current.text).toBe(sentenceText(40))
  })

  it('结尾被截断时按补足处理，不把半截正文写回输入框', async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, continueLength: 'brief' } }))
    mockAiHelperResponses([
      `<continuation>${sentenceText(30)}守卫还在</continuation>`,
      `<continuation>${sentenceText(40)}</continuation>`,
    ])
    const { result } = renderHook(() => useChatInputState(createCharacter()))

    await act(async () => {
      await result.current.handleAiContinue()
    })

    expect(window.api.ai.chat).toHaveBeenCalledTimes(2)
    const repairSystem = vi.mocked(window.api.ai.chat).mock.calls[1][0].messages[0].content as string
    expect(repairSystem).toContain('未能写完就中断')
    expect(result.current.text).toBe(sentenceText(40))
  })

  it('超出上限但在 120% 以内时按句边界收束，不发起修复请求', async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, continueLength: 'brief' } }))
    // 上限 60 → 120% 为 72；70 字整体超长但存在句边界，可收束到区间内
    mockAiHelperResponses([`<continuation>${sentenceText(70)}</continuation>`])
    const { result } = renderHook(() => useChatInputState(createCharacter()))

    await act(async () => {
      await result.current.handleAiContinue()
    })

    expect(window.api.ai.chat).toHaveBeenCalledTimes(1)
    expect(result.current.text).toBe(sentenceText(60))
  })

  it('明显超长时发起一次压缩修复', async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, continueLength: 'brief' } }))
    mockAiHelperResponses([
      `<continuation>${sentenceText(160)}</continuation>`,
      `<continuation>${sentenceText(40)}</continuation>`,
    ])
    const { result } = renderHook(() => useChatInputState(createCharacter()))

    await act(async () => {
      await result.current.handleAiContinue()
    })

    expect(window.api.ai.chat).toHaveBeenCalledTimes(2)
    const repairSystem = vi.mocked(window.api.ai.chat).mock.calls[1][0].messages[0].content as string
    expect(repairSystem).toContain('请压缩重写')
    expect(result.current.text).toBe(sentenceText(40))
  })

  it('两次输出都没写完时给出可操作提示而非笼统的格式错误', async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, continueLength: 'brief' } }))
    // 缺少 </continuation>：预算不足时模型在闭标签前被切断
    mockAiHelperResponses([
      '<continuation>港口已经封锁，任何人都不能通过，守卫正在',
      '<continuation>港口已经封锁，任何人都不能通过，守卫正在',
    ])
    const { result } = renderHook(() => useChatInputState(createCharacter()))

    await act(async () => {
      await result.current.handleAiContinue()
    })

    expect(result.current.notification).toContain('续写没有写完')
    expect(result.current.notification).not.toContain('未返回有效的中文正文')
  })

  it('无标签的格式错误仍提示重试或更换模型', async () => {
    mockAiHelperResponses(['Need final only.', 'Still no tag.'])
    const { result } = renderHook(() => useChatInputState(createCharacter()))

    await act(async () => {
      await result.current.handleAiContinue()
    })

    expect(result.current.notification).toContain('未返回有效的中文正文')
  })

  it('修复后仍明显越界时保留原输入并给出可见反馈', async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, continueLength: 'brief' } }))
    mockAiHelperResponses([
      `<continuation>${sentenceText(10)}</continuation>`,
      `<continuation>${sentenceText(4)}</continuation>`,
    ])
    const { result } = renderHook(() => useChatInputState(createCharacter()))
    act(() => result.current.setText('保留这段原文。'))

    await act(async () => {
      await result.current.handleAiContinue()
    })

    // 最多一次修复，失败后保留用户原输入
    expect(window.api.ai.chat).toHaveBeenCalledTimes(2)
    expect(result.current.text).toBe('保留这段原文。')
    expect(result.current.notification).toContain('长度')
  })

  it('格式无效重试与长度修复各自最多一次，不串成更多请求', async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, continueLength: 'brief' } }))
    // 第一次格式无效 → 格式重试；第二次长度偏短 → 长度修复；第三次接受
    mockAiHelperResponses([
      'We need continue.',
      `<continuation>${sentenceText(10)}</continuation>`,
      `<continuation>${sentenceText(40)}</continuation>`,
    ])
    const { result } = renderHook(() => useChatInputState(createCharacter()))

    await act(async () => {
      await result.current.handleAiContinue()
    })

    expect(window.api.ai.chat).toHaveBeenCalledTimes(3)
    expect(result.current.text).toBe(sentenceText(40))
  })

  it('输出上限不随长度档位变化，稳定为统一兜底值', async () => {
    // 长度由提示词的字数指令控制；上限若随档位收紧，合规输出会在闭标签前被切断
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, continueLength: 'brief' } }))
    mockAiHelperResponses([`<continuation>${sentenceText(40)}</continuation>`])
    const { result } = renderHook(() => useChatInputState(createCharacter()))
    await act(async () => {
      await result.current.handleAiContinue()
    })
    const briefMax = vi.mocked(window.api.ai.chat).mock.calls[0][0].maxTokens

    vi.clearAllMocks()
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, continueLength: 'extended' } }))
    mockAiHelperResponses([`<continuation>${sentenceText(600)}</continuation>`])
    const second = renderHook(() => useChatInputState(createCharacter()))
    await act(async () => {
      await second.result.current.handleAiContinue()
    })
    const extendedMax = vi.mocked(window.api.ai.chat).mock.calls[0][0].maxTokens

    expect(briefMax).toBe(extendedMax)
    expect(briefMax).toBeGreaterThanOrEqual(4096)
  })

  it('修复后轻微越界但句意完整时接受', async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, continueLength: 'brief' } }))
    // 首次 10 字触发补足；修复后 14 字（低于上限 60、高于 60% 下限 12）应被接受
    mockAiHelperResponses([
      `<continuation>${sentenceText(10)}</continuation>`,
      `<continuation>${sentenceText(14)}</continuation>`,
    ])
    const { result } = renderHook(() => useChatInputState(createCharacter()))

    await act(async () => {
      await result.current.handleAiContinue()
    })

    expect(result.current.text).toBe(sentenceText(14))
  })
})
