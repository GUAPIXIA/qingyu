import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useChatStore } from '../useChatStore'
import { useSettingsStore } from '../useSettingsStore'
import { usePersonaStore } from '../usePersonaStore'
import { getDefaultSettings } from '../../../shared/defaults'
import { streamAIResponse, cleanupActiveStream } from '../streamController'
import { STREAM_THROTTLE_MS } from '../chatConstants'
import type { Character, Message, ConnectionProfile } from '../../../shared/types'

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

/** 捕获 ai.onChunk/onDone/onError 注册的回调，供测试手动触发 */
function captureStreamCallbacks() {
  const callbacks: {
    onChunk?: (data: { requestId: string; text: string }) => void
    onDone?: (requestId: string) => void
    onError?: (data: { requestId: string; error: string }) => void
    chatParams?: { requestId: string }
  } = {}
  ;(window.api.ai as any).onChunk = vi.fn().mockImplementation((cb) => {
    callbacks.onChunk = cb
    return () => {}
  })
  ;(window.api.ai as any).onDone = vi.fn().mockImplementation((cb) => {
    callbacks.onDone = cb
    return () => {}
  })
  ;(window.api.ai as any).onError = vi.fn().mockImplementation((cb) => {
    callbacks.onError = cb
    return () => {}
  })
  ;(window.api.ai as any).chat = vi.fn().mockImplementation((params) => {
    callbacks.chatParams = params
    return Promise.resolve(undefined)
  })
  return callbacks
}

