import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useChatStore } from '../useChatStore'
import { useSettingsStore } from '../useSettingsStore'
import { usePersonaStore } from '../usePersonaStore'
import { getDefaultSettings } from '../../../shared/defaults'
import { streamAIResponse, cleanupActiveStream, maybeAutoTitle } from '../streamController'
import { STREAM_THROTTLE_MS, STREAM_IDLE_TIMEOUT_MS } from '../../../shared/chat-core/chatConstants'
import type { Character, Message, ConnectionProfile, Preset, Settings } from '../../../shared/types'

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

/** 捕获 ai.onChunk/onComplete/onError 注册的回调，供测试手动触发 */
function captureStreamCallbacks() {
  const callbacks: {
    onChunk?: (data: { requestId: string; text: string }) => void
    onComplete?: (payload: { requestId: string; finishReason?: string }) => void
    onError?: (data: { requestId: string; error: string }) => void
    chatParams?: { requestId: string; maxTokens?: number; messages?: Array<{ role: string; content: string }> }
  } = {}
  ;(window.api.ai as any).onChunk = vi.fn().mockImplementation((cb) => {
    callbacks.onChunk = cb
    return () => {}
  })
  ;(window.api.ai as any).onComplete = vi.fn().mockImplementation((cb) => {
    callbacks.onComplete = cb
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
    vi.mocked(window.api.spatial.readContext).mockResolvedValue(null)
    vi.mocked(window.api.spatial.prepareDialogue).mockResolvedValue(null)
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanupActiveStream()
    vi.useRealTimers()
  })

  it('legacy 实际请求包含一次预取的位置；重试的 prebuilt 保留同一快照', async () => {
    const callbacks = captureStreamCallbacks()
    const character = createCharacter()
    useSettingsStore.setState(state=>({settings:{...state.settings,connectionProfiles:[{...PROFILE,maxContext:32768}]}}))
    const spatial = { text:'【空间位置 v1】\nAlice 在茶馆，参与对话。',minimalText:'【空间位置 v1】\nAlice 在茶馆，参与对话。',tokens:40,minimalTokens:40,cropped:[],snapshotId:'one-snapshot',characterOffstage:false,
      version:{worldId:'world-1',runtimeId:'single_s1',runtimeRevision:1,bindingEpoch:'epoch',worldFingerprint:'a'.repeat(64)} }
    useChatStore.setState({sessions:[{id:'s1',characterId:character.id,spatialBoardEnabled:true,spatialWorldId:'world-1',spatialRuntimeId:'single_s1',title:'测试',createdAt:0,updatedAt:0,messageCount:0,lastMessage:'',memoryEnabled:false,memoryMode:'auto',autoMemoryInterval:10,memory:'',memoryUpdatedAt:0}]})
    vi.mocked(window.api.spatial.readContext).mockResolvedValue(spatial)
    await streamAIResponse(useChatStore.setState as any,useChatStore.getState as any,{aiMessageId:'ai-msg-1',character,preset:null,onComplete:vi.fn().mockResolvedValue(undefined)})
    expect(useChatStore.getState().error).toBeNull()
    expect(callbacks.chatParams?.messages?.map(message=>message.content).join('\n')).toContain('Alice 在茶馆')
    expect(window.api.spatial.readContext).toHaveBeenCalledTimes(1)
    const prebuilt = useChatStore.getState().buildContext(character,null,{spatialContext:spatial,trackUsage:false})
    vi.mocked(window.api.spatial.readContext).mockResolvedValue({...spatial,text:'Alice 在厨房',snapshotId:'new-snapshot'})
    await streamAIResponse(useChatStore.setState as any,useChatStore.getState as any,{aiMessageId:'ai-msg-1',character,preset:null,prebuilt,onComplete:vi.fn().mockResolvedValue(undefined)})
    expect(window.api.spatial.readContext).toHaveBeenCalledTimes(1)
    expect(callbacks.chatParams?.messages?.map(message=>message.content).join('\n')).toContain('Alice 在茶馆')
    vi.mocked(window.api.spatial.readContext).mockResolvedValue(null)
  })

  it('会话默认关闭，即使旧全局开关开启也不读取或登记画板', async () => {
    const callbacks = captureStreamCallbacks(), character = createCharacter()
    useSettingsStore.setState(state => ({ settings: { ...state.settings, spatialBoardEnabled: true } }))
    useChatStore.setState({ sessions: [{ id: 's1', title: '测试', characterId: character.id } as any] })
    await streamAIResponse(useChatStore.setState as any, useChatStore.getState as any, {
      aiMessageId: 'ai-msg-1', character, preset: null, onComplete: vi.fn().mockResolvedValue(undefined),
    })
    expect(callbacks.chatParams).toBeDefined()
    expect(window.api.spatial.readContext).not.toHaveBeenCalled()
    expect(window.api.spatial.prepareDialogue).not.toHaveBeenCalled()
  })

  it('位置读取失败时不调用对话模型', async () => {
    useChatStore.setState({ sessions: [{ id: 's1', title: '测试', characterId: createCharacter().id, spatialBoardEnabled: true } as any] })
    const callbacks = captureStreamCallbacks(); const onError = vi.fn()
    vi.mocked(window.api.spatial.readContext).mockRejectedValueOnce(new Error('空间运行状态缺失'))
    await streamAIResponse(useChatStore.setState as any,useChatStore.getState as any,{aiMessageId:'ai-msg-1',character:createCharacter(),preset:null,onComplete:vi.fn().mockResolvedValue(undefined),onError})
    expect(callbacks.chatParams).toBeUndefined(); expect(onError).toHaveBeenCalledWith('空间运行状态缺失')
    expect(useChatStore.getState().isStreaming).toBe(false)
  })

  it('空间队列等完成回调保存成功才通知；保存失败不提取', async () => {
    useChatStore.setState({ sessions: [{ id: 's1', title: '测试', characterId: createCharacter().id, spatialBoardEnabled: true } as any] })
    const callbacks = captureStreamCallbacks()
    vi.mocked(window.api.spatial.prepareDialogue).mockResolvedValue('spatial-generation')
    let saveDone!: () => void
    const onComplete = vi.fn().mockImplementation(() => new Promise<void>(resolve => { saveDone = resolve }))
    await streamAIResponse(useChatStore.setState as any,useChatStore.getState as any,{aiMessageId:'ai-msg-1',character:createCharacter(),preset:null,onComplete})
    const requestId = callbacks.chatParams!.requestId
    callbacks.onChunk!({requestId,text:'Alice 走进厨房。'}); callbacks.onComplete!({requestId,finishReason:'stop'})
    await vi.advanceTimersByTimeAsync(10)
    expect(onComplete).toHaveBeenCalledWith('Alice 走进厨房。',expect.objectContaining({spatialGenerationId:'spatial-generation'}))
    expect(window.api.spatial.dialogueSaved).not.toHaveBeenCalled()
    saveDone(); await vi.advanceTimersByTimeAsync(10)
    expect(window.api.spatial.dialogueSaved).toHaveBeenCalledWith('char-1','s1','spatial-generation','ai-msg-1')
    vi.mocked(window.api.spatial.dialogueSaved).mockClear()
    onComplete.mockRejectedValueOnce(new Error('正文保存失败'))
    await streamAIResponse(useChatStore.setState as any,useChatStore.getState as any,{aiMessageId:'ai-msg-1',character:createCharacter(),preset:null,onComplete})
    const nextId = callbacks.chatParams!.requestId
    callbacks.onChunk!({requestId:nextId,text:'Alice 走进厨房。'}); callbacks.onComplete!({requestId:nextId,finishReason:'stop'})
    await vi.advanceTimersByTimeAsync(10)
    expect(window.api.spatial.dialogueSaved).not.toHaveBeenCalled()
  })
  it.each(['length','cancelled','unknown'])('终态 %s 不投递剧情事件', async finishReason => {
    useChatStore.setState({ sessions: [{ id: 's1', title: '测试', characterId: createCharacter().id, spatialBoardEnabled: true } as any] })
    const callbacks = captureStreamCallbacks(), onComplete = vi.fn().mockResolvedValue(undefined)
    vi.mocked(window.api.spatial.prepareDialogue).mockResolvedValue('spatial-generation')
    useSettingsStore.setState(state => ({settings:{...state.settings,autoTailRepairEnabled:false}}))
    await streamAIResponse(useChatStore.setState as any,useChatStore.getState as any,{aiMessageId:'ai-msg-1',character:createCharacter(),preset:null,onComplete})
    const requestId = callbacks.chatParams!.requestId
    callbacks.onChunk!({requestId,text:'Alice 走进厨房。'}); callbacks.onComplete!({requestId,finishReason})
    await vi.advanceTimersByTimeAsync(10)
    expect(window.api.spatial.dialogueSaved).not.toHaveBeenCalled()
    if (onComplete.mock.calls.length) expect(onComplete.mock.calls[0]![1].spatialGenerationId).toBeUndefined()
  })

  it('会话标题生成只使用专用提示，不继承预设越狱', async () => {
    const callbacks = captureStreamCallbacks()
    const character = createCharacter()
    const preset: Preset = {
      id: 'title-jailbreak', name: '标题预设', description: '', systemPrompt: '',
      jailbreak: '标题越狱：{{user}} 与 {{char}} 保持沉浸。',
      maxContext: 0, temperature: 0.8, topP: 0.95, maxTokens: 0,
      frequencyPenalty: 0, presencePenalty: 0, isBuiltin: false,
    }
    useChatStore.setState({
      currentSessionId: 's1',
      sessions: [{
        id: 's1', characterId: 'char-1', title: '新对话 1',
        createdAt: 0, updatedAt: 0, titleGenerated: false,
      } as never],
      messages: Array.from({ length: 4 }, (_, index) => ({
        id: `u${index}`, sessionId: 's1', characterId: 'char-1', role: 'user' as const,
        content: `用户消息${index}`, images: [], isEditing: false, timestamp: index,
      })),
    })

    await maybeAutoTitle(useChatStore.getState as any, useChatStore.setState as any, character, preset)

    const systemPrompt = callbacks.chatParams?.messages?.find((message) => message.role === 'system')?.content ?? ''
    expect(systemPrompt).toContain('对话标题生成器')
    expect(systemPrompt).not.toContain('标题越狱')
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

  it('onComplete 完成流程：内容更新、isStreaming 复位、onComplete 回调（阶段3结构化完成）', async () => {
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
    callbacks.onChunk!({ requestId, text: '最终答案。' })
    await vi.advanceTimersByTimeAsync(STREAM_THROTTLE_MS + 10)
    callbacks.onComplete!({ requestId, finishReason: 'stop' })
    // 收尾为异步流程（finalizer + onComplete 回调）
    await vi.advanceTimersByTimeAsync(10)

    const msg = useChatStore.getState().messages.find(m => m.id === 'ai-msg-1')
    expect(msg?.content).toBe('最终答案。')
    expect(useChatStore.getState().isStreaming).toBe(false)
    expect(onComplete).toHaveBeenCalledWith('最终答案。', expect.objectContaining({ finishReason: 'stop' }))
    // usage 记录被写入
    expect(window.api.usage.record).toHaveBeenCalled()

    await promise
  })

  it('阶段3：截断流（length + 半句）收尾回退到完整句，不落盘半句', async () => {
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
    callbacks.onChunk!({ requestId, text: '她推开门，走进房间，环顾四周陌生的陈设与积灰的家具。然后她伸手拿' })
    await vi.advanceTimersByTimeAsync(STREAM_THROTTLE_MS + 10)
    callbacks.onComplete!({ requestId, finishReason: 'length' })
    await vi.advanceTimersByTimeAsync(10)

    // 收尾器回退到最后一个完整句：onComplete 收到收束后的正文与元数据，
    // 悬空半句不再传给落盘管线（测试内消息内容保留流式 flush 的原始值）
    expect(onComplete).toHaveBeenCalledWith(
      '她推开门，走进房间，环顾四周陌生的陈设与积灰的家具。',
      expect.objectContaining({ finishReason: 'length', notice: 'trimmed_to_boundary' }),
    )
    expect(onComplete).not.toHaveBeenCalledWith(
      expect.stringContaining('然后她伸手拿'),
      expect.anything(),
    )
    await promise
  })

  it('旧 generationPipeline 数据不再绕过统一预算与收尾器', async () => {
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        generationPipeline: 'legacy',
      } as unknown as Settings,
    })
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
    expect(callbacks.chatParams!.maxTokens).toBeGreaterThan(1024)

    callbacks.onChunk!({ requestId, text: '她推开门，走进房间，环顾四周陌生的陈设与积灰的家具。然后她伸手拿' })
    await vi.advanceTimersByTimeAsync(STREAM_THROTTLE_MS + 10)
    callbacks.onComplete!({ requestId, finishReason: 'length' })
    await vi.advanceTimersByTimeAsync(10)

    expect(onComplete).toHaveBeenCalledWith(
      '她推开门，走进房间，环顾四周陌生的陈设与积灰的家具。',
      expect.objectContaining({ finishReason: 'length' }),
    )
    await promise
  })

  it('推理共享模型的危险低硬上限在发送前拦截，不浪费一次空响应请求', async () => {
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        activeModel: 'deepseek-v4-flash',
        connectionProfiles: [{ ...PROFILE, model: 'deepseek-v4-flash' }],
      },
    }))
    captureStreamCallbacks()
    const onError = vi.fn()
    const preset: Preset = {
      id: 'low-cap', name: '低上限', description: '', systemPrompt: '', jailbreak: '',
      maxContext: 0, temperature: 0.8, topP: 0.95, maxTokens: 1024,
      frequencyPenalty: 0, presencePenalty: 0, isBuiltin: false,
      responseLengthHint: 'balanced',
    }

    await streamAIResponse(useChatStore.setState as any, useChatStore.getState as any, {
      aiMessageId: 'ai-msg-1',
      character: createCharacter(),
      preset,
      onComplete: vi.fn(),
      onError,
    })

    expect(window.api.ai.chat).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('设为 0 使用自动预算'))
    expect(useChatStore.getState().error).toContain('低于该推理模型稳定输出正文')
  })

  it('阶段3：用户停止（cancelled）保留已流式内容', async () => {
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
    callbacks.onChunk!({ requestId, text: '用户停止前看到的内' })
    await vi.advanceTimersByTimeAsync(STREAM_THROTTLE_MS + 10)
    callbacks.onComplete!({ requestId, finishReason: 'cancelled' })
    await vi.advanceTimersByTimeAsync(10)

    const msg = useChatStore.getState().messages.find(m => m.id === 'ai-msg-1')
    expect(msg?.content).toBe('用户停止前看到的内')
    expect(onComplete).toHaveBeenCalledWith(
      '用户停止前看到的内',
      expect.objectContaining({ finishReason: 'cancelled', stopped: true }),
    )
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
    // 阶段7：错误收口是异步的（半截正文先进统一管线）
    await vi.advanceTimersByTimeAsync(10)

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

  it('主对话使用统一门控与自动预算，不按模型名固定 token', async () => {
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        activeModel: 'deepseek/deepseek-v4.1-flash',
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

    const params = (callbacks.chatParams as any)
    expect(params.reasoningGate).toMatchObject({ level: 'standard' })
    expect(params.maxTokens).toBeGreaterThan(2048)
    expect(params.maxTokens).toBeLessThanOrEqual(32768)
    await promise
  })

  it('空闲超时：60s 无新 chunk 中止请求并报错', async () => {
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
    callbacks.onChunk!({ requestId, text: '开头' })
    // 推进到空闲超时
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 10)

    expect(window.api.ai.cancelChat).toHaveBeenCalled()
    expect(useChatStore.getState().isStreaming).toBe(false)
    expect(useChatStore.getState().error).toBe('请求超时')
    // 阶段7：正文过短无稳定边界 → 不落盘半句（terminal 缺省），提示走 onError 第二参数扩展位
    expect(onError).toHaveBeenCalledWith('请求超时', undefined)

    await promise
  })

  it('收到新 chunk 会重置空闲计时：不触发超时', async () => {
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
    for (let i = 0; i < 10; i++) {
      callbacks.onChunk!({ requestId, text: `chunk${i}` })
      await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS - 100)
    }

    expect(window.api.ai.cancelChat).not.toHaveBeenCalled()
    expect(useChatStore.getState().isStreaming).toBe(true)
    expect(onError).not.toHaveBeenCalled()

    await promise
  })
})
