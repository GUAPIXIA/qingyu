/**
 * S1 对照测试：Bridge 的 sendMessage / regenerate 与桌面端共用同一条收尾顺序
 * （推理清理 → output 正则 → 停止字符串 → 收尾器 → 一次短补尾），
 * 正则每条消息只执行一次，且结构被正则破坏时由收尾器兜底。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Message, RegexRule } from '../../../shared/types'

/** 测试替身连接参数：不是真实凭据，仅用于构造请求 */
const PLACEHOLDER_CREDENTIAL = 'unit-test-placeholder'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-bridge-finalize-test', getVersion: () => '0.12.0' },
  safeStorage: { isEncryptionAvailable: () => false },
}))

vi.mock('../../services/ai', () => ({
  chatWithRetry: vi.fn(),
  getAdapter: vi.fn().mockReturnValue({}),
}))
vi.mock('../sessionsIndex', () => ({ findSessionById: vi.fn() }))
vi.mock('../../context/mainContextProvider', () => ({
  mainContextProvider: { fetchBuildData: vi.fn() },
}))
vi.mock('../../ipc/chat', () => ({
  chatData: { saveMessage: vi.fn(), readMessages: vi.fn(() => []) },
}))
vi.mock('../dialogueDirections', () => ({
  generateBridgeDirections: vi.fn(async () => []),
}))
vi.mock('../../services/charCard', () => ({
  getCharacter: vi.fn(() => ({ id: 'char-1', name: '艾琳' })),
}))
vi.mock('../../../shared/chat-core/contextBuilder', () => ({
  buildContextMessagesFromData: vi.fn(() => ({
    messages: [{ role: 'user', content: '你好' }],
    narrativeMode: 'immersive',
    requestMaxTokens: 512,
    pipelineLegacy: false,
    // 阶段8：恢复重算预算需要本轮篇幅保护线（真实构建器总会返回）
    responsePolicy: { mode: 'balanced', hardMaxChars: 551 },
  })),
  buildChatParamsFromData: vi.fn(() => ({
    requestId: '',
    messages: [],
    provider: 'openai',
    apiKey: PLACEHOLDER_CREDENTIAL,
    baseUrl: 'https://api.example.com',
    model: 'gpt-4o',
    temperature: 0.8,
    topP: 0.95,
    maxTokens: 512,
    stream: true,
    // 阶段8：门控指令由统一预算反推（此处为 PC/Bridge 同口径的替身）
    reasoningGate: { level: 'standard' as const, knob: 'reasoning-effort' as const, tokens: 2048 },
    observability: { source: 'bridge' as const },
  })),
}))

import { chatWithRetry } from '../../services/ai'
import { findSessionById } from '../sessionsIndex'
import { mainContextProvider } from '../../context/mainContextProvider'
import { chatData } from '../../ipc/chat'
import { BridgeChatService } from '../chatService'

const CHARACTER = { id: 'char-1', name: '艾琳' } as any

function makeService() {
  return new BridgeChatService({ publish: vi.fn() } as any, () => {})
}

/** 构造一次 bridge 生成所需的 build data（正则规则随轮次传入） */
function makeBuildData(regexRules: RegexRule[]) {
  return {
    character: CHARACTER,
    regexRules,
    preset: null,
    messages: [],
    chat: { messages: [], sessions: [{ id: 's1', characterId: 'char-1' }], currentSessionId: 's1' },
    settings: {
      settings: { generationPipeline: 'unified', userName: '用户' },
      profile: { provider: 'openai', apiKey: PLACEHOLDER_CREDENTIAL, baseUrl: 'https://api.example.com', model: 'gpt-4o' },
    },
  } as any
}

/** 区分主生成与补尾请求：stream=false 的补尾请求返回 repairText */
function mockGeneration(mainText: string, finishReason: string, repairText = '她转身离开。') {
  vi.mocked(chatWithRetry).mockImplementation((async (_adapter: any, params: any, onChunk?: any) => {
    if (params.stream === false) return { text: repairText, finishReason: 'stop' }
    if (onChunk) onChunk(mainText)
    return { text: mainText, finishReason }
  }) as any)
}

