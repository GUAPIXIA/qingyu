/**
 * 语义检索对实际对话的提升效果（端到端对比）：
 *
 * 同一世界书 + 同一对话，仅切换 semanticLoreHits（向量检索命中）与 semanticLoreAvailable，
 * 对比 buildContextMessagesFromData 最终注入上下文的差异：
 * - 语义条目只被向量召回（无关键词命中）→ 关闭检索时该条目完全缺席，对话缺失关键设定；
 * - 开启检索后条目进入角色设定段，且触发诊断显示 activationSource=vector、无 fallback；
 * - 开启检索但向量未召回 → 语义条目仍由本地词法兜底（vector_miss_lexical_fallback），
 *   上下文不受影响（无 embeddings 场景的降级保障）；
 * - 语义命中携带相似度参与统一评分排序（分数越高注入越靠前）；
 * - 语义命中不会挤掉关键词触发的条目（预算充足时全量注入）。
 */
import { describe, expect, it } from 'vitest'
import type { ContextBuildData, ContextChatSnapshot } from '../../../shared/contextTypes'
import type { Character, Lorebook, Message, Preset, Settings } from '../../../shared/types'
import { buildContextMessagesFromData } from '../contextBuilder'

// ===== Fixture 构造（与 contextBuilder.test.ts 一致） =====

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    activeProvider: 'openai',
    providers: {} as Settings['providers'],
    connectionProfiles: [
      {
        id: 'profile-01', name: '测试连接', provider: 'openai', apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', maxContext: 0,
        useInstructTemplate: false,
      },
    ],
    activeProfileId: 'profile-01',
    activeModel: 'gpt-4o-mini',
    activePresetId: 'preset-01',
    activeCharacterId: 'char-01',
    activeSessionId: 's1',
    theme: 'dark', themeColor: 'amber', fontSize: 'comfortable', fontSizeCustom: 16,
    bubbleStyle: 'round', messageSpacing: 4, messageWidth: 640,
    streamOutput: true, autoScroll: true,
    ttsEnabled: false, ttsModels: [], activeTTSModelId: null,
    imageGenModels: [], activeImageGenModelId: null,
    visionModels: [], activeVisionModelId: null,
    userName: '用户小明', userDescription: '喜欢科幻', userPersona: '理性冷静',
    activePersonaId: null, htmlRendering: false, showTokenCount: true, enableThoughtFormat: true,
    ...overrides,
  }
}

function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: 'char-01', name: '艾琳', description: '一位来自未来的仿生人', personality: '温柔但坚定',
    scenario: '末日后的废土城市', systemPrompt: '你是艾琳。', firstMessage: '你好，我是艾琳。',
    exampleDialog: '你：你是谁？\n艾琳：我是艾琳，来自 2077 年。', postHistoryInstructions: '请记住：主角失忆了。',
    boundLorebookIds: ['lb-01'], boundPresetId: 'preset-01', tags: [], lorebookId: null,
    creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [], avatar: '', cover: '',
    ...overrides,
  }
}

function makePreset(overrides: Partial<Preset> = {}): Preset {
  return {
    id: 'preset-01', name: '默认预设', description: '', systemPrompt: '', jailbreak: '不要重复用户的话。',
    maxContext: 16384, temperature: 0.9, topP: 0.9, maxTokens: 1024,
    frequencyPenalty: 0.3, presencePenalty: 0.2, isBuiltin: false,
    ...overrides,
  }
}

/** 对话世界书：一个关键词条目（关键词触发）+ 一个纯语义条目（无关键词，只能靠语义/词法召回） */
function makeDialogueLorebook(overrides: Partial<Lorebook> = {}): Lorebook {
  return {
    id: 'lb-01',
    name: '废土设定',
    description: '',
    enabled: true,
    scanDepth: 6,
    entries: [
      {
        id: 'lb-01-kw',
        keywords: ['沙尘暴'],
        content: '沙尘暴是废土最常见的灾害，能见度不足五米。',
        position: 'before_char',
        order: 1,
        probability: 100,
        enabled: true,
      },
      {
        id: 'lb-01-sem',
        keywords: [],
        // 语义条目：关键词为空，正文与对话无词面重叠 → 只能靠语义/词法通道召回
        content: '地下避难所位于旧城区废墟下方，入口伪装成坍塌的银行金库。',
        position: 'before_char',
        order: 2,
        probability: 100,
        enabled: true,
        matchMode: 'semantic',
      },
    ],
    ...overrides,
  }
}

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: 'm1', sessionId: 's1', characterId: 'char-01', role: 'user', content: '今天废土上有沙尘暴。',
    images: [], isEditing: false, timestamp: 1720000000000,
    ...overrides,
  }
}

