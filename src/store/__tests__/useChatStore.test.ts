import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useChatStore } from '../useChatStore'
import { useSettingsStore } from '../useSettingsStore'
import { usePersonaStore } from '../usePersonaStore'
import { useCharacterStore } from '../useCharacterStore'
import { getDefaultSettings } from '../../../shared/defaults'
import { semanticCacheGet, semanticCacheSet } from '../chatUtils'
import type { Character, Message, Persona, SessionPreview } from '../../../shared/types'

function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: 'c1',
    name: '测试角色',
    description: '她是图书馆的管理员',
    personality: '温柔',
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

function makeMessage(overrides: Partial<Message> = {}): Message {
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

function makePersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: 'p1',
    name: '测试用户',
    description: '一名冒险者',
    persona: '勇敢',
    avatar: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function resetStores() {
  useChatStore.setState({
    messages: [],
    sessions: [],
    currentSessionId: null,
    isStreaming: false,
    currentRequestId: null,
    error: null,
    activePresetId: null,
    activeLorebookIds: [],
    _semanticLoreHits: [],
    _semanticFactsHits: [],
    lastContextUsage: null,
    translatingMessages: {},
    showTranslationIds: new Set(),
  })
  useSettingsStore.setState({
    settings: getDefaultSettings(),
    credentials: {},
    loaded: true,
    _saveTimer: null,
  })
  usePersonaStore.setState({ personas: [], loaded: true })
  useCharacterStore.setState({ characters: [] })
  vi.clearAllMocks()
}

describe('useChatStore', () => {
  beforeEach(resetStores)

  describe('initial state', () => {
    it('has empty collections and no active session', () => {
      const s = useChatStore.getState()
      expect(s.messages).toEqual([])
      expect(s.sessions).toEqual([])
      expect(s.currentSessionId).toBeNull()
      expect(s.isStreaming).toBe(false)
      expect(s.error).toBeNull()
    })

    it('has all required methods', () => {
      const s = useChatStore.getState()
      for (const m of ['loadSessions', 'createSession', 'switchSession', 'deleteSession', 'renameSession',
        'loadMessages', 'sendMessage', 'stopStreaming', 'regenerateMessage', 'continueMessage',
        'editMessage', 'deleteMessage', 'clearChat', 'clearMessages', 'buildContext',
        'translateMessage', 'toggleTranslation', 'createSessionWithGreeting']) {
        expect(typeof s[m as keyof typeof s]).toBe('function')
      }
    })
  })

  describe('clearMessages', () => {
    it('resets messages only', () => {
      useChatStore.setState({ messages: [makeMessage()] })
      useChatStore.getState().clearMessages()
      expect(useChatStore.getState().messages).toEqual([])
    })
  })

  describe('loadMessages 首条消息', () => {
    it('有译文时优先注入译文首条消息，且不覆盖角色卡原文', async () => {
      const character = makeCharacter({
        firstMessage: 'Hello, adventurer!',
        translatedContent: { firstMessage: '你好，冒险者！' },
      })
      useChatStore.setState({
        currentSessionId: 's1',
        sessions: [{ id: 's1', characterId: 'c1', title: 't', createdAt: 0, updatedAt: 0, memoryEnabled: false, memoryMode: 'manual', autoMemoryInterval: 0, memory: '', memoryUpdatedAt: 0, messageCount: 0, lastMessage: '' } as SessionPreview],
      })
      vi.mocked(window.api.chat.listMessages).mockResolvedValue([])

      await useChatStore.getState().loadMessages(character)

      const msgs = useChatStore.getState().messages
      expect(msgs).toHaveLength(1)
      expect(msgs[0].content).toContain('你好，冒险者！')
      // 核心：翻译不覆盖原卡信息
      expect(character.firstMessage).toBe('Hello, adventurer!')
      expect(character.translatedContent?.firstMessage).toBe('你好，冒险者！')
    })
  })

  describe('createSession', () => {
    it('creates a session and syncs the bound persona to settings', async () => {
      // 默认身份 p1
      useSettingsStore.setState({
        settings: { ...getDefaultSettings(), defaultPersonaId: 'p1' },
      })
      usePersonaStore.setState({ personas: [makePersona()], loaded: true })
      // mock 后端返回绑定 p1 的会话
      const persona = makePersona()
      vi.mocked(window.api.chat.createSession).mockResolvedValue({
        id: 's-new', characterId: 'c1', title: '新对话 1',
        personaId: 'p1',
        createdAt: Date.now(), updatedAt: Date.now(),
      } as any)
      vi.mocked(window.api.chat.listSessions).mockResolvedValue([])

      await useChatStore.getState().createSession('c1')

      // 身份同步到 settings(修复 #: 新会话绑定默认身份后立即生效)
      const settings = useSettingsStore.getState().settings
      expect(settings.activePersonaId).toBe('p1')
      expect(settings.userName).toBe(persona.name)
      expect(settings.userDescription).toBe(persona.description)
      expect(settings.userPersona).toBe(persona.persona)
    })

    it('does not touch persona settings when session has no persona', async () => {
      useSettingsStore.setState({ settings: { ...getDefaultSettings(), userName: '保留名' } })
      vi.mocked(window.api.chat.createSession).mockResolvedValue({
        id: 's-new', characterId: 'c1', title: '新对话 1',
        createdAt: Date.now(), updatedAt: Date.now(),
      } as any)
      vi.mocked(window.api.chat.listSessions).mockResolvedValue([])

      await useChatStore.getState().createSession('c1')
      expect(useSettingsStore.getState().settings.userName).toBe('保留名')
    })
  })

  describe('switchSession', () => {
    const sessions: SessionPreview[] = [
      { id: 's1', characterId: 'c1', title: '会话1', createdAt: 1, updatedAt: 2, personaId: 'p1' } as SessionPreview,
      { id: 's2', characterId: 'c1', title: '会话2', createdAt: 1, updatedAt: 2, personaId: undefined } as SessionPreview,
    ]

    it('switches to session and syncs its persona', async () => {
      usePersonaStore.setState({ personas: [makePersona()], loaded: true })
      useChatStore.setState({ sessions })
      vi.mocked(window.api.chat.listMessages).mockResolvedValue([])

      await useChatStore.getState().switchSession('s1', makeCharacter())

      const settings = useSettingsStore.getState().settings
      expect(settings.activePersonaId).toBe('p1')
      expect(settings.userName).toBe('测试用户')
    })

    it('falls back to default persona when session has none', async () => {
      useSettingsStore.setState({
        settings: { ...getDefaultSettings(), defaultPersonaId: 'p1' },
      })
      usePersonaStore.setState({ personas: [makePersona()], loaded: true })
      useChatStore.setState({ sessions })
      vi.mocked(window.api.chat.listMessages).mockResolvedValue([])

      await useChatStore.getState().switchSession('s2', makeCharacter())

      const settings = useSettingsStore.getState().settings
      expect(settings.activePersonaId).toBe('p1')
      expect(settings.userName).toBe('测试用户')
    })

    it('resets to plain user when no persona and no default', async () => {
      useChatStore.setState({ sessions })
      vi.mocked(window.api.chat.listMessages).mockResolvedValue([])

      await useChatStore.getState().switchSession('s2', makeCharacter())

      const settings = useSettingsStore.getState().settings
      expect(settings.activePersonaId).toBeNull()
      expect(settings.userName).toBe('用户')
    })
  })

  describe('loadSessions', () => {
    it('loads sessions and syncs the current session persona', async () => {
      vi.mocked(window.api.chat.listSessions).mockResolvedValue([
        { id: 's1', characterId: 'c1', title: '会话1', createdAt: 1, updatedAt: 2, personaId: 'p1' } as SessionPreview,
      ])
      usePersonaStore.setState({ personas: [makePersona()], loaded: true })

      await useChatStore.getState().loadSessions('c1')

      const settings = useSettingsStore.getState().settings
      expect(useChatStore.getState().currentSessionId).toBe('s1')
      expect(settings.activePersonaId).toBe('p1')
      expect(settings.userName).toBe('测试用户')
    })
  })

  describe('buildContext', () => {
    it('injects character settings, persona and history', () => {
      useSettingsStore.setState({
        settings: { ...getDefaultSettings(), userName: '小明' },
      })
      useChatStore.setState({
        currentSessionId: 's1',
        sessions: [{ id: 's1', characterId: 'c1', title: 't', createdAt: 0, updatedAt: 0 } as SessionPreview],
        messages: [makeMessage({ content: '晚上好' })],
      })
      const char = makeCharacter()

      const ctx = useChatStore.getState().buildContext(char, null)
      const system = ctx.find(m => m.role === 'system')
      const joined = system?.content ?? ''

      // 角色设定注入
      expect(joined).toContain('图书馆的管理员')
      expect(joined).toContain('温柔')
      expect(joined).toContain('深夜的图书馆')
      // 用户人设注入(默认 position=system)
      expect(joined).toContain('小明')
      // 历史消息保留
      expect(ctx.some(m => m.role === 'user' && m.content === '晚上好')).toBe(true)
    })

    it('replaces {{user}} variable with current user name', () => {
      useSettingsStore.setState({
        settings: { ...getDefaultSettings(), userName: '冒险家' },
      })
      useChatStore.setState({
        currentSessionId: 's1',
        sessions: [{ id: 's1', characterId: 'c1', title: 't', createdAt: 0, updatedAt: 0 } as SessionPreview],
        messages: [makeMessage({ content: '你好' })],
      })
      const char = makeCharacter({
        systemPrompt: '你是{{char}}。玩家叫{{user}}。',
        description: '',
        personality: '',
        scenario: '',
      })

      const ctx = useChatStore.getState().buildContext(char, null)
      const system = ctx.find(m => m.role === 'system')
      expect(system?.content).toContain('你是测试角色。玩家叫冒险家。')
    })

    it('adds continuation instruction in continuation mode', () => {
      useChatStore.setState({
        currentSessionId: 's1',
        sessions: [{ id: 's1', characterId: 'c1', title: 't', createdAt: 0, updatedAt: 0 } as SessionPreview],
        messages: [makeMessage()],
      })
      const ctx = useChatStore.getState().buildContext(makeCharacter(), null, { continuation: true })
      expect(ctx.some(m => m.role === 'user' && m.content.includes('续写'))).toBe(true)
    })

    it('records lastContextUsage', () => {
      useChatStore.setState({
        currentSessionId: 's1',
        sessions: [{ id: 's1', characterId: 'c1', title: 't', createdAt: 0, updatedAt: 0 } as SessionPreview],
        messages: [makeMessage()],
      })
      useChatStore.getState().buildContext(makeCharacter(), null)
      const usage = useChatStore.getState().lastContextUsage
      expect(usage).not.toBeNull()
      expect(usage!.used).toBeGreaterThan(0)
      expect(usage!.max).toBeGreaterThan(0)
    })
  })

  describe('semantic cache (chatUtils)', () => {
    it('returns cached value within TTL', () => {
      semanticCacheSet('k1', [{ id: 'x' }])
      const hit = semanticCacheGet<{ id: string }[]>('k1')
      expect(hit).toEqual([{ id: 'x' }])
    })

    it('returns null for unknown key', () => {
      expect(semanticCacheGet('nope')).toBeNull()
    })
  })

  describe('translateMessage', () => {
    it('翻译完成后自动把消息加入 showTranslationIds 并写入译文', async () => {
      let chunkCb: any, doneCb: any
      vi.mocked(window.api.ai.onChunk).mockImplementation((cb: any) => { chunkCb = cb; return () => {} })
      vi.mocked(window.api.ai.onDone).mockImplementation((cb: any) => { doneCb = cb; return () => {} })

      useSettingsStore.setState({
        settings: {
          ...getDefaultSettings(),
          activeProfileId: 'p1',
          activeModel: 'gpt-4o',
          connectionProfiles: [
            { id: 'p1', name: 'test', provider: 'openai', apiKey: 'sk-test', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', maxContext: 0 },
          ],
        } as any,
      })
      useChatStore.setState({
        currentSessionId: 's1',
        messages: [makeMessage({ id: 'm1', role: 'assistant', content: 'Hello world' })],
        translatingMessages: {},
        showTranslationIds: new Set(),
      } as any)

      // 从 store 直接发起翻译（不手动 toggle），模拟翻译完成后自动显示
      useChatStore.getState().translateMessage('m1', 'Hello world')

      const chatCall = vi.mocked(window.api.ai.chat).mock.calls[0] as any
      const requestId = chatCall[0].requestId
      chunkCb({ requestId, text: '你好' })
      chunkCb({ requestId, text: '世界' })
      doneCb(requestId)

      const final = useChatStore.getState()
      expect(final.translatingMessages['m1']?.status).toBe('done')
      expect(final.translatingMessages['m1']?.content).toBe('你好世界')
      expect(final.showTranslationIds.has('m1')).toBe(true)
      expect(final.messages[0].translation).toBe('你好世界')
    })

    it('翻译结果为空时不落库空译文、不自动切显示，并提示错误', async () => {
      let chunkCb: any, doneCb: any
      vi.mocked(window.api.ai.onChunk).mockImplementation((cb: any) => { chunkCb = cb; return () => {} })
      vi.mocked(window.api.ai.onDone).mockImplementation((cb: any) => { doneCb = cb; return () => {} })

      useSettingsStore.setState({
        settings: {
          ...getDefaultSettings(),
          activeProfileId: 'p1',
          activeModel: 'deepseek-v4-pro',
          connectionProfiles: [
            { id: 'p1', name: 'test', provider: 'openai', apiKey: 'sk-test', baseUrl: 'https://api.openai.com/v1', model: 'deepseek-v4-pro', maxContext: 0 },
          ],
        } as any,
      })
      useChatStore.setState({
        currentSessionId: 's1',
        messages: [makeMessage({ id: 'm1', role: 'assistant', content: 'Hello world' })],
        translatingMessages: {},
        showTranslationIds: new Set(),
      } as any)

      useChatStore.getState().translateMessage('m1', 'Hello world')

      const chatCall = vi.mocked(window.api.ai.chat).mock.calls[0] as any
      const requestId = chatCall[0].requestId
      // 模拟推理模型只输出思考内容，正文为空
      chunkCb({ requestId, text: '<thought>我来翻译这段内容……</thought>' })
      doneCb(requestId)

      const final = useChatStore.getState()
      expect(final.translatingMessages['m1']?.status).toBe('error')
      expect(final.translatingMessages['m1']?.errorMsg).toContain('翻译结果为空')
      expect(final.showTranslationIds.has('m1')).toBe(false)
      expect(final.messages[0].translation).toBeUndefined()
    })
  })
})

// ===================== P-7 本地元数据 patch 与配置加载 =====================

describe('P-7 本地会话元数据 patch / 配置加载收敛', () => {
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

  beforeEach(() => {
    resetStores()
    useChatStore.setState({
      sessions: [makeSession(), makeSession({ id: 's2', title: '另一个会话' })],
      currentSessionId: 's1',
    })
    vi.clearAllMocks()
  })

  it('patchLocalSession 只 patch 目标会话', () => {
    useChatStore.getState().patchLocalSession('s1', { title: '改名后', messageCount: 5 })
    const s = useChatStore.getState()
    expect(s.sessions.find(x => x.id === 's1')).toMatchObject({ title: '改名后', messageCount: 5 })
    expect(s.sessions.find(x => x.id === 's2')?.title).toBe('另一个会话')
    expect(s.sessions.find(x => x.id === 's2')?.messageCount).toBe(0)
  })

  it('insertGreetingMessage 变量替换 + 保存 + 本地 patch 元数据', async () => {
    const char = makeCharacter({ firstMessage: '你好，{{user}}' })
    await useChatStore.getState().insertGreetingMessage(char, '你好，小明')
    expect(window.api.chat.saveMessage).toHaveBeenCalledTimes(1)
    const s = useChatStore.getState()
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0].content).toContain('小明')
    const sess = s.sessions.find(x => x.id === 's1')!
    expect(sess.messageCount).toBe(1)
    expect(sess.lastMessage).toContain('你好')
  })

  it('getActiveChatConfig 返回激活预设，世界书过滤 enabled', async () => {
    vi.mocked(window.api.preset.list).mockResolvedValue([
      { id: 'pr1', name: 'P1' }, { id: 'pr2', name: 'P2' },
    ] as any)
    vi.mocked(window.api.lorebook.list).mockResolvedValue([
      { id: 'lb1', enabled: true }, { id: 'lb2', enabled: false },
    ] as any)
    useChatStore.setState({ activePresetId: 'pr2', activeLorebookIds: ['lb1', 'lb2'] })
    const { preset, lorebooks } = await useChatStore.getState().getActiveChatConfig()
    expect(preset?.id).toBe('pr2')
    expect(lorebooks.map(l => l.id)).toEqual(['lb1'])
  })

  it('getActiveChatConfig 未激活时返回 null/空，并清理世界书缓存', async () => {
    useChatStore.setState({ activePresetId: null, activeLorebookIds: [] })
    const { preset, lorebooks } = await useChatStore.getState().getActiveChatConfig()
    expect(preset).toBeNull()
    expect(lorebooks).toEqual([])
    expect(window.api.preset.list).not.toHaveBeenCalled()
    expect(window.api.lorebook.list).not.toHaveBeenCalled()
  })

  it('editMessage 保存后本地 patch 元数据，不再全量 listSessions', async () => {
    const char = makeCharacter()
    useChatStore.setState({ messages: [makeMessage({ id: 'm1', role: 'user' })] })
    vi.mocked(window.api.chat.listSessions).mockClear()
    await useChatStore.getState().editMessage('m1', '编辑后的内容', char)
    expect(window.api.chat.listSessions).not.toHaveBeenCalled()
    const sess = useChatStore.getState().sessions.find(x => x.id === 's1')!
    expect(sess.messageCount).toBe(1)
    expect(sess.lastMessage).toBe('编辑后的内容')
  })

  it('renameSession 本地 patch，不再全量 listSessions', async () => {
    vi.mocked(window.api.chat.listSessions).mockClear()
    await useChatStore.getState().renameSession('c1', 's1', '新标题')
    expect(window.api.chat.listSessions).not.toHaveBeenCalled()
    const sess = useChatStore.getState().sessions.find(x => x.id === 's1')!
    expect(sess.title).toBe('新标题')
  })

  it('clearChat 本地 patch 元数据清零，不再全量 listSessions', async () => {
    useChatStore.setState({ messages: [makeMessage(), makeMessage({ id: 'm2' })] })
    vi.mocked(window.api.chat.listSessions).mockClear()
    await useChatStore.getState().clearChat('c1')
    expect(window.api.chat.listSessions).not.toHaveBeenCalled()
    const sess = useChatStore.getState().sessions.find(x => x.id === 's1')!
    expect(sess.messageCount).toBe(0)
    expect(sess.lastMessage).toBe('')
  })

  it('createSessionWithGreeting 复用 insertGreetingMessage（消息保存一次）', async () => {
    const char = makeCharacter({ firstMessage: '欢迎' })
    vi.mocked(window.api.chat.createSession).mockResolvedValue({ id: 'new-s', characterId: 'c1', title: '新对话' } as any)
    vi.mocked(window.api.chat.listSessions).mockResolvedValue([
      makeSession({ id: 'new-s' }),
    ])
    await useChatStore.getState().createSessionWithGreeting(char)
    const s = useChatStore.getState()
    expect(s.currentSessionId).toBe('new-s')
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0].content).toBe('欢迎')
    expect(window.api.chat.saveMessage).toHaveBeenCalledTimes(1)
    // 元数据已本地 patch（messageCount 1）
    expect(s.sessions.find(x => x.id === 'new-s')?.messageCount).toBe(1)
  })
})
