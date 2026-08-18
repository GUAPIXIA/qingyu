/**
 * 阶段 0b：防漂移快照测试（方案 §7 0b 验收）。
 *
 * 组装逻辑抽离为纯函数后最大红利是可测试：
 * - 取真实形状的会话样本，对组装输出做**深度对比快照断言**
 *   （system prompt、世界书注入、at_depth、记忆注入、预算裁剪、图片消息逐字段比对）；
 * - 两端一致性：渲染层 syncBuildData（mock store）与手工构造的等价数据，
 *   经同一 buildContextMessagesFromData 输出完全一致（防两端行为漂移）。
 *
 * 覆盖场景（方案 §7 0b 列举）：多世界书合并、at_depth 注入、正则管线不涉组装、
 * 记忆摘要注入、图片消息、无预设兜底、续写模式。
 */
import { describe, expect, it } from 'vitest'
import type {
  ContextBuildData,
  ContextChatSnapshot,
} from '../../../shared/contextTypes'
import type { Character, Lorebook, Message, Preset, Settings } from '../../../shared/types'
import { buildContextMessagesFromData, buildChatParamsFromData } from '../contextBuilder'

// ===== Fixture 构造 =====

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    activeProvider: 'openai',
    providers: {} as Settings['providers'],
    connectionProfiles: [
      {
        id: 'profile-01',
        name: '测试连接',
        provider: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        maxContext: 0,
        useInstructTemplate: false,
      },
    ],
    activeProfileId: 'profile-01',
    activeModel: 'gpt-4o-mini',
    activePresetId: 'preset-01',
    activeCharacterId: 'char-01',
    activeSessionId: 's1',
    theme: 'dark',
    themeColor: 'amber',
    fontSize: 'comfortable',
    fontSizeCustom: 16,
    bubbleStyle: 'round',
    messageSpacing: 4,
    messageWidth: 640,
    streamOutput: true,
    autoScroll: true,
    ttsEnabled: false,
    ttsModels: [],
    activeTTSModelId: null,
    imageGenModels: [],
    activeImageGenModelId: null,
    visionModels: [],
    activeVisionModelId: null,
    userName: '用户小明',
    userDescription: '喜欢科幻',
    userPersona: '理性冷静',
    activePersonaId: null,
    htmlRendering: false,
    showTokenCount: true,
    enableThoughtFormat: true,
    // 覆盖项
    ...overrides,
  }
}

function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: 'char-01',
    name: '艾琳',
    description: '一位来自未来的仿生人',
    personality: '温柔但坚定',
    scenario: '末日后的废土城市',
    systemPrompt: '你是艾琳。',
    firstMessage: '你好，我是艾琳。',
    exampleDialog: '你：你是谁？\n艾琳：我是艾琳，来自 2077 年。',
    postHistoryInstructions: '请记住：主角失忆了。',
    boundLorebookIds: ['lb-01', 'lb-02'],
    boundPresetId: 'preset-01',
    tags: [],
    lorebookId: null,
    creator: '',
    createdAt: 0,
    updatedAt: 0,
    alternateGreetings: [],
    avatar: '',
    cover: '',
    ...overrides,
  }
}

function makePreset(overrides: Partial<Preset> = {}): Preset {
  return {
    id: 'preset-01',
    name: '默认预设',
    description: '',
    systemPrompt: '',
    jailbreak: '不要重复用户的话。',
    maxContext: 16384,
    temperature: 0.9,
    topP: 0.9,
    maxTokens: 1024,
    frequencyPenalty: 0.3,
    presencePenalty: 0.2,
    isBuiltin: false,
    ...overrides,
  }
}

function makeLorebook(id: string, name: string, overrides: Partial<Lorebook> = {}): Lorebook {
  return {
    id,
    name,
    description: '',
    enabled: true,
    scanDepth: 6,
    entries: [
      {
        id: `${id}-e1`,
        keywords: ['废土', 'wasteland'],
        content: `${name}设定内容`,
        position: 'before_char',
        order: 1,
        probability: 100,
        enabled: true,
      },
      {
        id: `${id}-e2`,
        keywords: ['关键事件'],
        content: `${name}的 at_depth 注入内容`,
        position: 'at_depth',
        depth: 1,
        order: 2,
        probability: 100,
        enabled: true,
      },
    ],
    ...overrides,
  }
}

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: 'm1',
    sessionId: 's1',
    characterId: 'char-01',
    role: 'user',
    content: '今天废土上有沙尘暴。',
    images: [],
    isEditing: false,
    timestamp: 1720000000000,
    ...overrides,
  }
}