function makeChat(overrides: Partial<ContextChatSnapshot> = {}): ContextChatSnapshot {
  return {
    messages: [
      makeMessage({ id: 'm1', role: 'user', content: '沙尘暴来了，我们得找个避风处。', timestamp: 1000 }),
      makeMessage({ id: 'm2', role: 'assistant', content: '附近有没有能躲的地方？', timestamp: 2000 }),
    ],
    sessions: [{
      id: 's1', characterId: 'char-01', title: '废土之旅', createdAt: 0, updatedAt: 4000,
      memoryEnabled: true, memoryMode: 'auto', autoMemoryInterval: 10,
      memory: '两人正在寻找避难所', memoryUpdatedAt: 3500,
      memoryFacts: ['主角失忆', '目的地：绿洲城'], messageCount: 2,
      lastMessage: '附近有没有能躲的地方？',
    }],
    currentSessionId: 's1',
    activeLorebookIds: ['lb-01'],
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
    lorebooks: [makeDialogueLorebook()],
    regexRules: [],
    ...overrides,
  }
}

/** 语义检索命中（向量召回）的避难所条目 */
const semanticHit = {
  content: '地下避难所位于旧城区废墟下方，入口伪装成坍塌的银行金库。',
  order: 2,
  position: 'before_char' as const,
  score: 0.72,
  key: 'lb-01:lb-01-sem',
}

/** 从角色设定段提取文本（before_character 注入 + charDesc） */
function extractCharacterSection(result: ReturnType<typeof buildContextMessagesFromData>): string {
  const systemMessage = result.messages[0]
  return systemMessage.content
}