function savedAiMessage(): Message | undefined {
  const calls = vi.mocked(chatData.saveMessage).mock.calls
  return calls.map((c) => c[1] as Message).find((m) => m.role === 'assistant')
}

describe('Bridge 收尾顺序（S1）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(findSessionById).mockResolvedValue({
      id: 's1', characterId: 'char-1', narrativeMode: 'immersive',
    } as any)
  })

  it('output 正则先于收尾器执行且只执行一次', async () => {
    const rule: RegexRule = {
      id: 'r1', name: '加空格', enabled: true, scope: 'output', pattern: 'A', replacement: 'A A', flags: 'g',
    }
    vi.mocked(mainContextProvider.fetchBuildData).mockResolvedValue(makeBuildData([rule]))
    mockGeneration('她A。', 'stop')

    await makeService().sendMessage('s1', 'req-1', '你好')

    expect(savedAiMessage()?.content).toBe('她A A。')
  })

  it('正则破坏结构后由收尾器兜底：补尾输入是正则处理后的文本', async () => {
    const rule: RegexRule = {
      id: 'r2', name: '去尾引号', enabled: true, scope: 'output', pattern: '”', replacement: '', flags: 'g',
    }
    vi.mocked(mainContextProvider.fetchBuildData).mockResolvedValue(makeBuildData([rule]))
    // 阶段7（§8.1）：自动补尾只对 provider_length 开放——本用例改为 length 触顶触发补尾
    mockGeneration('她说：“今天不去。”', 'length')

    await makeService().sendMessage('s1', 'req-2', '你好')

    // 收尾器在正则之后运行：正文被清理到稳定状态，而不是保存半截引号
    expect(savedAiMessage()?.content).toBe('她转身离开。')
    const repairCall = vi.mocked(chatWithRetry).mock.calls.find((c) => (c[1] as any).stream === false)
    expect(repairCall).toBeTruthy()
    const repairUserText = (repairCall![1] as any).messages[1].content as string
    expect(repairUserText).toContain('她说：“今天不去。')
    expect(repairUserText).not.toContain('今天不去。”')
  })

  it('sendMessage 与 regenerate 对同一输入得到相同正文与状态', async () => {
    const rule: RegexRule = {
      id: 'r3', name: '去尾引号', enabled: true, scope: 'output', pattern: '”', replacement: '', flags: 'g',
    }
    const data = makeBuildData([rule])
    vi.mocked(mainContextProvider.fetchBuildData).mockResolvedValue(data)
    // 阶段7（§8.1）：补尾只对 length 开放，两个入口都在 length 口径下对照
    mockGeneration('她说：“今天不去。”', 'length')

    const service = makeService()
    await service.sendMessage('s1', 'req-3', '你好')
    const fromSend = savedAiMessage()?.content

    const target: Message = {
      id: 'm1', sessionId: 's1', characterId: 'char-1', role: 'assistant',
      content: '旧候选', images: [], isEditing: false, timestamp: 1,
    }
    vi.mocked(chatData.readMessages).mockReturnValue([target])
    mockGeneration('她说：“今天不去。”', 'length')
    await service.swipe('s1', 'm1', 0)

    const fromRegenerate = savedAiMessage()?.content
    expect(fromRegenerate).toBe(fromSend)
    expect(fromRegenerate).toBe('她转身离开。')
  })

  it('用户停止（cancelled）保留已生成内容，不补尾不改写', async () => {
    vi.mocked(mainContextProvider.fetchBuildData).mockResolvedValue(makeBuildData([]))
    mockGeneration('用户停止前看到的半句，还没写完', 'cancelled')

    await makeService().sendMessage('s1', 'req-4', '你好')

    expect(savedAiMessage()?.content).toBe('用户停止前看到的半句，还没写完')
    expect(vi.mocked(chatWithRetry).mock.calls.some((c) => (c[1] as any).stream === false)).toBe(false)
  })

  it('阶段7：transport error 携带部分正文 → 统一收口保存稳定正文 + generationError，不落错误文案', async () => {
    vi.mocked(mainContextProvider.fetchBuildData).mockResolvedValue(makeBuildData([]))
    const publish = vi.fn()
    const service = new BridgeChatService({ publish } as any, () => {})
    vi.mocked(chatWithRetry).mockImplementation((async (_a: any, _p: any, onChunk?: any) => {
      onChunk?.('她推开门，走进这个陌生的房间，指尖拂过积灰的桌面。然后她伸手拿')
      throw new Error('socket hang up')
    }) as any)

    // 部分正文已收口落盘 → 请求按"已保留完整部分"正常返回，不再向上抛传输错误
    await expect(service.sendMessage('s1', 'req-5', '你好')).resolves.toBeTruthy()

    const saved = savedAiMessage()
    expect(saved?.content).toBe('她推开门，走进这个陌生的房间，指尖拂过积灰的桌面。')
    expect(saved?.generationError).toBe('生成中断，已保留完整部分')
    expect(saved?.content).not.toContain('hang up')
    // 安卓端以 ai:done 替换流式占位；不再另发 ai:error（避免占位状态与已保存消息二义）
    expect(publish.mock.calls.filter((c) => c[0] === 'ai:done')).toHaveLength(1)
    expect(publish.mock.calls.some((c) => c[0] === 'ai:error')).toBe(false)
  })

  it('阶段7：transport error 且无正文 → 不创建空 AI 消息，发 ai:error', async () => {
    vi.mocked(mainContextProvider.fetchBuildData).mockResolvedValue(makeBuildData([]))
    const publish = vi.fn()
    const service = new BridgeChatService({ publish } as any, () => {})
    vi.mocked(chatWithRetry).mockRejectedValue(new Error('socket hang up'))

    await expect(service.sendMessage('s1', 'req-6', '你好')).rejects.toThrow('socket hang up')
    expect(savedAiMessage()).toBeUndefined()
    expect(publish.mock.calls.some((c) => c[0] === 'ai:error')).toBe(true)
  })
})

