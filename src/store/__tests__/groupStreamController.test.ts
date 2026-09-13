import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  splitAndSaveMessages,
  checkAutoMemory,
  checkPollingContinue,
  cleanupActiveStream,
  clearPollingTimer,
  getActiveStream,
  markPendingGroupCompression,
  preserveGroupReplyContent,
  streamGroupAI,
  streamGroupAIFree,
} from '../groupStreamController'
import { useSettingsStore } from '../useSettingsStore'
import { useCharacterStore } from '../useCharacterStore'
import { resetTailRepairFailureCounts } from '../streamController'
import { STREAM_IDLE_TIMEOUT_MS } from '../chatConstants'
import { getDefaultSettings } from '../../../shared/defaults'
import type { GroupChat, GroupMessage, Character } from '../../../shared/types'

function makeCharacter(id: string, name: string): Character {
  return {
    id, name, avatar: '', description: '', personality: '',
    scenario: '', firstMessage: '', exampleDialog: '', tags: [], lorebookId: null,
    creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [],
  }
}

function makeGroup(overrides: Partial<GroupChat> = {}): GroupChat {
  return {
    id: 'g1', name: '测试群', memberIds: ['c1', 'c2'],
    currentSpeakerIndex: 0, autoMode: false, chatMode: 'polling',
    maxRounds: 3, speakerInterval: 2000, lorebookIds: [],
    presetId: null, systemPrompt: '', createdAt: 0, updatedAt: 0,
    ...overrides,
  }
}

function setup() {
  useSettingsStore.setState({
    settings: { ...getDefaultSettings(), userName: '用户', activeProfileId: 'p1' } as any,
    credentials: {}, loaded: true, _saveTimer: null,
  })
  useCharacterStore.setState({
    characters: [makeCharacter('c1', '爱丽丝'), makeCharacter('c2', '千夏')],
  })
  ;(window.api.group as any).saveMessage = vi.fn().mockResolvedValue(undefined)
  ;(window.api.group as any).saveMessagesBatch = vi.fn().mockResolvedValue(undefined)
  ;(window.api.group as any).save = vi.fn().mockResolvedValue(undefined)
}

describe('群聊角色内心内容保留', () => {
  it('完成回复时保留角色 thought，并丢弃供应商 thinking', () => {
    expect(preserveGroupReplyContent('  <thinking>先分析上下文</thinking>\n<thought>我得保持冷静。</thought>\n最终回复  ')).toBe(
      '<thought>我得保持冷静。</thought>\n最终回复',
    )
  })
})