describe('语义检索对对话的提升效果（端到端对比）', () => {
  /** 启用诊断（preview 稳定随机数） */
  const buildWithDiagnostics = (data: ContextBuildData) =>
    buildContextMessagesFromData(data, { lorebookDiagnosticsMode: 'preview' })

  it('关闭语义检索：纯语义条目完全缺席，对话缺失关键设定', () => {
    const result = buildWithDiagnostics(makeData({
      chat: makeChat({
        // 未启用/未配置 → semanticLoreAvailable=false，无语义命中
        semanticLoreAvailable: false,
        semanticLoreHits: [],
      }),
    }))
    const section = extractCharacterSection(result)
    // 关键词条目正常注入
    expect(section).toContain('沙尘暴是废土最常见的灾害')
    // 避难所设定缺席：对话无法得知避难所位置
    expect(section).not.toContain('地下避难所')
    // 诊断：语义条目未触发。semanticPreferred 无 embeddings 时由词法兜底，
    // 词法也未召回（对话无词面重叠）→ retrieval_miss（semantic_unavailable 仅限 semanticRequired）
    const detail = result.lorebookDiagnostics!.entries.find((e) => e.entryId === 'lb-01-sem')!
    expect(detail.outcome).toBe('not_triggered')
    expect(detail.reason).toBe('retrieval_miss')
  })

  it('开启语义检索：避难所条目进入上下文，对话获得关键信息', () => {
    const result = buildWithDiagnostics(makeData({
      chat: makeChat({
        semanticLoreAvailable: true,
        semanticLoreHits: [semanticHit],
      }),
    }))
    const section = extractCharacterSection(result)
    // 关键词条目 + 语义条目都注入
    expect(section).toContain('沙尘暴是废土最常见的灾害')
    expect(section).toContain('地下避难所位于旧城区废墟下方')
    // 诊断：语义条目由向量通道触发，无 fallback
    const detail = result.lorebookDiagnostics!.entries.find((e) => e.entryId === 'lb-01-sem')!
    expect(detail.outcome).toBe('injected')
    expect(detail.activationSource).toBe('vector')
    expect(detail.fallbackReason).toBeUndefined()
    expect(detail.vectorScore).toBe(0.72)
  })

  it('开启检索但向量未召回：本地词法兜底，上下文不丢失', () => {
    // 无 embeddings 场景：semanticLoreAvailable=true 但 hits 为空（向量未召回）。
    // 对话文本与避难所条目存在词面重叠（避难所/旧城区），词法 BM25 兜底召回。
    const result = buildWithDiagnostics(makeData({
      chat: makeChat({
        messages: [
          makeMessage({ id: 'm1', role: 'user', content: '沙尘暴来了，旧城区的避难所入口在哪？', timestamp: 1000 }),
          makeMessage({ id: 'm2', role: 'assistant', content: '我记得废墟下有个地下避难所。', timestamp: 2000 }),
        ],
        semanticLoreAvailable: true,
        semanticLoreHits: [],
      }),
    }))
    const section = extractCharacterSection(result)
    // 词法通道（BM25）兜底召回了避难所条目
    expect(section).toContain('地下避难所位于旧城区废墟下方')
    const detail = result.lorebookDiagnostics!.entries.find((e) => e.entryId === 'lb-01-sem')!
    expect(detail.outcome).toBe('injected')
    expect(detail.activationSource).toBe('lexical')
    expect(detail.fallbackReason).toBe('vector_miss_lexical_fallback')
  })

  it('语义命中分数参与排序：同 order 下相似度更高的条目注入更靠前', () => {
    // 两个语义条目 order 相同（都为 2），分数不同：高分的「避难所」应排在低分的「绿洲」前
    const lorebook = makeDialogueLorebook({
      entries: [
        {
          id: 'lb-01-kw',
          keywords: ['沙尘暴'],
          content: '沙尘暴是废土最常见的灾害，能见度不足五米。',
          position: 'before_char', order: 1, probability: 100, enabled: true,
        },
        {
          id: 'lb-01-sem',
          keywords: [],
          content: '地下避难所位于旧城区废墟下方，入口伪装成坍塌的银行金库。',
          position: 'before_char', order: 2, probability: 100, enabled: true, matchMode: 'semantic',
        },
        {
          id: 'lb-01-oasis',
          keywords: [],
          content: '绿洲城是废土上最后的自由都市，由太阳能穹顶庇护。',
          position: 'before_char', order: 2, probability: 100, enabled: true, matchMode: 'semantic',
        },
      ],
    })
    const result = buildWithDiagnostics(makeData({
      lorebooks: [lorebook],
      chat: makeChat({
        semanticLoreAvailable: true,
        semanticLoreHits: [
          { ...semanticHit, score: 0.72 },                    // 避难所：高分
          { content: '绿洲城是废土上最后的自由都市，由太阳能穹顶庇护。', order: 2, position: 'before_char', score: 0.45, key: 'lb-01:lb-01-oasis' }, // 绿洲：低分
        ],
      }),
    }))
    const section = extractCharacterSection(result)
    const shelterIndex = section.indexOf('地下避难所位于旧城区废墟下方')
    const oasisIndex = section.indexOf('绿洲城是废土上最后的自由都市')
    expect(shelterIndex).toBeGreaterThanOrEqual(0)
    expect(oasisIndex).toBeGreaterThanOrEqual(0)
    // 同 order（2）时按统一 score 降序：0.72 的避难所在 0.45 的绿洲之前
    expect(shelterIndex).toBeLessThan(oasisIndex)
  })

  it('预算充足时语义命中不挤掉关键词条目（两者共存）', () => {
    const result = buildWithDiagnostics(makeData({
      chat: makeChat({
        semanticLoreAvailable: true,
        semanticLoreHits: [semanticHit],
      }),
    }))
    const section = extractCharacterSection(result)
    expect(section).toContain('沙尘暴是废土最常见的灾害')
    expect(section).toContain('地下避难所位于旧城区废墟下方')
    // 两条都算入触发数
    expect(result.lorebookDiagnostics!.summary.injectedEntries).toBe(2)
  })

  it('提升效果对照：关闭 vs 开启语义检索的上下文差异（核心场景）', () => {
    // 对话：用户问避难所（关键词条目不触发，语义条目才能提供答案）
    const dialogue = makeChat({
      messages: [
        makeMessage({ id: 'm1', role: 'user', content: '沙尘暴来了，我们该躲到哪里？', timestamp: 1000 }),
        makeMessage({ id: 'm2', role: 'assistant', content: '我去找找有没有安全的地方。', timestamp: 2000 }),
      ],
      semanticLoreAvailable: false,
      semanticLoreHits: [],
    })
    const off = buildWithDiagnostics(makeData({ chat: dialogue }))
    const on = buildWithDiagnostics(makeData({
      chat: { ...dialogue, semanticLoreAvailable: true, semanticLoreHits: [semanticHit] },
    }))

    const offSection = extractCharacterSection(off)
    const onSection = extractCharacterSection(on)

    // 关闭：上下文只有沙尘暴灾害描述，没有避难所位置 → 模型无法回答"躲到哪里"
    expect(offSection).toContain('沙尘暴是废土最常见的灾害')
    expect(offSection).not.toContain('地下避难所')
    // 开启：避难所位置进入上下文 → 模型可据此回答
    expect(onSection).toContain('地下避难所位于旧城区废墟下方')
    // 语义诊断：候选数从 0 → 1
    expect(off.lorebookDiagnostics!.semantic.candidateCount).toBe(0)
    expect(on.lorebookDiagnostics!.semantic.candidateCount).toBe(1)
    // 同一对话，开启检索后上下文 token 增加（多注入一条设定）
    expect(on.lastContextUsage.used).toBeGreaterThan(off.lastContextUsage.used)
  })
})
