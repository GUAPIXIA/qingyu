/**
 * buildChatContext 核心逻辑单元测试（P-8）
 * 覆盖：系统提示组装 / 世界书位置注入 / at_depth 深度注入 / token 预算裁剪 /
 *       压缩标记与摘要注入 / 图片消息携带规则 / 续写模式 / assistant prefix / 示例对话 / 作者注释
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildChatContext } from '../chatContext'
import { markPendingCompression } from '../streamController'
import { useSettingsStore } from '../useSettingsStore'
import { getDefaultSettings } from '../../../shared/defaults'
import { lorebookCache } from '../../utils/lorebook'
import type { Character, Lorebook, Message, SessionPreview } from '../../../shared/types'

vi.mock('../streamController', () => ({
  markPendingCompression: vi.fn(),
}))

function makeChar(overrides: Partial<Character> = {}): Character {
  return {
    id: 'c1',
    name: '爱丽丝',
    description: '她是一位图书管理员',
    personality: '温柔耐心',
    scenario: '深夜的图书馆',
    firstMessage: '',
    exampleDialog: '',
    tags: [],
    lorebookId: null,
    creator: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    alternateGreetings: [],
    avatar: '',
    ...overrides,
  }
}

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    sessionId: 's1',
    characterId: 'c1',
    role: 'user',
    content: '你好',
    images: [],
    isEditing: false,
    timestamp: 1000,
    ...overrides,
  }
}

function makeLorebook(id: string, entry: Partial<import('../../../shared/types').LoreEntry> & { content: string; keywords: string[] }): Lorebook {
  return {
    id,
    name: `世界书-${id}`,
    description: '',
    enabled: true,
    scanDepth: 10,
    entries: [{
      id: `e-${id}`,
      content: entry.content,
      keywords: entry.keywords,
      position: entry.position ?? 'before_char',
      order: entry.order ?? 100,
      probability: entry.probability ?? 100,
      enabled: true,
    }],
  }
}

function makeSession(overrides: Partial<SessionPreview> = {}): SessionPreview {
  return {
    id: 's1',
    characterId: 'c1',
    title: '新对话 1',
    createdAt: 1000,
    updatedAt: 1000,
    memoryEnabled: false,
    memoryMode: 'manual',
    autoMemoryInterval: 10,
    memory: '',
    memoryUpdatedAt: 0,
    messageCount: 0,
    lastMessage: '',
    ...overrides,
  }
}

function makeGet(overrides: Partial<ReturnType<typeof baseGet>> = {}) {
  const state = { ...baseGet(), ...overrides }
  // 仅提供 buildChatContext 消费的字段子集，整体断言为 StoreGet
  return (() => state) as never
}

function baseGet() {
  return {
    messages: [] as Message[],
    sessions: [] as SessionPreview[],
    currentSessionId: 's1',
    activeLorebookIds: [] as string[],
    _semanticLoreHits: [],
    _semanticFactsHits: [],
  }
}

function setupSettings(overrides: Record<string, unknown> = {}) {
  useSettingsStore.setState({
    settings: {
      ...getDefaultSettings(),
      activeProfileId: 'p1',
      connectionProfiles: [
        { id: 'p1', name: 'test', provider: 'openai', apiKey: 'sk-test', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', maxContext: 0 },
      ],
      userName: '小明',
      ...overrides,
    },
  } as never)
}

describe('buildChatContext', () => {
  beforeEach(() => {
    lorebookCache.clear()
    vi.clearAllMocks()
    setupSettings()
  })

  it('系统提示包含角色设定 / 人设 / 心理描写格式要求', () => {
    const char = makeChar()
    const ctx = buildChatContext(makeGet(), vi.fn(), char, null)
    const system = ctx[0]
    expect(system.role).toBe('system')
    expect(system.content).toContain('【角色设定】')
    expect(system.content).toContain('她是一位图书管理员')
    expect(system.content).toContain('性格：温柔耐心')
    expect(system.content).toContain('【用户人设】')
    expect(system.content).toContain('用户名：小明')
    expect(system.content).toContain('<thought>')
  })

  it('世界书 before_char 触发：注入在角色设定之前', () => {
    lorebookCache.set('lb1', makeLorebook('lb1', { keywords: ['猫'], content: '猫娘是世界的瑰宝' }))
    const char = makeChar()
    const get = makeGet({
      activeLorebookIds: ['lb1'],
      // 注：单字 CJK 关键词要求命中处前后均为标点/边界（防误触发设计），需独立出现
      messages: [makeMsg({ id: 'm1', role: 'assistant', content: '我家的宠物：猫。' })],
    })
    const ctx = buildChatContext(get, vi.fn(), char, null)
    const system = ctx[0].content
    const lorePos = system.indexOf('猫娘是世界的瑰宝')
    const charTitlePos = system.indexOf('【角色设定】')
    const descPos = system.indexOf('她是一位图书管理员')
    expect(lorePos).toBeGreaterThan(-1)
    // before_char：位于【角色设定】标题之后、角色描述之前
    expect(lorePos).toBeGreaterThan(charTitlePos)
    expect(lorePos).toBeLessThan(descPos)
  })

  it('at_depth 世界书：depth 0 注入在最后一条历史消息之后', () => {
    lorebookCache.set('lb1', makeLorebook('lb1', { keywords: ['猫'], content: '深度注入内容', position: 'at_depth', depth: 0 }))
    const char = makeChar()
    const get = makeGet({
      activeLorebookIds: ['lb1'],
      messages: [
        makeMsg({ id: 'm1', role: 'user', content: '我家的宠物：猫。', timestamp: 1000 }),
        makeMsg({ id: 'm2', role: 'assistant', content: '真可爱', timestamp: 2000 }),
      ],
    })
    const ctx = buildChatContext(get, vi.fn(), char, null)
    // depth 0 = 对话末尾：注入在最后一条历史消息之后
    const lastAssistantIdx = ctx.map(c => c.content).lastIndexOf('真可爱')
    expect(lastAssistantIdx).toBeGreaterThan(-1)
    expect(ctx[lastAssistantIdx + 1].role).toBe('system')
    expect(ctx[lastAssistantIdx + 1].content).toContain('深度注入内容')
  })

  it('token 预算裁剪：超预算时裁掉早期历史并标记压缩', () => {
    const char = makeChar()
    const longText = '这是一条相当长的历史消息内容用来测试预算裁剪。'.repeat(8) // ≈ 208 字 ≈ 187 tokens
    const messages = Array.from({ length: 40 }, (_, i) =>
      makeMsg({ id: `m${i}`, role: i % 2 === 0 ? 'user' : 'assistant', content: longText, timestamp: 1000 + i }),
    )
    // 压缩标记需要当前会话存在（compression.enabled 且 currentSession 有值）
    const get = makeGet({ messages, sessions: [makeSession()] })
    const set = vi.fn()
    // maxContext 2000 → budgetBase ≈ max((2000-1024)*0.95, 500) = 927 tokens
    const ctx = buildChatContext(get, set, char, { id: 'pr1', name: 'P', description: '', systemPrompt: '', jailbreak: '', maxContext: 2000, temperature: 0.8, topP: 0.95, maxTokens: 1024, frequencyPenalty: 0, presencePenalty: 0, isBuiltin: false })
    // 保留的历史消息数应远小于 40
    const historyCount = ctx.filter(c => c.role === 'user' || c.role === 'assistant').length
    expect(historyCount).toBeLessThan(40)
    expect(historyCount).toBeGreaterThan(0)
    // 保留的是最新消息（最后一条在 context 中）
    expect(ctx.some(c => c.content === longText)).toBe(true)
    // 压缩任务已标记
    expect(markPendingCompression).toHaveBeenCalled()
    // lastContextUsage 已记录
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      lastContextUsage: expect.objectContaining({ used: expect.any(Number), max: expect.any(Number) }),
    }))
  })

  it('裁剪范围被压缩摘要覆盖时注入摘要而非重新标记', () => {
    const char = makeChar()
    const longText = '这是一条相当长的历史消息内容用来测试预算裁剪。'.repeat(8)
    const messages = Array.from({ length: 40 }, (_, i) =>
      makeMsg({ id: `m${i}`, role: i % 2 === 0 ? 'user' : 'assistant', content: longText, timestamp: 1000 + i }),
    )
    // 摘要覆盖全部范围：startTs 早于第一条，endTs 晚于最后一条
    const session = makeSession({
      compressedSummary: '之前他们在图书馆相遇并讨论了古书。',
      compressedRange: { startTs: 0, endTs: 999999 },
    })
    const get = makeGet({ messages, sessions: [session] })
    const ctx = buildChatContext(get, vi.fn(), char, { id: 'pr1', name: 'P', description: '', systemPrompt: '', jailbreak: '', maxContext: 2000, temperature: 0.8, topP: 0.95, maxTokens: 1024, frequencyPenalty: 0, presencePenalty: 0, isBuiltin: false })
    const systemMsgs = ctx.filter(c => c.role === 'system').map(c => c.content).join('\n')
    expect(systemMsgs).toContain('【早期对话压缩摘要】')
    expect(systemMsgs).toContain('之前他们在图书馆相遇并讨论了古书。')
    expect(markPendingCompression).not.toHaveBeenCalled()
  })

  it('图片消息：用户图片携带给模型，assistant 图片不回传', () => {
    const char = makeChar()
    const get = makeGet({
      messages: [
        makeMsg({ id: 'm1', role: 'user', content: '看这张图', images: ['data:image/png;base64,AAA'], timestamp: 1000 }),
        makeMsg({ id: 'm2', role: 'assistant', content: '收到', images: ['data:image/png;base64,BBB'], timestamp: 2000 }),
      ],
    })
    const ctx = buildChatContext(get, vi.fn(), char, null)
    const userMsg = ctx.find(c => c.role === 'user' && c.content === '看这张图')
    const assistantMsg = ctx.find(c => c.role === 'assistant' && c.content === '收到')
    expect(userMsg?.images).toEqual(['data:image/png;base64,AAA'])
    expect(assistantMsg?.images).toBeUndefined()
  })

  it('续写模式：注入续写指令且不添加空 assistant prefix', () => {
    const char = makeChar()
    const get = makeGet({
      messages: [
        makeMsg({ id: 'm1', role: 'user', content: '你好', timestamp: 1000 }),
        makeMsg({ id: 'm2', role: 'assistant', content: '你好呀', timestamp: 2000 }),
      ],
    })
    const ctx = buildChatContext(get, vi.fn(), char, null, { continuation: true })
    expect(ctx.some(c => c.content.includes('请直接接续上一段内容的结尾继续写作'))).toBe(true)
    // 末尾不应是空 assistant 消息
    const last = ctx[ctx.length - 1]
    expect(last.content).not.toBe('')
  })

  it('示例对话 after_system 模式注入', () => {
    const char = makeChar({ exampleDialog: '<START>\n{{user}}: 你好\n{{char}}: 晚上好' })
    setupSettings({ exampleDialogPosition: 'after_system', exampleDialogMode: 'always' })
    const ctx = buildChatContext(makeGet(), vi.fn(), char, null)
    // 连续 system 消息会被 mergeConsecutiveMessages 合并进首条系统提示
    expect(ctx[0].role).toBe('system')
    expect(ctx[0].content).toContain('【对话示例】')
  })

  it('作者注释 top 位置注入（keepSeparate 防止合并）', () => {
    const char = makeChar({
      authorNote: { enabled: true, text: '场景正在下雨', position: 'top', depth: 0 },
    })
    const ctx = buildChatContext(makeGet(), vi.fn(), char, null)
    const anMsg = ctx.find(c => c.content === '场景正在下雨')
    expect(anMsg).toBeDefined()
    expect(anMsg!.keepSeparate).toBe(true)
  })

  it('世界书 at_end 追加到系统提示末尾', () => {
    lorebookCache.set('lb1', makeLorebook('lb1', { keywords: ['雨'], content: '雨夜规则', position: 'at_end' }))
    const char = makeChar()
    const get = makeGet({
      activeLorebookIds: ['lb1'],
      // 单字关键词要求边界：独立出现可命中
      messages: [makeMsg({ id: 'm1', role: 'user', content: '天气：雨。' })],
    })
    const ctx = buildChatContext(get, vi.fn(), char, null)
    expect(ctx[0].content).toContain('雨夜规则')
  })
})