describe('splitAndSaveMessages 群聊自由发言拆分', () => {
  beforeEach(() => {
    setup()
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanupActiveStream()
    clearPollingTimer()
    vi.useRealTimers()
  })

  it('按【角色名】拆分多条消息并保存', async () => {
    const set = vi.fn()
    const content = '【爱丽丝】你好呀\n【千夏】大家好！'
    await splitAndSaveMessages(set as any, (() => ({})) as any, makeGroup(), 's1', content, 2, 'ph-1')

    // 优化：多条消息合并为一次批量保存
    expect(window.api.group.saveMessage).not.toHaveBeenCalled()
    expect(window.api.group.saveMessagesBatch).toHaveBeenCalledTimes(1)
    const batch = vi.mocked(window.api.group.saveMessagesBatch).mock.calls[0][2] as GroupMessage[]
    expect(batch).toHaveLength(2)
    const saved1 = batch[0]
    const saved2 = batch[1]
    expect(saved1.characterId).toBe('c1')
    expect(saved1.content).toBe('你好呀')
    expect(saved2.characterId).toBe('c2')
    expect(saved2.content).toBe('大家好！')

    // 占位消息被移除，新消息加入并按时间排序
    const state = set.mock.calls[0][0]({ messages: [{ id: 'ph-1' }] })
    expect(state.messages.some((m: GroupMessage) => m.id === 'ph-1')).toBe(false)
    expect(state.messages).toHaveLength(2)
    expect(state.isStreaming).toBe(false)
  })

  it('角色名匹配大小写与空格不敏感', async () => {
    const set = vi.fn()
    await splitAndSaveMessages(set as any, (() => ({})) as any, makeGroup(), 's1', '【 爱丽丝 】说话', 1, 'ph')
    const saved = vi.mocked(window.api.group.saveMessage).mock.calls[0][2] as GroupMessage
    expect(saved.characterId).toBe('c1')
  })

  it('未识别角色内容追加到前一条成员消息', async () => {
    const set = vi.fn()
    const content = '【爱丽丝】第一句\n【路人甲】乱入内容'
    await splitAndSaveMessages(set as any, (() => ({})) as any, makeGroup(), 's1', content, 1, 'ph')

    const saved = vi.mocked(window.api.group.saveMessage).mock.calls
    // 第一条是爱丽丝，路人甲的内容追加到爱丽丝消息中
    expect(saved[0][2].content).toContain('第一句')
    expect(saved[0][2].content).toContain('未识别角色「路人甲」: 乱入内容')
    expect(saved).toHaveLength(1)
  })

  it('无任何角色标记时回退为第一个成员消息', async () => {
    const set = vi.fn()
    await splitAndSaveMessages(set as any, (() => ({})) as any, makeGroup(), 's1', '没有标记的普通文本', 1, 'ph-1')

    const state = set.mock.calls[0][0]({ messages: [{ id: 'ph-1' }] })
    const msg = state.messages.find((m: GroupMessage) => m.id === 'ph-1')
    expect(msg.characterId).toBe('c1')
    expect(msg.content).toBe('没有标记的普通文本')
    expect(window.api.group.saveMessage).toHaveBeenCalledWith('g1', 's1', expect.objectContaining({
      id: 'ph-1', characterId: 'c1',
    }))
  })

  it('首段角色标记前有 preamble 文本时保留', async () => {
    const set = vi.fn()
    const content = '（旁白）\n【爱丽丝】正文'
    await splitAndSaveMessages(set as any, (() => ({})) as any, makeGroup(), 's1', content, 1, 'ph')
    const saved = vi.mocked(window.api.group.saveMessage).mock.calls[0][2] as GroupMessage
    // H-14 修复：旁白并入首段内容（此前被后续覆盖丢弃，测试锁定了错误行为）
    expect(saved.content).toBe('（旁白）\n\n正文')
  })

  it('全局叙事保留游戏判定标题并保存为单条旁白消息', async () => {
    const set = vi.fn()
    const get = () => ({ sessions: [{ id: 's1', narrativeMode: 'omniscient' }] })
    const content = '风暴压境。\n\n【判定】潜行｜环境昏暗｜成功\n\n【可选行动】\n1. 进入北门'
    await splitAndSaveMessages(set as any, get as any, makeGroup(), 's1', content, 3, 'ph-narrator')

    expect(window.api.group.saveMessagesBatch).not.toHaveBeenCalled()
    expect(window.api.group.saveMessage).toHaveBeenCalledWith('g1', 's1', expect.objectContaining({
      id: 'ph-narrator',
      characterId: 'c1',
      narrativeMode: 'omniscient',
      content,
    }))
    const state = set.mock.calls[0][0]({ messages: [{ id: 'ph-narrator', content: '' }] })
    expect(state.messages[0].content).toBe(content)
  })

  it('占位消息更新为空内容时使用 (无回复)', async () => {
    const set = vi.fn()
    await splitAndSaveMessages(set as any, (() => ({})) as any, makeGroup(), 's1', '', 1, 'ph-1')
    const state = set.mock.calls[0][0]({ messages: [{ id: 'ph-1' }] })
    const msg = state.messages.find((m: GroupMessage) => m.id === 'ph-1')
    expect(msg.content).toBe('(无回复)')
  })
})

