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
  it('按会话值注入全局叙事规则并报告实际模式', () => {
    const baseChat = makeChat()
    const result = buildContextMessagesFromData(makeData({
      chat: makeChat({
        sessions: [{ ...baseChat.sessions[0], narrativeMode: 'omniscient' }],
      }),
    }))

    expect(result.narrativeMode).toBe('omniscient')
    expect(result.messages[0].content).toContain('【叙事模式：全局叙事】')
    expect(result.messages[0].content).toContain('位于故事外部的第三人称旁白、导演和世界运行者')
    expect(result.messages[0].content).toContain('【第三人称旁白：硬性输出约束】')
    // 全局叙事也必须点名焦点角色，否则 thought 无法锁定第一人称主体
    expect(result.messages[0].content).toContain('当前焦点角色「艾琳」的第一人称内心独白')
    expect(result.messages[0].content).toContain('不要一次泄露所有人物')
    expect(result.messages[0].content).not.toContain('【叙事模式：代入式角色扮演】')
  })

  it('全局叙事模式使用身份页保存的自定义规则', () => {
    const baseChat = makeChat()
    const result = buildContextMessagesFromData(makeData({
      chat: makeChat({
        sessions: [{ ...baseChat.sessions[0], narrativeMode: 'omniscient' }],
      }),
      settings: {
        settings: makeSettings({
          omniscientNarrativeRules: '{{user}}作为观察者，由{{char}}统筹世界演化。',
        }),
        profile: null,
      },
    }))

    expect(result.messages[0].content).toContain('用户小明作为观察者，由艾琳统筹世界演化。')
    expect(result.messages[0].content).not.toContain('故事旁白、导演和世界运行者')
    expect(result.messages[0].content).toContain('正文主体必须使用第三人称叙事')
  })

  it('主回复不再注入游戏主持判定与选项格式', () => {
    const baseChat = makeChat()
    const enabled = buildContextMessagesFromData(makeData({
      chat: makeChat({
        sessions: [{ ...baseChat.sessions[0], narrativeMode: 'omniscient', dialogueDirectionsEnabled: true }],
      }),
    }))
    expect(enabled.messages[0].content).not.toContain('【呈现方式：游戏主持】')
    expect(enabled.messages[0].content).not.toContain('【可选行动】')
    expect(enabled.messages[0].content).not.toContain('【判定】')

    const immersive = buildContextMessagesFromData(makeData({
      chat: makeChat({
        sessions: [{ ...baseChat.sessions[0], narrativeMode: 'immersive', dialogueDirectionsEnabled: true }],
      }),
    }))
    expect(immersive.messages[0].content).not.toContain('【呈现方式：游戏主持】')
  })

  it('旧会话缺少模式字段时固定回退代入模式，不受后来默认值影响', () => {
    const result = buildContextMessagesFromData(makeData({
      character: makeCharacter({ defaultNarrativeMode: 'omniscient' }),
      settings: { settings: makeSettings({ defaultNarrativeMode: 'omniscient' }), profile: null },
    }))

    expect(result.narrativeMode).toBe('immersive')
    expect(result.messages[0].content).toContain('【叙事模式：代入式角色扮演】')
    expect(result.messages[0].content).not.toContain('【叙事模式：全局叙事】')
  })

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

  it('心理描写格式保持简短且禁止混入模型写作计划', () => {
    const result = buildContextMessagesFromData(makeData())
    const systemText = result.messages[0].content

    expect(systemText).toContain('每轮必须输出且只输出一组')
    expect(systemText).toContain('当前回应角色的第一人称')
    expect(systemText).toContain('不超过 3 句')
    expect(systemText).toContain('不得包含模型推理、写作计划、规则分析、上下文复述或正文草稿')
  })

  it('全局叙事正文保持第三人称，但 thought 是焦点角色第一人称内心独白', () => {
    const base = makeChat()
    const result = buildContextMessagesFromData(makeData({
      chat: makeChat({
        sessions: [{ ...base.sessions[0], narrativeMode: 'omniscient' }],
      }),
    }))
    const systemText = result.messages[0].content

    expect(systemText).toContain('正文仍保持第三人称叙事')
    expect(systemText).toContain('当前焦点角色「艾琳」的第一人称内心独白')
    expect(systemText).toContain('必须切换到 「艾琳」 自己的“我”来思考')
    expect(systemText).not.toContain('不得写成角色第一人称内心独白')
    // 同一条完整 system prompt 里，旁白护栏必须窄口径豁免 <thought>，
    // 否则护栏"以本约束为准"的优先级条款会反过来压制第一人称契约
    expect(systemText).toContain('【第三人称旁白：硬性输出约束】')
    expect(systemText).toContain('或 <thought>...</thought> 块内的角色内心独白')
    expect(systemText).not.toContain('不能成为回答的叙述视角')
  })

  it('在历史消息之后注入本轮回应范围与正文结构（阶段二语义停止规则）', () => {
    const data = makeData({ preset: makePreset({ responseLengthHint: 'balanced' }) })
    const result = buildContextMessagesFromData(data)
    const formatIndex = result.messages.findIndex((message) => message.content.includes('【本轮回应范围】'))
    const lastHistoryIndex = result.messages.reduce(
      (lastIndex, message, index) => message.content.includes('那栋大楼看起来安全') ? index : lastIndex,
      -1,
    )
    const formatText = result.messages[formatIndex]?.content ?? ''

    expect(formatIndex).toBeGreaterThan(lastHistoryIndex)
    // 一个互动回合的语义停止规则
    expect(formatText).toContain('只完成一个自然互动回合')
    expect(formatText).toContain('最多推进一个主要事件、信息或情绪变化')
    expect(formatText).toContain('不要连续代写下一轮')
    expect(formatText).toContain('接近篇幅上限时停止引入新信息')
    // 连续性约束（C1）：不得与最近对话矛盾或重复
    expect(formatText).toContain('不得与最近对话的既有事实、已完成动作或已说过的信息矛盾或重复')
    expect(formatText).toContain('新引入的信息要能从当前场景自然推出')
    // 篇幅来自 ResponsePolicy（balanced：120–360）
    expect(formatText).toContain('120–360 个可见字符')
    // 正文结构：无固定段落数、无强制对白、无星号协议
    expect(formatText).toContain('【正文结构】')
    expect(formatText).toContain('短回应可以只有一个段落')
    expect(formatText).toContain('不要为了排版重复角色名')
    expect(formatText).not.toContain('2–6 个短段落')
    expect(formatText).not.toContain('星号')
    expect(formatText).not.toContain('对白段落')
    expect(formatText).not.toContain('【正文排版协议】')
  })

  it('展开篇幅的回应范围允许推进两个主要事件', () => {
    const data = makeData({ preset: makePreset({ responseLengthHint: 'detailed' }) })
    const result = buildContextMessagesFromData(data)
    const formatText = result.messages.find((message) => message.content.includes('【本轮回应范围】'))?.content ?? ''
    expect(formatText).toContain('最多推进两个主要事件、信息或情绪变化')
    expect(formatText).toContain('300–700 个可见字符')
  })

  it('基础场景：人设注入 + 世界书 before_char + 示例对话 + AN + 记忆摘要', () => {
    const data = makeData({
      character: makeCharacter({
        authorNote: { enabled: true, text: '{{user}}正在被监视。', position: 'top', depth: 0 },
      }),
      settings: {
        settings: makeSettings(),
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

  it('canonical 特殊位置由统一 renderer 注入正确锚点', () => {
    const runtimeEntry = (
      id: string,
      content: string,
      insertion: NonNullable<Lorebook['entries'][number]['runtime']>['insertion'],
    ): Lorebook['entries'][number] => ({
      id,
      keywords: [],
      content,
      position: 'at_end',
      order: 1,
      probability: 100,
      enabled: true,
      priority: 'always',
      runtime: {
        insertion,
        retrieval: 'keyword',
        adapterId: 'sillytavern.world-info',
      },
    })
    const lorebook = makeLorebook('runtime-anchors', '特殊位置', {
      entries: [
        runtimeEntry('an-top', '世界书 AN 顶部', { kind: 'prompt', anchor: 'authors_note_top' }),
        runtimeEntry('before-example', '世界书示例前', { kind: 'prompt', anchor: 'before_examples' }),
        runtimeEntry('after-example', '世界书示例后', { kind: 'prompt', anchor: 'after_examples' }),
        runtimeEntry('an-bottom', '世界书 AN 底部', { kind: 'prompt', anchor: 'authors_note_bottom' }),
        runtimeEntry('outlet', '世界书命名出口', { kind: 'outlet', name: 'facts' }),
      ],
    })
    const data = makeData({
      chat: makeChat({ activeLorebookIds: [lorebook.id] }),
      lorebooks: [lorebook],
    })

    const result = buildContextMessagesFromData(data, { lorebookDiagnosticsMode: 'preview' })
    const indexOf = (text: string) => result.messages.findIndex((message) => message.content.includes(text))
    expect(result.messages[0].content).toContain('世界书命名出口')
    expect(indexOf('世界书 AN 顶部')).toBeGreaterThan(0)
    expect(indexOf('世界书示例前')).toBeLessThan(indexOf('【对话示例】'))
    expect(indexOf('世界书示例后')).toBeGreaterThan(indexOf('【对话示例】'))
    expect(indexOf('世界书 AN 底部')).toBeGreaterThan(indexOf('那栋大楼看起来安全'))
    expect(indexOf('世界书 AN 底部')).toBeLessThan(indexOf('请记住：主角失忆了'))
    expect(result.lorebookDiagnostics?.entries.find((entry) => entry.entryId === 'outlet')).toMatchObject({
      adapterId: 'sillytavern.world-info',
      renderStatus: 'fallback',
      renderTarget: 'outlet:facts → prompt_end',
    })
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
    expect(systemText).toContain('你是一个沉浸式互动叙事助手')
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

  it('续写可按目标消息覆盖当前会话模式，保持原叙事身份', () => {
    const data = makeData()
    data.chat.sessions[0].narrativeMode = 'immersive'

    const result = buildContextMessagesFromData(data, {
      continuation: true,
      narrativeMode: 'omniscient',
    })

    expect(result.narrativeMode).toBe('omniscient')
    expect(result.messages[0].content).toContain('【叙事模式：全局叙事】')
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
    const params = buildChatParamsFromData(data, result.messages, { requestMaxTokens: result.requestMaxTokens })
    expect(params.provider).toBe('openai')
    expect(params.model).toBe('gpt-4o-mini')
    expect(params.temperature).toBe(0.9)
    expect(params.stream).toBe(true)
    expect(params.messages).toEqual(result.messages)
  })

  it('无预设时参数回落默认值（篇幅策略 auto，无用户硬上限）', () => {
    const data = makeData({ preset: null })
    const result = buildContextMessagesFromData(data)
    const params = buildChatParamsFromData(data, result.messages, { requestMaxTokens: result.requestMaxTokens })
    expect(params.temperature).toBe(0.8)
    expect(params.maxTokens).toBe(result.requestMaxTokens)
    expect(params.maxTokens).toBeGreaterThan(0)
    expect(params.maxTokens).toBeLessThanOrEqual(8192)
  })

  it('上下文输出预留与请求 max_tokens 来自同一次计算（阶段一验收）', () => {
    const data = makeData()
    const result = buildContextMessagesFromData(data)
    // 预算明细与请求上限同源
    expect(result.requestMaxTokens).toBe(result.requestBudget.requestMaxTokens)
    expect(result.requestBudget.bodyReserve).toBeGreaterThan(0)
    // 上下文预算框架使用同一预留值：budgetBase = max((maxContext − reserved) × 0.95, 25% maxContext)
    const maxContext = 16384
    const expectedBase = Math.max(
      Math.floor((maxContext - result.requestMaxTokens) * 0.95),
      Math.floor(maxContext * 0.25),
    )
    expect(result.lastContextUsage.max).toBe(expectedBase)
  })

  it('篇幅提示驱动请求预算：balanced 正文预算 + 统一自动推理余量', () => {
    const data = makeData({
      preset: makePreset({ responseLengthHint: 'balanced', maxTokens: 8192 }),
    })
    const result = buildContextMessagesFromData(data)
    // bodyReserve = ceil(600 × 1.25) + 96 = 846；无样本时使用统一自动推理余量 2048
    expect(result.requestBudget.bodyReserve).toBe(846)
    expect(result.requestBudget.reasoningReserve).toBe(2048)
    expect(result.requestMaxTokens).toBe(2894)
    expect(result.responsePolicy.mode).toBe('balanced')
    expect(result.responsePolicy.source).toBe('preset')
  })

  it('模型名称不再改变动态预算数值', () => {
    const data = makeData({
      preset: makePreset({ responseLengthHint: 'balanced', maxTokens: 8192 }),
      settings: {
        settings: makeSettings({ activeModel: 'deepseek/deepseek-v4.1-flash' }),
        profile: {
          name: '测试连接',
          provider: 'openai',
          apiKey: 'sk-test',
          baseUrl: 'https://api.openai.com/v1',
          model: 'deepseek/deepseek-v4.1-flash',
          maxContext: 16384,
          useInstructTemplate: false,
        },
      },
    })
    const result = buildContextMessagesFromData(data)
    expect(result.requestBudget.reasoningReserve).toBe(2048)
    expect(result.requestMaxTokens).toBe(result.requestBudget.bodyReserve + result.requestBudget.reasoningReserve)
    expect(result.requestMaxTokens).toBeLessThan(8192)
    const params = buildChatParamsFromData(data, result.messages, { requestMaxTokens: result.requestMaxTokens })
    expect(params.maxTokens).toBe(result.requestMaxTokens)
  })

  it('旧 generationPipeline 标记不再切回旧预算管线', () => {
    const data = makeData({
      preset: makePreset({ maxTokens: 1024, responseLengthHint: 'balanced' }),
      settings: {
        settings: {
          ...makeSettings({ activeModel: 'deepseek/deepseek-v4.1-flash' }),
          generationPipeline: 'legacy',
        } as unknown as Settings,
        profile: null,
      },
    })
    const result = buildContextMessagesFromData(data)
    expect(result.messages.some((m) => m.content.includes('【正文排版协议】'))).toBe(false)
    expect(result.messages.some((m) => m.content.includes('【本轮回应范围】'))).toBe(true)
  })

  it('统一管线缺省不注入旧排版协议', () => {
    const data = makeData({ preset: makePreset({ responseLengthHint: 'balanced' }) })
    const result = buildContextMessagesFromData(data)
    expect(result.messages.some((m) => m.content.includes('【正文排版协议】'))).toBe(false)
  })

  it('用户硬上限（preset.maxTokens）始终生效，不静默放大', () => {
    const data = makeData({
      preset: makePreset({ responseLengthHint: 'balanced', maxTokens: 1024 }),
      settings: {
        settings: makeSettings({ activeModel: 'deepseek/deepseek-v4.1-flash' }),
        profile: {
          name: '测试连接',
          provider: 'openai',
          apiKey: 'sk-test',
          baseUrl: 'https://api.openai.com/v1',
          model: 'deepseek/deepseek-v4.1-flash',
          maxContext: 16384,
          useInstructTemplate: false,
        },
      },
    })
    const result = buildContextMessagesFromData(data)
    expect(result.requestMaxTokens).toBe(1024)
    // 推理余量被硬上限挤占 → 请求预算给出风险提示
    expect(result.requestBudget.riskNotice).toBe('user_cap_below_reasoning_reserve')
  })

  it('preset.maxTokens=0 表示自动，推理共享模型获得完整动态预算', () => {
    const data = makeData({
      preset: makePreset({ responseLengthHint: 'balanced', maxTokens: 0 }),
      settings: {
        settings: makeSettings({ activeModel: 'deepseek/deepseek-v4.1-flash' }),
        profile: {
          name: '测试连接',
          provider: 'openai',
          apiKey: 'sk-test',
          baseUrl: 'https://api.openai.com/v1',
          model: 'deepseek/deepseek-v4.1-flash',
          maxContext: 16384,
          useInstructTemplate: false,
        },
      },
    })
    const result = buildContextMessagesFromData(data)
    expect(result.requestMaxTokens).toBe(result.requestBudget.bodyReserve + result.requestBudget.reasoningReserve)
    expect(result.requestMaxTokens).toBeGreaterThan(2048)
    expect(result.requestBudget.riskNotice).toBeUndefined()
  })
})

describe('S5 用户篇幅意图与场景系数', () => {
  it('“一句话回答”优先于会话的“展开”设置，并同步改变请求预算', () => {
    const base = makeData({
      chat: makeChat({
        messages: [
          makeMessage({ id: 'm1', role: 'user', content: '我们出发吧。', timestamp: 1000 }),
          makeMessage({ id: 'm2', role: 'assistant', content: '好，我收拾一下。', timestamp: 2000 }),
          makeMessage({ id: 'm3', role: 'user', content: '用一句话回答：我们现在去哪？', timestamp: 3000 }),
        ],
        sessions: [{
          id: 's1', characterId: 'c1', title: '会话', messageCount: 3,
          responseLengthMode: 'detailed', createdAt: 0, updatedAt: 0,
        } as any],
      }),
    })
    const result = buildContextMessagesFromData(base)
    expect(result.responsePolicy.mode).toBe('brief')
    expect(result.responsePolicy.source).toBe('user')
    expect(result.responseIntent).toBe('brief')
    // 上下文预留与实际请求仍来自同一次预算计算
    const params = buildChatParamsFromData(base, result.messages, { requestMaxTokens: result.requestMaxTokens })
    expect(params.maxTokens).toBe(result.requestMaxTokens)
    expect(result.requestBudget.bodyReserve).toBe(Math.ceil(260 * 1.25) + 96)
  })

  it('普通内容不误触发意图，自动模式按场景系数调整', () => {
    const ordinary = buildContextMessagesFromData(makeData({
      chat: makeChat({
        messages: [
          makeMessage({ id: 'm1', role: 'user', content: '今天路上很安静。', timestamp: 1000 }),
          makeMessage({ id: 'm2', role: 'assistant', content: '是啊，连风都停了。', timestamp: 2000 }),
          makeMessage({ id: 'm3', role: 'user', content: '前面好像有人。', timestamp: 3000 }),
        ],
      }),
    }))
    expect(ordinary.responseIntent).toBeNull()
    expect(ordinary.responsePolicy.mode).toBe('auto')
    expect(ordinary.sceneFactor).toBe(1)

    const openingData = makeData({
      chat: makeChat({
        messages: [makeMessage({ id: 'm1', role: 'user', content: '你好，请问这里是哪里？', timestamp: 1000 })],
      }),
    })
    const opening = buildContextMessagesFromData(openingData)
    // 首轮开场：无助手回复 → 放大系数
    expect(opening.sceneFactor).toBe(1.15)
    expect(buildChatParamsFromData(openingData, opening.messages, { requestMaxTokens: opening.requestMaxTokens })
      .observability?.sceneFactor).toBe(1.15)
  })

  it('观测元数据记录意图，未识别时不下发该字段', () => {
    const data = makeData({
      chat: makeChat({
        messages: [
          makeMessage({ id: 'm1', role: 'user', content: '详细说说这里的历史。', timestamp: 1000 }),
          makeMessage({ id: 'm2', role: 'assistant', content: '很久以前……', timestamp: 2000 }),
        ],
      }),
    })
    const result = buildContextMessagesFromData(data)
    const params = buildChatParamsFromData(data, result.messages, { requestMaxTokens: result.requestMaxTokens })
    expect(params.observability?.responseIntent).toBe('detailed')
    expect(result.responsePolicy.mode).toBe('detailed')
  })
})

describe('generationError 不进入上下文（R2）', () => {
  it('历史构建只读 content，中断原因不混入消息序列', () => {
    const chat = makeChat({
      messages: [
        makeMessage({ id: 'm1', role: 'user', content: '今天废土上有沙尘暴。', timestamp: 1000 }),
        makeMessage({
          id: 'm2',
          role: 'assistant',
          content: '是的，我们得找个避风处。',
          timestamp: 2000,
          generationError: '模型输出达到长度上限',
        }),
        makeMessage({ id: 'm3', role: 'user', content: '那栋大楼看起来安全。', timestamp: 3000 }),
      ],
    })
    const result = buildContextMessagesFromData(makeData({ chat }))
    const flattened = JSON.stringify(result.messages)
    expect(flattened).toContain('是的，我们得找个避风处。')
    expect(flattened).not.toContain('模型输出达到长度上限')
  })
})