function setupStores() {
  usePersonaStore.setState({ personas: [], loaded: true })
  useSettingsStore.setState({
    settings: {
      ...getDefaultSettings(),
      userName: 'TestUser',
      activeProfileId: 'p1',
      connectionProfiles: [PROFILE],
      activeModel: 'gpt-4o',
    },
    credentials: {},
    loaded: true,
    _saveTimer: null,
  })
  useChatStore.setState({
    messages: [
      {
        id: 'ai-msg-1',
        sessionId: 's1',
        characterId: 'char-1',
        role: 'assistant',
        content: '',
        images: [],
        isEditing: false,
        timestamp: Date.now(),
      } as Message,
    ],
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

describe('streamAIResponse 流式控制', () => {
  beforeEach(() => {
    setupStores()
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanupActiveStream()
    vi.useRealTimers()
  })

  it('流式 chunk 累积后 flush 到消息内容', async () => {
    const callbacks = captureStreamCallbacks()
    const onComplete = vi.fn().mockResolvedValue(undefined)

    const promise = streamAIResponse(useChatStore.setState as any, useChatStore.getState as any, {
      aiMessageId: 'ai-msg-1',
      character: createCharacter(),
      preset: null,
      onComplete,
    })
    // 等待注册完成
    await vi.advanceTimersByTimeAsync(0)

    expect(callbacks.onChunk).toBeDefined()
    callbacks.onChunk!({ requestId: callbacks.chatParams!.requestId, text: '你好' })
    callbacks.onChunk!({ requestId: callbacks.chatParams!.requestId, text: '世界' })

    // 节流 timer 到期后 flush
    await vi.advanceTimersByTimeAsync(STREAM_THROTTLE_MS + 10)
    const msg = useChatStore.getState().messages.find(m => m.id === 'ai-msg-1')
    expect(msg?.content).toBe('你好世界')
    expect(useChatStore.getState().isStreaming).toBe(true)

    await promise
  })

  it('onDone 完成流程：内容更新、isStreaming 复位、onComplete 调用', async () => {
    const callbacks = captureStreamCallbacks()
    const onComplete = vi.fn().mockResolvedValue(undefined)

    const promise = streamAIResponse(useChatStore.setState as any, useChatStore.getState as any, {
      aiMessageId: 'ai-msg-1',
      character: createCharacter(),
      preset: null,
      onComplete,
    })
    await vi.advanceTimersByTimeAsync(0)

    const requestId = callbacks.chatParams!.requestId
    callbacks.onChunk!({ requestId, text: '最终答案' })
    await vi.advanceTimersByTimeAsync(STREAM_THROTTLE_MS + 10)
    callbacks.onDone!(requestId)

    const msg = useChatStore.getState().messages.find(m => m.id === 'ai-msg-1')
    expect(msg?.content).toBe('最终答案')
    expect(useChatStore.getState().isStreaming).toBe(false)
    expect(onComplete).toHaveBeenCalledWith('最终答案')
    // usage 记录被写入
    expect(window.api.usage.record).toHaveBeenCalled()

    await promise
  })

  it('onError 流程：错误消息写入 state、isStreaming 复位、onError 回调', async () => {
    const callbacks = captureStreamCallbacks()
    const onError = vi.fn()

    const promise = streamAIResponse(useChatStore.setState as any, useChatStore.getState as any, {
      aiMessageId: 'ai-msg-1',
      character: createCharacter(),
      preset: null,
      onComplete: vi.fn().mockResolvedValue(undefined),
      onError,
    })
    await vi.advanceTimersByTimeAsync(0)

    const requestId = callbacks.chatParams!.requestId
    callbacks.onError!({ requestId, error: 'API 返回 500' })

    expect(useChatStore.getState().isStreaming).toBe(false)
    expect(useChatStore.getState().error).toBeTruthy()
    expect(onError).toHaveBeenCalled()

    await promise
  })

  it('无 API profile 时直接报错不发起请求', async () => {
    useSettingsStore.setState({
      settings: { ...getDefaultSettings(), activeProfileId: null, connectionProfiles: [] },
    } as any)
    const onError = vi.fn()

    await streamAIResponse(useChatStore.setState as any, useChatStore.getState as any, {
      aiMessageId: 'ai-msg-1',
      character: createCharacter(),
      preset: null,
      onComplete: vi.fn().mockResolvedValue(undefined),
      onError,
    })
    expect(window.api.ai.chat).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalled()
  })

  it('停止字符串命中后截断并取消请求', async () => {
    const callbacks = captureStreamCallbacks()
    // 配置一条 output 停止规则：命中「停止词」即截断
    ;(window.api as any).regex.list = vi.fn().mockResolvedValue([
      {
        id: 'r1',
        name: 'stop',
        pattern: '',
        replacement: '',
        enabled: true,
        scope: 'output',
        stopStrings: ['停止词'],
      },
    ])

    const promise = streamAIResponse(useChatStore.setState as any, useChatStore.getState as any, {
      aiMessageId: 'ai-msg-1',
      character: createCharacter(),
      preset: null,
      onComplete: vi.fn().mockResolvedValue(undefined),
    })
    await vi.advanceTimersByTimeAsync(0)

    const requestId = callbacks.chatParams!.requestId
    callbacks.onChunk!({ requestId, text: '前面的内容停止词后面的内容' })
    await vi.advanceTimersByTimeAsync(STREAM_THROTTLE_MS + 10)

    const msg = useChatStore.getState().messages.find(m => m.id === 'ai-msg-1')
    // 停止词及其后内容被截断
    expect(msg?.content).not.toContain('停止词')
    expect(window.api.ai.cancelChat).toHaveBeenCalled()

    await promise
  })

  it('上下文含图片且配置激活识图模型 → 请求使用识图模型连接', async () => {
    // 配置识图模型（独立连接）
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        visionModels: [{
          id: 'v1', name: '识图', provider: 'openai', model: 'gpt-4o-vision',
          baseUrl: 'https://vision.example.com/v1', apiKey: 'sk-vision', enabled: true, order: 0,
        }],
        activeVisionModelId: 'v1',
      },
    })
    // 历史消息含一条带图片的用户消息
    useChatStore.setState((state) => ({
      messages: [
        {
          id: 'user-img-1',
          sessionId: 's1',
          characterId: 'char-1',
          role: 'user',
          content: '看这张图',
          images: ['data:image/png;base64,iVBORw0KGgo='],
          isEditing: false,
          timestamp: Date.now() - 1000,
        },
        ...state.messages,
      ],
    }))

    const callbacks = captureStreamCallbacks()
    const promise = streamAIResponse(useChatStore.setState as any, useChatStore.getState as any, {
      aiMessageId: 'ai-msg-1',
      character: createCharacter(),
      preset: null,
      onComplete: vi.fn().mockResolvedValue(undefined),
    })
    await vi.advanceTimersByTimeAsync(0)

    const params = callbacks.chatParams as any
    expect(params.model).toBe('gpt-4o-vision')
    expect(params.provider).toBe('openai')
    expect(params.baseUrl).toBe('https://vision.example.com/v1')
    expect(params.apiKey).toBe('sk-vision')

    await promise
  })

  it('上下文无图片时使用主对话模型（不切识图）', async () => {
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        visionModels: [{
          id: 'v1', name: '识图', model: 'gpt-4o-vision', enabled: true, order: 0,
        }],
        activeVisionModelId: 'v1',
      },
    })

    const callbacks = captureStreamCallbacks()
    const promise = streamAIResponse(useChatStore.setState as any, useChatStore.getState as any, {
      aiMessageId: 'ai-msg-1',
      character: createCharacter(),
      preset: null,
      onComplete: vi.fn().mockResolvedValue(undefined),
    })
    await vi.advanceTimersByTimeAsync(0)

    expect((callbacks.chatParams as any).model).toBe('gpt-4o')

    await promise
  })
})