describe('群聊超时统一收尾（S2）', () => {
  beforeEach(() => {
    setup()
    // 群聊流式需要可用的连接档案（否则 getActiveProfile 为 null，直接返回）
    useSettingsStore.setState({
      settings: {
        ...getDefaultSettings(),
        userName: '用户',
        activeProfileId: 'p1',
        connectionProfiles: [{
          id: 'p1', name: '测试', provider: 'openai',
          baseUrl: 'https://api.example.com', apiKey: 'sk-test', model: 'gpt-4o', maxContext: 8192,
        }],
      } as any,
      credentials: {}, loaded: true, _saveTimer: null,
    })
    vi.clearAllMocks()
    vi.useFakeTimers()
    ;(window.api.group as any).saveMessage = vi.fn().mockResolvedValue(undefined)
    ;(window.api.ai as any).chat = vi.fn().mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanupActiveStream()
    clearPollingTimer()
    vi.useRealTimers()
  })

  /** 构造可被 set 更新的最小 store 形状（handleGroupStreamTimeout 需要 messages） */
  function makeGroupGet(group: GroupChat, sessionId: string) {
    let state: any = {
      currentGroup: group,
      currentSessionId: sessionId,
      sessions: [{ id: sessionId, narrativeMode: 'immersive' }],
      messages: [],
      _semanticLoreHits: [],
      _semanticFactsHits: [],
      ensureLorebooksLoaded: vi.fn(async () => {}),
      buildGroupContext: vi.fn(() => [{ role: 'user', content: '你好' }]),
    }
    const set = vi.fn((updater: any) => {
      const patch = typeof updater === 'function' ? updater(state) : updater
      state = { ...state, ...patch }
    })
    return { get: () => state, set, read: () => state }
  }

  function captureCallbacks() {
    const callbacks: { onChunk?: any; onComplete?: any; onError?: any } = {}
    ;(window.api.ai as any).onChunk = vi.fn((cb: any) => { callbacks.onChunk = cb; return () => {} })
    ;(window.api.ai as any).onComplete = vi.fn((cb: any) => { callbacks.onComplete = cb; return () => {} })
    ;(window.api.ai as any).onError = vi.fn((cb: any) => { callbacks.onError = cb; return () => {} })
    return callbacks
  }

  /** 启动一次群聊生成并让 chunk 续期超时触发（收到半句后卡死） */
  async function startThenTimeout(mode: 'mention' | 'polling' | 'free', partial: string) {
    const group = makeGroup({ chatMode: mode === 'free' ? 'free' : mode })
    const { get, set, read } = makeGroupGet(group, 's1')
    const callbacks = captureCallbacks()

    if (mode === 'free') {
      await streamGroupAIFree(set as any, get as any, group, 's1', 1)
    } else {
      await streamGroupAI(set as any, get as any, group, 's1', makeCharacter('c1', '爱丽丝'), 1, () => {})
    }

    if (partial) {
      const requestId = vi.mocked(window.api.ai.chat).mock.calls[0][0].requestId
      callbacks.onChunk!({ requestId, text: partial })
    }
    // 推进到空闲超时：初始 timeout 与 chunk 续期 timeout 都必须走同一处理器
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1)
    await vi.advanceTimersByTimeAsync(0)
    return { group, set, read }
  }

  it.each(['mention', 'polling', 'free'] as const)(
    '%s：收到半句后超时，正文停在稳定句界且错误不进入正文',
    async (mode) => {
      const { read } = await startThenTimeout(mode, '她推开门，走进房间。然后她伸手拿')

      const saved = vi.mocked(window.api.group.saveMessage).mock.calls.at(-1)?.[2] as GroupMessage
      expect(saved.content).toBe('她推开门，走进房间。')
      expect(saved.content).not.toContain('超时')
      // 阶段7 行为矩阵：idle timeout + 稳定正文 → generationError 走「已保留完整部分」
      expect(saved.generationError).toBe('请求超时，已保留完整部分')
      expect(saved.generationNotice).toBeUndefined()

      const placeholder = read().messages.find((m: GroupMessage) => m.id === saved.id)
      expect(placeholder?.content).toBe('她推开门，走进房间。')
      expect(placeholder?.generationError).toBe('请求超时，已保留完整部分')
      // 中断保留的正文与正常完成一致走语义分块，避免概率性丢失对话样式
      expect(saved.contentRenderMode).toBe('blocks')
      expect(placeholder?.contentRenderMode).toBe('blocks')
      expect(read().isStreaming).toBe(false)
    },
  )

  it('超时且没有任何稳定边界时不落盘半句，改为移除占位消息', async () => {
    const { read } = await startThenTimeout('mention', '她推开门走进房间然后她伸手拿')

    expect(window.api.group.saveMessage).not.toHaveBeenCalled()
    expect(read().messages.find((m: GroupMessage) => m.content.includes('她推开门'))).toBeUndefined()
    expect(read().error).toBe('请求超时')
  })

  it('未收到任何 chunk 的最初超时同样不落盘错误文案', async () => {
    await startThenTimeout('free', '')

    // 空正文：不发生保存，错误只进 state
    expect(window.api.group.saveMessage).not.toHaveBeenCalled()
  })

  it('超时正文同样经过 output 正则，且只执行一次', async () => {
    // 增量替换规则：执行一次得 '她A A。'，执行两次得 '她A A A A。'
    ;(window.api.regex as any) = {
      list: vi.fn().mockResolvedValue([{
        id: 'r-add', name: '加空格', enabled: true, scope: 'output',
        pattern: 'A', replacement: 'A A', flags: 'g',
      }]),
    }
    const { read } = await startThenTimeout('polling', '她A。')

    const saved = vi.mocked(window.api.group.saveMessage).mock.calls.at(-1)?.[2] as GroupMessage
    expect(saved.content).toBe('她A A。')
    expect(read().messages.find((m: GroupMessage) => m.id === saved.id)?.generationError).toBe('请求超时，已保留完整部分')
  })

  it('阶段7：普通 ai:error（点名）收口——半截正文收束到稳定句界，generationError 与正文分离落盘', async () => {
    const group = makeGroup({ chatMode: 'mention' })
    const { get, set, read } = makeGroupGet(group, 's1')
    const callbacks = captureCallbacks()
    await streamGroupAI(set as any, get as any, group, 's1', makeCharacter('c1', '爱丽丝'), 1, () => {})
    const requestId = vi.mocked(window.api.ai.chat).mock.calls[0][0].requestId
    callbacks.onChunk!({ requestId, text: '她推开门，走进这个陌生的房间，指尖拂过积灰的桌面。然后她伸手拿' })
    callbacks.onError!({ requestId, error: 'socket hang up' })
    await vi.advanceTimersByTimeAsync(10)

    const saved = vi.mocked(window.api.group.saveMessage).mock.calls.at(-1)?.[2] as GroupMessage
    expect(saved.content).toBe('她推开门，走进这个陌生的房间，指尖拂过积灰的桌面。')
    expect(saved.generationError).toBe('生成中断，已保留完整部分')
    expect(saved.content).not.toContain('hang up')
    expect(read().isStreaming).toBe(false)
    expect(read().messages.find((m: GroupMessage) => m.id === saved.id)?.content)
      .toBe('她推开门，走进这个陌生的房间，指尖拂过积灰的桌面。')
  })

  it('阶段7：ai:error 无正文 → 移除占位消息，不落盘错误文案（不创建空 AI 消息）', async () => {
    const group = makeGroup({ chatMode: 'mention' })
    const { get, set, read } = makeGroupGet(group, 's1')
    const callbacks = captureCallbacks()
    await streamGroupAI(set as any, get as any, group, 's1', makeCharacter('c1', '爱丽丝'), 1, () => {})
    const requestId = vi.mocked(window.api.ai.chat).mock.calls[0][0].requestId
    callbacks.onError!({ requestId, error: 'API 返回 500' })
    await vi.advanceTimersByTimeAsync(10)

    expect(window.api.group.saveMessage).not.toHaveBeenCalled()
    expect(read().messages).toHaveLength(0)
    expect(read().isStreaming).toBe(false)
  })

  it('阶段7：timeout 收口后到达的迟到 chunk/done/error 被忽略，不二次落盘', async () => {
    const group = makeGroup({ chatMode: 'polling' })
    const { get, set } = makeGroupGet(group, 's1')
    const callbacks = captureCallbacks()
    await streamGroupAI(set as any, get as any, group, 's1', makeCharacter('c1', '爱丽丝'), 1, () => {})
    const requestId = vi.mocked(window.api.ai.chat).mock.calls[0][0].requestId
    callbacks.onChunk!({ requestId, text: '她推开门，走进这个陌生的房间，指尖拂过积灰的桌面。然后她伸手拿' })
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1)
    await vi.advanceTimersByTimeAsync(10)
    expect(vi.mocked(window.api.group.saveMessage).mock.calls).toHaveLength(1)

    // 迟到事件：不得覆盖超时收口结果或二次落盘
    callbacks.onChunk!({ requestId, text: '迟到的尾巴。' })
    callbacks.onComplete!({ requestId, finishReason: 'stop' })
    callbacks.onError!({ requestId, error: 'late failure' })
    await vi.advanceTimersByTimeAsync(10)
    expect(vi.mocked(window.api.group.saveMessage).mock.calls).toHaveLength(1)
    const saved = vi.mocked(window.api.group.saveMessage).mock.calls[0][2] as GroupMessage
    expect(saved.content).toBe('她推开门，走进这个陌生的房间，指尖拂过积灰的桌面。')
  })

  /**
   * W0 冻结契约：群聊 done 事件的 finishReason 与单聊/Bridge 同口径
   * （provider_stop / provider_length / user_cancel / provider_content_filter），
   * 异常提示只进 generationNotice/generationError，绝不进入正文。
   */
  describe('finishReason 与 terminationCause 契约（W0 冻结）', () => {
    it('stop → 正文原样保存，无异常提示', async () => {
      resetTailRepairFailureCounts()
      const group = makeGroup({ chatMode: 'mention' })
      const { get, set, read } = makeGroupGet(group, 's1')
      const callbacks = captureCallbacks()
      await streamGroupAI(set as any, get as any, group, 's1', makeCharacter('c1', '爱丽丝'), 1, () => {})
      const requestId = vi.mocked(window.api.ai.chat).mock.calls[0][0].requestId

      callbacks.onChunk!({ requestId, text: '她说：“今晚的月色真美。”' })
      callbacks.onComplete!({ requestId, finishReason: 'stop' })
      await vi.advanceTimersByTimeAsync(10)

      const saved = vi.mocked(window.api.group.saveMessage).mock.calls.at(-1)?.[2] as GroupMessage
      expect(saved.content).toBe('她说：“今晚的月色真美。”')
      expect(saved.generationNotice).toBeUndefined()
      expect(saved.generationError).toBeUndefined()
      expect(read().isStreaming).toBe(false)
    })

    it('length + 稳定正文达到保留线 → 只在句界收束，不整条重生成、不补尾', async () => {
      resetTailRepairFailureCounts()
      const group = makeGroup({ chatMode: 'polling' })
      const { get, set } = makeGroupGet(group, 's1')
      const callbacks = captureCallbacks()
      await streamGroupAI(set as any, get as any, group, 's1', makeCharacter('c1', '爱丽丝'), 1, () => {})
      const requestId = vi.mocked(window.api.ai.chat).mock.calls[0][0].requestId

      callbacks.onChunk!({ requestId, text: '她推开门，走进这个陌生的房间，指尖拂过积灰的桌面。然后她伸手拿' })
      callbacks.onComplete!({ requestId, finishReason: 'length' })
      await vi.advanceTimersByTimeAsync(10)

      const saved = vi.mocked(window.api.group.saveMessage).mock.calls.at(-1)?.[2] as GroupMessage
      expect(saved.content).toBe('她推开门，走进这个陌生的房间，指尖拂过积灰的桌面。')
      expect(saved.generationNotice).toBe('内容已在完整句处收束')
      expect(saved.generationError).toBeUndefined()
      // provider_length 且稳定正文足够：只做边界收束，不发起补尾（无 stream=false 请求）
      expect(vi.mocked(window.api.ai.chat)).toHaveBeenCalledTimes(1)
      expect(saved.content).not.toContain('伸手拿')
    })

    it('length + 稳定正文过短 → 一次短补尾；失败时保留稳定前缀并提示', async () => {
      resetTailRepairFailureCounts()
      const group = makeGroup({ chatMode: 'polling' })
      const { get, set } = makeGroupGet(group, 's1')
      const callbacks = captureCallbacks()
      await streamGroupAI(set as any, get as any, group, 's1', makeCharacter('c1', '爱丽丝'), 1, () => {})
      const requestId = vi.mocked(window.api.ai.chat).mock.calls[0][0].requestId

      callbacks.onChunk!({ requestId, text: '她推开门。然后她伸手拿' })
      callbacks.onComplete!({ requestId, finishReason: 'length' })
      // 补尾请求在测试环境无独立响应：等 60s 兜底超时按失败处理，保留稳定前缀
      await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 100)

      const saved = vi.mocked(window.api.group.saveMessage).mock.calls.at(-1)?.[2] as GroupMessage
      expect(saved.content).toBe('她推开门。')
      expect(saved.generationError).toBe('生成中断，已保留完整部分')
      // 只发起一次非流式补尾，不整条重生成（流式主请求仍只有一次）
      const streamFlags = vi.mocked(window.api.ai.chat).mock.calls.map(
        (c) => (c[0] as { stream?: boolean }).stream,
      )
      expect(streamFlags.filter((flag) => flag === true)).toHaveLength(1)
      expect(streamFlags.filter((flag) => flag === false)).toHaveLength(1)
    })

    it('cancelled（用户停止）→ 保留已见正文，中性提示且不计为错误', async () => {
      resetTailRepairFailureCounts()
      const group = makeGroup({ chatMode: 'mention' })
      const { get, set } = makeGroupGet(group, 's1')
      const callbacks = captureCallbacks()
      await streamGroupAI(set as any, get as any, group, 's1', makeCharacter('c1', '爱丽丝'), 1, () => {})
      const requestId = vi.mocked(window.api.ai.chat).mock.calls[0][0].requestId

      callbacks.onChunk!({ requestId, text: '用户停止前看到的半句，还没写完' })
      callbacks.onComplete!({ requestId, finishReason: 'cancelled' })
      await vi.advanceTimersByTimeAsync(10)

      const saved = vi.mocked(window.api.group.saveMessage).mock.calls.at(-1)?.[2] as GroupMessage
      expect(saved.content).toBe('用户停止前看到的半句，还没写完')
      expect(saved.generationNotice).toBe('已停止生成')
      expect(saved.generationError).toBeUndefined()
    })

    it('content_filter → 不保存被拦截正文，占位回退为 (无回复)', async () => {
      resetTailRepairFailureCounts()
      const group = makeGroup({ chatMode: 'mention' })
      const { get, set } = makeGroupGet(group, 's1')
      const callbacks = captureCallbacks()
      await streamGroupAI(set as any, get as any, group, 's1', makeCharacter('c1', '爱丽丝'), 1, () => {})
      const requestId = vi.mocked(window.api.ai.chat).mock.calls[0][0].requestId

      callbacks.onChunk!({ requestId, text: '被拦截了一半的内容。' })
      callbacks.onComplete!({ requestId, finishReason: 'content_filter' })
      await vi.advanceTimersByTimeAsync(10)

      const saved = vi.mocked(window.api.group.saveMessage).mock.calls.at(-1)?.[2] as GroupMessage
      expect(saved.content).toBe('(无回复)')
      expect(saved.content).not.toContain('被拦截')
    })
  /**
   * W5（主计划 §7.7）：群聊接入同一门控与恢复控制器——
   * 空正文 + 推理挤占 → 降一档重发一次并复用同一消息；不重复其他角色已完成回合。
   */
  describe('降档恢复与单角色失败隔离（W5）', () => {
    it('推理挤占 → 降档重发复用同一消息，其他角色消息不变', async () => {
      // 开启门控（默认关闭）；gpt-4o 非 deepseek → 起步档 standard，可降到 low
      useSettingsStore.setState((state) => ({
        settings: { ...state.settings, reasoningGateEnabled: true, activeModel: 'gpt-4o' },
      } as never))
      const group = makeGroup({ chatMode: 'mention' })
      const { get, set, read } = makeGroupGet(group, 's1')
      // 其他角色已完成的历史回合：恢复过程不得触碰
      set((s: any) => ({
        messages: [{
          id: 'other-1', groupId: group.id, characterId: 'c2', content: '千夏已经说过的话。',
          images: [], timestamp: 1, round: 1, speakerKind: 'character',
        }],
      }))
      const callbacks = captureCallbacks()
      await streamGroupAI(set as any, get as any, group, 's1', makeCharacter('c1', '爱丽丝'), 1, () => {})

      const firstParams = vi.mocked(window.api.ai.chat).mock.calls[0][0]
      expect(firstParams.reasoningGate?.level).toBe('standard')

      // 第一次：推理挤占（零正文 + 结构化终局）
      callbacks.onComplete!({
        requestId: firstParams.requestId,
        finishReason: 'length',
        terminationCause: 'reasoning_gate_exceeded',
        earlyAbort: true,
      })
      await vi.advanceTimersByTimeAsync(10)

      // 不落盘 "(无回复)"，且没有第二条占位消息
      expect(window.api.group.saveMessage).not.toHaveBeenCalled()
      expect(read().messages.filter((m: any) => m.content === '')).toHaveLength(1)

      // 第二次：降档重发（新 requestId、档位 low）
      expect(vi.mocked(window.api.ai.chat)).toHaveBeenCalledTimes(2)
      const secondParams = vi.mocked(window.api.ai.chat).mock.calls[1][0]
      expect(secondParams.reasoningGate?.level).toBe('low')
      expect(secondParams.requestId).not.toBe(firstParams.requestId)

      callbacks.onChunk!({ requestId: secondParams.requestId, text: '港口已经封锁，任何人都不能通过。' })
      callbacks.onComplete!({ requestId: secondParams.requestId, finishReason: 'stop' })
      await vi.advanceTimersByTimeAsync(10)

      const saved = vi.mocked(window.api.group.saveMessage).mock.calls.at(-1)?.[2] as GroupMessage
      expect(saved.content).toBe('港口已经封锁，任何人都不能通过。')
      // 复用同一消息（占位被填充，无第二条空消息）
      expect(read().messages.filter((m: any) => m.content === '')).toHaveLength(0)
      // 其他角色已完成回合保持不变
      expect(read().messages.find((m: any) => m.id === 'other-1')?.content).toBe('千夏已经说过的话。')
    })
  })
  })
})