/**
 * W5（主计划 §7.7）：Bridge 主对话接入同一降档恢复——空正文 + 提前中止 →
 * 降一档重发一次（复用同一请求快照，只按新档位重算预算）。
 */
describe('Bridge 降档恢复（W5）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(findSessionById).mockResolvedValue({
      id: 's1', characterId: 'char-1', narrativeMode: 'immersive',
    } as any)
  })

  it('提前中止且零正文 → 第二次物理调用档位降为 low 并标记降档重试', async () => {
    vi.mocked(mainContextProvider.fetchBuildData).mockResolvedValue(makeBuildData([]))
    const publish = vi.fn()
    const service = new BridgeChatService({ publish } as any, () => {})
    const calls: any[] = []
    vi.mocked(chatWithRetry).mockImplementation((async (_a: any, params: any, onChunk?: any) => {
      calls.push(params)
      if (calls.length === 1) {
        // 第一次：推理越线、正文为空（主进程结构化终局）
        return { text: '', finishReason: 'length', earlyAbort: true }
      }
      if (onChunk) onChunk('她推开门，走进这个陌生的房间。')
      return { text: '她推开门，走进这个陌生的房间。', finishReason: 'stop' }
    }) as any)

    await service.sendMessage('s1', 'req-w5-1', '你好')

    expect(calls).toHaveLength(2)
    expect(calls[0].reasoningGate?.level).toBe('standard')
    expect(calls[1].reasoningGate?.level).toBe('low')
    expect(calls[1].maxTokens).not.toBe(calls[0].maxTokens)
    expect(calls[1].observability?.downgradeRetry).toBe(true)
    expect(savedAiMessage()?.content).toBe('她推开门，走进这个陌生的房间。')
  })

  it('有正文的提前中止不触发恢复（只一次物理调用）', async () => {
    vi.mocked(mainContextProvider.fetchBuildData).mockResolvedValue(makeBuildData([]))
    const service = makeService()
    let callCount = 0
    vi.mocked(chatWithRetry).mockImplementation((async (_a: any, _p: any, onChunk?: any) => {
      callCount += 1
      if (onChunk) onChunk('她推开门，走进这个陌生的房间，指尖拂过积灰的桌面。')
      return { text: '她推开门，走进这个陌生的房间，指尖拂过积灰的桌面。', finishReason: 'stop' }
    }) as any)

    await service.sendMessage('s1', 'req-w5-2', '你好')
    expect(callCount).toBe(1)
    expect(savedAiMessage()?.content).toBe('她推开门，走进这个陌生的房间，指尖拂过积灰的桌面。')
  })
})