function makeChat(overrides: Partial<ContextChatSnapshot> = {}): ContextChatSnapshot {
  return {
    messages: [
      makeMessage({ id: 'm1', role: 'user', content: '今天废土上有沙尘暴。', timestamp: 1000 }),
      makeMessage({ id: 'm2', role: 'assistant', content: '是的，我们得找个避风处。', timestamp: 2000 }),
      makeMessage({ id: 'm3', role: 'user', content: '那栋大楼看起来安全。', timestamp: 3000 }),
    ],
    sessions: [
      {
        id: 's1',
        characterId: 'char-01',
        title: '废土之旅',
        createdAt: 0,
        updatedAt: 4000,
        memoryEnabled: true,
        memoryMode: 'auto',
        autoMemoryInterval: 10,
        memory: '两人正在寻找避难所',
        memoryUpdatedAt: 3500,
        memoryFacts: ['主角失忆', '目的地：绿洲城'],
        messageCount: 3,
        lastMessage: '那栋大楼看起来安全。',
      },
    ],
    currentSessionId: 's1',
    activeLorebookIds: ['lb-01', 'lb-02'],
    semanticFactsHits: [],
    semanticLoreHits: [],
    ...overrides,
  }
}

function makeData(overrides: Partial<ContextBuildData> = {}): ContextBuildData {
  return {
    character: makeCharacter(),
    preset: makePreset(),
    chat: makeChat(),
    settings: { settings: makeSettings(), profile: null },
    lorebooks: [makeLorebook('lb-01', '废土世界观'), makeLorebook('lb-02', '角色背景')],
    regexRules: [],
    ...overrides,
  }
}

// ===== 快照测试 =====