describe('checkAutoMemory 自动记忆触发', () => {
  it('记忆未启用或非 auto 模式时不触发', () => {
    const state = {
      sessions: [{ id: 's1', memoryEnabled: false, memoryMode: 'auto', autoMemoryInterval: 10, memoryUpdatedAt: 0 }],
      currentSessionId: 's1',
      messages: [],
      triggerMemorySummary: vi.fn(),
    }
    checkAutoMemory((() => state) as any)
    expect(state.triggerMemorySummary).not.toHaveBeenCalled()
  })

  it('新消息数达到间隔时触发摘要', () => {
    const trigger = vi.fn()
    const state = {
      sessions: [{ id: 's1', memoryEnabled: true, memoryMode: 'auto', autoMemoryInterval: 3, memoryUpdatedAt: 0 }],
      currentSessionId: 's1',
      messages: [
        { id: 'a', timestamp: 100 }, { id: 'b', timestamp: 200 }, { id: 'c', timestamp: 300 },
      ],
      triggerMemorySummary: trigger,
    }
    checkAutoMemory((() => state) as any)
    expect(trigger).toHaveBeenCalled()
  })

  it('新消息数不足时不触发', () => {
    const trigger = vi.fn()
    const state = {
      sessions: [{ id: 's1', memoryEnabled: true, memoryMode: 'auto', autoMemoryInterval: 10, memoryUpdatedAt: 0 }],
      currentSessionId: 's1',
      messages: [{ id: 'a', timestamp: 100 }, { id: 'b', timestamp: 200 }],
      triggerMemorySummary: trigger,
    }
    checkAutoMemory((() => state) as any)
    expect(trigger).not.toHaveBeenCalled()
  })
})

