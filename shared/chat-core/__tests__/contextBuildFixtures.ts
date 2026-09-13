/**
 * 共享测试 fixture（W7/W8 端到端用例共用）：按 `ContextBuildData` 真实形状构造单聊快照。
 *
 * 形状取自既有防漂移测试 `src/context/__tests__/contextBuilder.test.ts` 的已知good数据；
 * 本文件只服务测试，不含生产逻辑。
 */
import type { ContextBuildData, ContextChatSnapshot } from '../../../shared/contextTypes'
import type { Character, Lorebook, MemoryFact, Message, Preset, Settings } from '../../../shared/types'

export function makeSettings(overrides: Partial<Settings> = {}): Settings {
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
    ...overrides,
  }
}

export function makeCharacter(overrides: Partial<Character> = {}): Character {
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

export function makePreset(overrides: Partial<Preset> = {}): Preset {
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

export function makeLorebook(id: string, name: string, overrides: Partial<Lorebook> = {}): Lorebook {
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

export function makeMessage(overrides: Partial<Message>): Message {
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

export type { MemoryFact }

/** 结构化事实 fixture（默认 active，可直接放进 `session.memoryFacts`） */
export function makeFact(overrides: Partial<MemoryFact> & { id: string }): MemoryFact {
  return {
    subject: '主角',
    predicate: '状态',
    value: '失忆',
    status: 'active',
    importance: 3,
    confidence: 0.8,
    sourceMessageIds: [],
    updatedAt: 3000,
    ...overrides,
  }
}

export function makeChat(overrides: Partial<ContextChatSnapshot> = {}): ContextChatSnapshot {
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
        memoryCurrentState: '两人正在大楼门口躲避沙尘暴',
        memory: '两人正在寻找避难所',
        memoryUpdatedAt: 3500,
        memoryFacts: [
          {
            id: 'fact-1',
            subject: '主角',
            predicate: '状态',
            value: '失忆',
            status: 'active',
            importance: 5,
            confidence: 0.9,
            sourceMessageIds: ['m1'],
            updatedAt: 3500,
          },
          {
            id: 'fact-2',
            subject: '目的地',
            predicate: '名称',
            value: '绿洲城',
            status: 'active',
            importance: 3,
            confidence: 0.8,
            sourceMessageIds: ['m2'],
            updatedAt: 3000,
          },
        ],
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

export function makeData(overrides: Partial<ContextBuildData> = {}): ContextBuildData {
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

/** 构造数据里出现的可识别内容（不得出现在影子报告与日志串中） */
export const CONTENT_MARKERS = [
  '你是艾琳',
  '不要重复用户的话',
  '今天废土上有沙尘暴',
  '我们得找个避风处',
  '末日后的废土城市',
  '一位来自未来的仿生人',
  '温柔但坚定',
  '用户小明',
  '喜欢科幻',
  '理性冷静',
  '两人正在寻找避难所',
  '失忆',
  '绿洲城',
  '废土世界观设定内容',
  'sk-test',
  'api.openai.com',
]