describe('buildContextMessagesFromData 防漂移快照', () => {
  it('预设可覆盖全局心理描写格式', () => {
    const disabled = buildContextMessagesFromData(makeData({
      preset: makePreset({ enableThoughtFormat: false }),
      settings: { settings: makeSettings({ enableThoughtFormat: true }), profile: null },
    }))
    expect(disabled.messages[0].content).not.toContain('<thought>')
    const enabled = buildContextMessagesFromData(makeData({
      preset: makePreset({ enableThoughtFormat: true }),
      settings: { settings: makeSettings({ enableThoughtFormat: false }), profile: null },
    }))
    expect(enabled.messages[0].content).toContain('<thought>')
  })

  it('基础场景：人设注入 + 世界书 before_char + 示例对话 + AN + 记忆摘要', () => {
    const data = makeData({
      settings: {
        settings: makeSettings({
          authorNote: { enabled: true, text: '{{user}}正在被监视。', position: 'top', depth: 0 },
        }),
        profile: {
          name: '测试连接',
          provider: 'openai',
          apiKey: 'sk-test',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o-mini',
          maxContext: 0,
          useInstructTemplate: false,
        },
      },
    })
    const result = buildContextMessagesFromData(data)
    // 深度快照：system prompt/世界书注入/示例对话/AN/历史/assistant prefix 逐字段锁定
    expect(result.messages).toMatchSnapshot('基础场景组装输出')
    expect(result.lastContextUsage.max).toBeGreaterThan(0)
    expect(result.pendingCompression).toBeUndefined()
  })

  it('多世界书合并 + at_depth 注入', () => {
    const data = makeData({
      chat: makeChat({
        activeLorebookIds: ['lb-01', 'lb-02'],
        // 命中 at_depth 条目关键词（'关键事件'），触发深度注入
        messages: [
          makeMessage({ id: 'm1', role: 'user', content: '关键事件发生了，废土震动。', timestamp: 1000 }),
          makeMessage({ id: 'm2', role: 'assistant', content: '我看到了。', timestamp: 2000 }),
        ],
      }),
    })
    const result = buildContextMessagesFromData(data)
    // 世界书 before_char 合并进角色设定；at_depth 条目注入历史段内
    const systemText = result.messages[0].content
    expect(systemText).toContain('废土世界观设定内容')
    expect(systemText).toContain('角色背景设定内容')
    // at_depth（depth=1）条目出现在历史消息之后（system 角色注入）
    const depthInserted = result.messages.find(
      (m) => m.role === 'system' && m.content.includes('at_depth 注入内容'),
    )
    expect(depthInserted).toBeDefined()
    expect(result.messages).toMatchSnapshot('多世界书 at_depth 组装输出')
  })

  it('时间线与关键事实注入', () => {
    const result = buildContextMessagesFromData(makeData())
    const systemText = result.messages[0].content
    expect(systemText).toContain('【对话时间线】')
    expect(systemText).toContain('两人正在寻找避难所')
    expect(systemText).toContain('【关键事实】')
    expect(systemText).toContain('主角失忆')
  })

  it('分层记忆按当前状态、事实、时间线的顺序注入', () => {
    const data = makeData({
      chat: makeChat({
        sessions: [{
          ...makeChat().sessions[0],
          memoryCurrentState: '当前在月落镇旅店，准备前往旧矿坑。',
          memory: '两人在森林相遇后抵达月落镇。',
          memoryFacts: ['矿坑地图由艾琳保管'],
        }],
      }),
    })
    const systemText = buildContextMessagesFromData(data).messages[0].content
    const stateIndex = systemText.indexOf('【当前状态】')
    const factsIndex = systemText.indexOf('【关键事实】')
    const timelineIndex = systemText.indexOf('【对话时间线】')
    expect(systemText).toContain('准备前往旧矿坑')
    expect(stateIndex).toBeGreaterThan(-1)
    expect(factsIndex).toBeGreaterThan(stateIndex)
    expect(timelineIndex).toBeGreaterThan(factsIndex)
  })

  it('存在时间线记忆时不重复注入早期压缩摘要', () => {
    const messages = Array.from({ length: 60 }, (_, index) => makeMessage({
      id: `m${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: '用于触发历史裁剪的长对话内容。'.repeat(16),
      timestamp: index * 1000,
    }))
    const data = makeData({
      preset: makePreset({ maxContext: 2048 }),
      chat: makeChat({
        messages,
        sessions: [{
          ...makeChat().sessions[0],
          memory: '完整时间线由长期记忆维护。',
          compressedSummary: '这段早期摘要不应与长期时间线重复注入。',
          compressedRange: { startTs: 0, endTs: 999999 },
        }],
      }),
    })
    const result = buildContextMessagesFromData(data)
    const allText = result.messages.map((message) => message.content).join('\n')
    expect(allText).toContain('完整时间线由长期记忆维护。')
    expect(allText).not.toContain('【早期对话压缩摘要】')
    expect(allText).not.toContain('这段早期摘要不应与长期时间线重复注入。')
  })

  it('语义命中优先于全量事实', () => {
    const data = makeData({
      chat: makeChat({
        semanticFactsHits: ['仅命中的事实A'],
      }),
    })
    const result = buildContextMessagesFromData(data)
    const systemText = result.messages[0].content
    expect(systemText).toContain('仅命中的事实A')
    expect(systemText).not.toContain('主角失忆')
  })

  it('图片消息保留（vision 用户消息）', () => {
    const data = makeData({
      chat: makeChat({
        messages: [
          makeMessage({ id: 'img1', role: 'user', content: '', images: ['data:image/png;base64,xxx'], timestamp: 100 }),
        ],
      }),
    })
    const result = buildContextMessagesFromData(data)
    const userMsg = result.messages.find((m) => m.role === 'user')
    expect(userMsg?.images).toEqual(['data:image/png;base64,xxx'])
    expect(result.messages).toMatchSnapshot('图片消息组装输出')
  })

  it('无预设兜底（默认 system prompt + 默认参数）', () => {
    const data = makeData({
      character: makeCharacter({ systemPrompt: '' }),
      preset: null,
    })
    const result = buildContextMessagesFromData(data)
    const systemText = result.messages[0].content
    expect(systemText).toContain('你是一个角色扮演助手')
    expect(result.lastContextUsage.max).toBeGreaterThan(0)
  })

  it('续写模式：注入续写指令且跳过 assistant prefix', () => {
    const data = makeData({
      chat: makeChat({
        messages: [
          makeMessage({ id: 'a', role: 'assistant', content: '半截回复…', timestamp: 100 }),
        ],
      }),
    })
    const result = buildContextMessagesFromData(data, { continuation: true })
    const last = result.messages[result.messages.length - 1]
    expect(last.role).toBe('user')
    expect(last.content).toContain('继续写作')
    // 无空 assistant prefix
    expect(result.messages.some((m) => m.role === 'assistant' && m.content === '')).toBe(false)
  })

  it('长历史触发上下文裁剪（不产生压缩任务但裁剪生效）', () => {
    const messages: Message[] = []
    for (let i = 0; i < 60; i++) {
      messages.push(
        makeMessage({
          id: `m${i}`,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `第 ${i} 条消息内容，包含一些较长的对话文本用于消耗 token 预算。`,
          timestamp: i * 1000,
        }),
      )
    }
    const data = makeData({
      preset: makePreset({ maxContext: 2048 }),
      chat: makeChat({
        messages,
        sessions: [
          {
            ...makeChat().sessions[0],
            memoryEnabled: false,
          },
        ],
      }),
    })
    const result = buildContextMessagesFromData(data)
    // 裁剪后历史数量显著小于原始 60 条
    const historyCount = result.messages.filter((m) => m.role === 'user' || m.role === 'assistant').length
    expect(historyCount).toBeLessThan(60)
    expect(historyCount).toBeGreaterThan(0)
  })
})

// ===== 两端一致性 =====

describe('两端一致性（同一 contextBuilder 入口）', () => {
  it('buildChatParamsFromData 从快照组装参数（无预设兜底）', () => {
    const data = makeData()
    const result = buildContextMessagesFromData(data)
    const params = buildChatParamsFromData(data, result.messages)
    expect(params.provider).toBe('openai')
    expect(params.model).toBe('gpt-4o-mini')
    expect(params.temperature).toBe(0.9)
    expect(params.maxTokens).toBe(1024)
    expect(params.stream).toBe(true)
    expect(params.messages).toEqual(result.messages)
  })

  it('无预设时参数回落默认值', () => {
    const data = makeData({ preset: null })
    const result = buildContextMessagesFromData(data)
    const params = buildChatParamsFromData(data, result.messages)
    expect(params.temperature).toBe(0.8)
    expect(params.maxTokens).toBe(1024)
  })
})