describe('checkPollingContinue polling 轮询', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    clearPollingTimer()
    vi.useRealTimers()
  })

  it('达到最大轮数时不继续', async () => {
    const set = vi.fn()
    const state = {
      currentGroup: makeGroup({ maxRounds: 1 }),
      messages: [
        { characterId: 'c1', round: 1 },
        { characterId: 'c2', round: 1 },
      ],
      memberIds: ['c1', 'c2'],
      sendPollingRound: vi.fn(),
    }
    await checkPollingContinue(set as any, (() => state) as any, makeGroup())
    expect(state.sendPollingRound).not.toHaveBeenCalled()
  })

  it('无最后角色消息时不继续', async () => {
    const set = vi.fn()
    const state = {
      currentGroup: makeGroup(),
      messages: [{ characterId: '__user__', round: 1 }],
      sendPollingRound: vi.fn(),
    }
    await checkPollingContinue(set as any, (() => state) as any, makeGroup())
    expect(state.sendPollingRound).not.toHaveBeenCalled()
  })

  it('正常时更新 speaker 并定时触发下一轮', async () => {
    const set = vi.fn()
    const sendPollingRound = vi.fn()
    const group = makeGroup({ currentSpeakerIndex: 0 })
    const state = {
      currentGroup: group,
      messages: [{ characterId: 'c1', round: 1 }],
      memberIds: ['c1', 'c2'],
      isStreaming: false,
      sendPollingRound,
    }
    await checkPollingContinue(set as any, (() => state) as any, group)

    // currentSpeakerIndex 更新为下一个成员
    expect(set).toHaveBeenCalledWith({ currentGroup: { ...group, currentSpeakerIndex: 1 } })
    // 优化：不再每轮全量持久化群组文件（currentSpeakerIndex 为纯运行时状态）
    expect(window.api.group.save).not.toHaveBeenCalled()

    // 定时器触发后发送下一轮
    await vi.advanceTimersByTimeAsync(2000)
    expect(sendPollingRound).toHaveBeenCalledWith('c2')
  })

  it('定时器触发时若正在流式则不继续', async () => {
    const set = vi.fn()
    const sendPollingRound = vi.fn()
    const group = makeGroup({ currentSpeakerIndex: 0 })
    const state = {
      currentGroup: group,
      messages: [{ characterId: 'c1', round: 1 }],
      memberIds: ['c1', 'c2'],
      isStreaming: true, // 流式中
      sendPollingRound,
    }
    await checkPollingContinue(set as any, (() => state) as any, group)
    await vi.advanceTimersByTimeAsync(2000)
    expect(sendPollingRound).not.toHaveBeenCalled()
  })
})

describe('流状态管理', () => {
  afterEach(() => {
    cleanupActiveStream()
    clearPollingTimer()
  })

  it('getActiveStream 初始为 null', () => {
    expect(getActiveStream()).toBeNull()
  })

  it('cleanupActiveStream 对空状态安全', () => {
    expect(() => cleanupActiveStream()).not.toThrow()
  })

  it('markPendingGroupCompression 记录压缩任务（get 为内部状态无法直读，验证不抛错）', () => {
    expect(() => markPendingGroupCompression({
      groupId: 'g1', sessionId: 's1', droppedText: 'x', droppedStartTs: 0, droppedEndTs: 1,
    })).not.toThrow()
  })
})
