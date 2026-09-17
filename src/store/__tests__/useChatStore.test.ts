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
    pendingImageGenerations: {},
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
  useCharacterStore.setState({ characters: [], currentCharacter: null })
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

  describe('临时生图任务', () => {
    it('同一会话去重并支持阶段更新与清理', () => {
      const first = useChatStore.getState().beginImageGeneration('c1', 's1', 'prompting')
      expect(first).toMatchObject({ characterId: 'c1', sessionId: 's1', stage: 'prompting' })
      expect(useChatStore.getState().beginImageGeneration('c1', 's1', 'generating')).toBeNull()

      useChatStore.getState().updateImageGeneration(first!.id, 'generating')
      expect(useChatStore.getState().pendingImageGenerations[first!.id].stage).toBe('generating')
      useChatStore.getState().finishImageGeneration(first!.id)
      expect(useChatStore.getState().pendingImageGenerations).toEqual({})
    })

    it('后台完成时保存到发起会话，不追加到当前其他会话', async () => {
      const character = makeCharacter()
      useCharacterStore.setState({ characters: [character], currentCharacter: character })
      useChatStore.setState({ currentSessionId: 's2', messages: [] })

      await useChatStore.getState().addStandaloneMessage('prompt', ['image'], character, 'system', 's1')

      expect(useChatStore.getState().messages).toEqual([])
      expect(vi.mocked(window.api.chat.saveMessage).mock.calls.at(-1)?.[0]).toMatchObject({
        sessionId: 's1', characterId: 'c1', content: 'prompt', images: ['image'],
      })
    })
  })

  describe('updateMemoryFacts', () => {
    it('持久化事实并使旧语义向量失效', async () => {
      useChatStore.setState({
        sessions: [{
          id: 's1',
          characterId: 'c1',
          memoryVersion: 2,
          factsVectors: [[0.1]],
        } as SessionPreview],
        _semanticFactsHits: ['旧命中'],
      })

      await useChatStore.getState().updateMemoryFacts('c1', 's1', ['手动添加的事实'])

      expect(window.api.chat.updateSessionIfMemoryVersion).toHaveBeenCalledWith('c1', 's1', 2, expect.objectContaining({
        memoryFacts: ['手动添加的事实'],
        memoryVersion: 3,
        factsVectors: [],
        factsVectorVersion: -1,
        memoryUpdatedAt: expect.any(Number),
      }))
      expect(useChatStore.getState().sessions[0]).toEqual(expect.objectContaining({
        memoryFacts: ['手动添加的事实'],
        memoryVersion: 3,
        factsVectors: [],
        factsVectorVersion: -1,
      }))
      expect(useChatStore.getState()._semanticFactsHits).toEqual([])
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

      const ctx = useChatStore.getState().buildContext(char, null).messages
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

      const ctx = useChatStore.getState().buildContext(char, null).messages
      const system = ctx.find(m => m.role === 'system')
      expect(system?.content).toContain('你是测试角色。玩家叫冒险家。')
    })

    it('adds continuation instruction in continuation mode', () => {
      useChatStore.setState({
        currentSessionId: 's1',
        sessions: [{ id: 's1', characterId: 'c1', title: 't', createdAt: 0, updatedAt: 0 } as SessionPreview],
        messages: [makeMessage()],
      })
      const ctx = useChatStore.getState().buildContext(makeCharacter(), null, { continuation: true }).messages
      expect(ctx.some(m => m.role === 'user' && m.content.includes('续写'))).toBe(true)
    })

    it('records lastContextUsage', () => {
      useChatStore.setState({
        currentSessionId: 's1',
        sessions: [{ id: 's1', characterId: 'c1', title: 't', createdAt: 0, updatedAt: 0 } as SessionPreview],
        messages: [makeMessage()],
      })
      expect(useChatStore.getState().buildContext(makeCharacter(), null).messages).toBeDefined()
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
      vi.mocked(window.api.ai.onComplete).mockImplementation((cb: any) => { doneCb = (id: string) => cb({ requestId: id, finishReason: 'stop' }); return () => {} })

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

      await vi.waitFor(() => expect(window.api.ai.chat).toHaveBeenCalled())
      const chatCall = vi.mocked(window.api.ai.chat).mock.calls[0] as any
      expect(chatCall[0].reasoningGate).toMatchObject({ level: 'off' })
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
      vi.mocked(window.api.ai.onComplete).mockImplementation((cb: any) => { doneCb = (id: string) => cb({ requestId: id, finishReason: 'stop' }); return () => {} })

      useSettingsStore.setState({
        settings: {
          ...getDefaultSettings(),
          activeProfileId: 'p1',
          activeModel: 'deepseek-v4-flash',
          connectionProfiles: [
            { id: 'p1', name: 'test', provider: 'openai', apiKey: 'sk-test', baseUrl: 'https://api.openai.com/v1', model: 'deepseek-v4-flash', maxContext: 0 },
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

      await vi.waitFor(() => expect(window.api.ai.chat).toHaveBeenCalled())
      const chatCall = vi.mocked(window.api.ai.chat).mock.calls[0] as any
      const requestId = chatCall[0].requestId
      expect(chatCall[0].maxTokens).toBeGreaterThan(0)
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

  it('全局叙事下保存我方独立消息时固化叙事模式', async () => {
    useChatStore.setState({
      sessions: [makeSession({ narrativeMode: 'omniscient' }), makeSession({ id: 's2' })],
      currentSessionId: 's1',
    })

    await useChatStore.getState().addStandaloneMessage('局势突然发生变化。', [], makeCharacter(), 'user')

    const saved = vi.mocked(window.api.chat.saveMessage).mock.calls.at(-1)?.[0]
    expect(saved).toMatchObject({
      role: 'user', narrativeMode: 'omniscient', speakerKind: 'narrator', generationKind: 'manual',
    })
    expect(useChatStore.getState().messages.at(-1)).toMatchObject({
      role: 'user', narrativeMode: 'omniscient', speakerKind: 'narrator', generationKind: 'manual',
    })
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

  it('editMessage 先更新与保存消息，不被长记忆失效请求阻塞', async () => {
    const char = makeCharacter()
    let releaseInvalidation!: (value: { applied: boolean; currentVersion: number }) => void
    vi.mocked(window.api.chat.updateSessionIfMemoryVersion).mockImplementationOnce(
      () => new Promise((resolve) => { releaseInvalidation = resolve }),
    )
    useChatStore.setState({
      sessions: [makeSession({ memory: '旧摘要', memoryVersion: 2, memoryLastMessageId: 'm1' })],
      messages: [makeMessage({ id: 'm1', role: 'assistant', content: '旧内容' })],
    })

    const editing = useChatStore.getState().editMessage('m1', '新内容', char)
    await Promise.resolve()

    expect(useChatStore.getState().messages[0].content).toBe('新内容')
    expect(window.api.chat.saveMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1', content: '新内容' }))

    releaseInvalidation({ applied: true, currentVersion: 0 })
    await editing
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

describe('用户发送后清空上一轮方向（store 集成）', () => {
  const DIRECTIONS = [
    { id: 'safe', label: '追问原因', content: '先不与守卫冲突，试着追问封锁的原因。', tendency: 'safe' as const },
    { id: 'explore', label: '寻找入口', content: '暂时离开正门，沿外围查看是否存在无人值守的通道。', tendency: 'explore' as const },
    { id: 'risky', label: '直接闯关', content: '趁守卫注意力被分散时尝试突破封锁，承担暴露的风险。', tendency: 'risky' as const },
  ]

  beforeEach(() => {
    resetStores()
    useSettingsStore.setState({
      settings: {
        ...getDefaultSettings(),
        userName: '林舟',
        activeProfileId: 'p1',
        connectionProfiles: [{
          id: 'p1', name: '测试', provider: 'openai', apiKey: 'sk-test',
          baseUrl: 'https://api.example.com', model: 'test-model',
        }] as never,
      },
      credentials: {}, loaded: true, _saveTimer: null,
    })
  })

  it('sendMessage 后本会话方向被清空并落盘（旧链路）', async () => {
    const { useChatTaskStore } = await import('../chatTaskStore')
    useChatTaskStore.setState({ chatEngineV2: false })
    useChatStore.setState({
      currentSessionId: 's1',
      sessions: [{ id: 's1', characterId: 'c1', dialogueDirectionsEnabled: true } as never],
      messages: [
        makeMessage({ id: 'a1', role: 'assistant', content: '港口已经封锁。', dialogueDirections: [...DIRECTIONS] }),
      ],
    })

    await useChatStore.getState().sendMessage('我压低声音问', [], makeCharacter(), null, [])

    const first = useChatStore.getState().messages[0] as { dialogueDirections?: unknown }
    expect(first.dialogueDirections).toBeUndefined()
    const saved = vi.mocked(window.api.chat.saveMessage).mock.calls.map((c) => c[0] as { id: string; dialogueDirections?: unknown })
    expect(saved.some((m) => m.id === 'a1' && m.dialogueDirections === undefined)).toBe(true)
  })

  it('用户以独立消息发言（addStandaloneMessage role=user）时同样清空', async () => {
    useChatStore.setState({
      currentSessionId: 's1',
      sessions: [{ id: 's1', characterId: 'c1' } as never],
      messages: [
        makeMessage({ id: 'a1', role: 'assistant', content: '港口已经封锁。', dialogueDirections: [...DIRECTIONS] }),
      ],
    })

    await useChatStore.getState().addStandaloneMessage('我不等你了', [], makeCharacter(), 'user')

    const first = useChatStore.getState().messages[0] as { dialogueDirections?: unknown }
    expect(first.dialogueDirections).toBeUndefined()
  })

  it('AI 独立消息（role=assistant）不清空方向', async () => {
    useChatStore.setState({
      currentSessionId: 's1',
      sessions: [{ id: 's1', characterId: 'c1' } as never],
      messages: [
        makeMessage({ id: 'a1', role: 'assistant', content: '港口已经封锁。', dialogueDirections: [...DIRECTIONS] }),
      ],
    })

    await useChatStore.getState().addStandaloneMessage('系统插话', [], makeCharacter(), 'assistant')

    const first = useChatStore.getState().messages[0] as { dialogueDirections?: unknown }
    expect(first.dialogueDirections).toHaveLength(3)
  })
})

describe('useChatStore 生成失败落盘（R2）', () => {
  beforeEach(() => {
    resetStores()
    useSettingsStore.setState({
      settings: {
        ...getDefaultSettings(),
        userName: '林舟',
        activeProfileId: 'p1',
        connectionProfiles: [{
          id: 'p1', name: '测试', provider: 'openai', apiKey: 'sk-test',
          baseUrl: 'https://api.example.com', model: 'test-model',
        }] as never,
      },
      credentials: {}, loaded: true, _saveTimer: null,
    })
  })

  function setupSession() {
    useChatStore.setState({
      currentSessionId: 's1',
      sessions: [{ id: 's1', characterId: 'c1' } as never],
    })
  }

  it('有分片 + 错误：半截正文先经统一收尾管线，稳定正文与 generationError 分离落盘（阶段7 矩阵 transport_error）', async () => {
    const { useChatTaskStore } = await import('../chatTaskStore')
    useChatTaskStore.setState({ chatEngineV2: false })
    setupSession()

    let chunkCallback: ((data: { requestId: string; text: string }) => void) | undefined
    let errorCallback: ((data: { requestId: string; error: string }) => void) | undefined
    ;(window.api.ai.onChunk as any).mockImplementation((cb: typeof chunkCallback) => { chunkCallback = cb; return () => {} })
    ;(window.api.ai.onError as any).mockImplementation((cb: typeof errorCallback) => { errorCallback = cb; return () => {} })
    ;(window.api.ai.chat as any).mockImplementation(async (params: { requestId: string }) => {
      chunkCallback?.({ requestId: params.requestId, text: '她推开门，走进房间。然后她伸手拿' })
      errorCallback?.({ requestId: params.requestId, error: '模型输出达到长度上限' })
    })

    await useChatStore.getState().sendMessage('我压低声音问', [], makeCharacter(), null, [])
    // 阶段7：异常收口是异步的（正文先进统一管线）
    await new Promise((r) => setTimeout(r, 10))

    const aiMsg = useChatStore.getState().messages.find((m) => m.role === 'assistant') as
      | (Message & { generationError?: string })
      | undefined
    // 半句被收束到稳定句界（不再原样落盘）
    expect(aiMsg?.content).toBe('她推开门，走进房间。')
    // 用户提示按行为矩阵：transport error + 稳定正文
    expect(aiMsg?.generationError).toBe('生成中断，已保留完整部分')

    const savedAi = vi.mocked(window.api.chat.saveMessage).mock.calls
      .map((c) => c[0] as Message & { generationError?: string })
      .find((m) => m.id === aiMsg?.id)
    expect(savedAi?.content).toBe('她推开门，走进房间。')
    expect(savedAi?.generationError).toBe('生成中断，已保留完整部分')
    // 错误文案不进入正文
    expect(savedAi?.content).not.toContain('长度上限')
    // 中断保留的正文与正常完成一致走语义分块，避免概率性丢失对话样式
    expect(aiMsg?.contentRenderMode).toBe('blocks')
    expect(savedAi?.contentRenderMode).toBe('blocks')
  })

  it('无分片 + 错误：不创建空 AI 消息、不落盘 ⚠️ 占位（阶段7 矩阵末行）', async () => {
    const { useChatTaskStore } = await import('../chatTaskStore')
    useChatTaskStore.setState({ chatEngineV2: false })
    setupSession()
    let errorCallback: ((data: { requestId: string; error: string }) => void) | undefined
    ;(window.api.ai.onChunk as any).mockImplementation(() => () => {})
    ;(window.api.ai.onError as any).mockImplementation((cb: typeof errorCallback) => { errorCallback = cb; return () => {} })
    ;(window.api.ai.chat as any).mockImplementation(async (params: { requestId: string }) => {
      errorCallback?.({ requestId: params.requestId, error: 'API 返回 500' })
    })

    await useChatStore.getState().sendMessage('我压低声音问', [], makeCharacter(), null, [])
    await new Promise((r) => setTimeout(r, 10))

    // 占位气泡被移除（不保存任何 AI 消息）
    const aiMsg = useChatStore.getState().messages.find((m) => m.role === 'assistant')
    expect(aiMsg).toBeUndefined()
    const savedAssistant = vi.mocked(window.api.chat.saveMessage).mock.calls
      .map((c) => c[0] as Message)
      .find((m) => m.role === 'assistant')
    expect(savedAssistant).toBeUndefined()
    // 错误只进 store.error（界面重试入口）
    expect(useChatStore.getState().error).toBeTruthy()
  })

  it('用户停止：抢先落盘的消息同样标记语义分块（unified 管线）', async () => {
    const { streamAIResponse } = await import('../streamController')
    const { useChatTaskStore } = await import('../chatTaskStore')
    useChatTaskStore.setState({ chatEngineV2: false })
    setupSession()

    let chunkCallback: ((data: { requestId: string; text: string }) => void) | undefined
    ;(window.api.ai.onChunk as any).mockImplementation((cb: typeof chunkCallback) => { chunkCallback = cb; return () => {} })
    ;(window.api.ai.onError as any).mockImplementation(() => () => {})
    ;(window.api.ai.onComplete as any).mockImplementation(() => () => {})
    ;(window.api.ai.chat as any).mockImplementation(async (params: { requestId: string }) => {
      chunkCallback?.({ requestId: params.requestId, text: '“先别动。”她低声说。' })
      await new Promise(() => {})
    })

    useChatStore.setState({
      messages: [{
        id: 'ai-1',
        sessionId: 's1',
        characterId: 'c1',
        role: 'assistant',
        content: '',
        images: [],
        isEditing: false,
        timestamp: Date.now(),
      } as Message],
      isStreaming: true,
    })

    const pending = streamAIResponse(
      useChatStore.setState as never,
      useChatStore.getState as never,
      {
        aiMessageId: 'ai-1',
        character: makeCharacter(),
        preset: null,
        onComplete: async () => {},
      },
    )
    await new Promise((r) => setTimeout(r, 10))

    useChatStore.getState().stopStreaming()
    await new Promise((r) => setTimeout(r, 10))

    const aiMsg = useChatStore.getState().messages.find((m) => m.id === 'ai-1') as Message
    expect(aiMsg?.content).toContain('先别动')
    expect(aiMsg?.generationNotice).toBe('已停止生成')
    // 停止抢先 latch 后 onComplete 不会再写 contentRenderMode，必须在 stop 路径补上
    expect(aiMsg?.contentRenderMode).toBe('blocks')
    const saved = vi.mocked(window.api.chat.saveMessage).mock.calls
      .map((c) => c[0] as Message)
      .find((m) => m.id === 'ai-1')
    expect(saved?.contentRenderMode).toBe('blocks')
    void pending
  })
})