/**
 * W0 冻结契约：Bridge 的 ai:done.finishReason 必须与桌面端同口径
 * （stop / length / cancelled 原样透出），供安卓端与观测定性使用。
 */
describe('Bridge finishReason 与 terminationCause 契约（W0 冻结）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(findSessionById).mockResolvedValue({
      id: 's1', characterId: 'char-1', narrativeMode: 'immersive',
    } as any)
  })

  function donePayload(publish: ReturnType<typeof vi.fn>) {
    return publish.mock.calls.find((c) => c[0] === 'ai:done')?.[1] as { finishReason?: string } | undefined
  }

  it('stop → ai:done 携带 stop，正文原样且无补尾请求', async () => {
    vi.mocked(mainContextProvider.fetchBuildData).mockResolvedValue(makeBuildData([]))
    const publish = vi.fn()
    const service = new BridgeChatService({ publish } as any, () => {})
    mockGeneration('她说：“今晚的月色真美。”', 'stop')

    await service.sendMessage('s1', 'req-w0-stop', '你好')

    expect(donePayload(publish)?.finishReason).toBe('stop')
    expect(savedAiMessage()?.content).toBe('她说：“今晚的月色真美。”')
    expect(savedAiMessage()?.generationError).toBeUndefined()
    expect(vi.mocked(chatWithRetry).mock.calls.some((c) => (c[1] as any).stream === false)).toBe(false)
  })

  it('length → ai:done 携带 length，短稳定前缀触发一次非流式补尾', async () => {
    vi.mocked(mainContextProvider.fetchBuildData).mockResolvedValue(makeBuildData([]))
    const publish = vi.fn()
    const service = new BridgeChatService({ publish } as any, () => {})
    // 稳定前缀「她推开门。」不足保留线 → 触发一次短补尾；补尾返回合法续写
    mockGeneration('她推开门。然后她伸手拿', 'length', '她转身离开房间。')

    await service.sendMessage('s1', 'req-w0-length', '你好')

    expect(donePayload(publish)?.finishReason).toBe('length')
    const repairCalls = vi.mocked(chatWithRetry).mock.calls.filter((c) => (c[1] as any).stream === false)
    expect(repairCalls).toHaveLength(1)
    const saved = savedAiMessage()
    expect(saved?.content).toContain('她推开门。')
    expect(saved?.content).toContain('她转身离开房间。')
    expect(saved?.generationNotice).toBe('已自动补全结尾')
    expect(saved?.generationError).toBeUndefined()
  })

  it('cancelled（用户停止）→ ai:done 携带 cancelled，保留已见正文且不补尾', async () => {
    vi.mocked(mainContextProvider.fetchBuildData).mockResolvedValue(makeBuildData([]))
    const publish = vi.fn()
    const service = new BridgeChatService({ publish } as any, () => {})
    mockGeneration('用户停止前看到的半句，还没写完', 'cancelled')

    await service.sendMessage('s1', 'req-w0-cancel', '你好')

    expect(donePayload(publish)?.finishReason).toBe('cancelled')
    expect(savedAiMessage()?.content).toBe('用户停止前看到的半句，还没写完')
    expect(savedAiMessage()?.generationNotice).toBe('已停止生成')
    expect(vi.mocked(chatWithRetry).mock.calls.some((c) => (c[1] as any).stream === false)).toBe(false)
  })
})
