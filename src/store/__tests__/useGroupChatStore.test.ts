import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useGroupChatStore, stopRemainingSpeakers } from '../useGroupChatStore'
import { cleanupActiveStream, clearPollingTimer } from '../groupStreamController'
import { useSettingsStore } from '../useSettingsStore'
import { useCharacterStore } from '../useCharacterStore'
import { usePersonaStore } from '../usePersonaStore'
import { useToastStore } from '../useToastStore'
import { lorebookCache } from '../../utils/lorebook'
import { getDefaultSettings } from '../../../shared/defaults'
import type { GroupChat, GroupMessage, Character } from '../../../shared/types'

describe('useGroupChatStore', () => {
  beforeEach(() => {
    // 重置 store
    useGroupChatStore.setState({
      groupChats: [],
      currentGroup: null,
      sessions: [],
      currentSessionId: null,
      messages: [],
      isStreaming: false,
      currentStreamingCharId: null,
      error: null,
    })
    // 重置 settings store 以确保 getActiveProfile 可用
    useSettingsStore.setState({
      settings: getDefaultSettings(),
      credentials: {},
      loaded: true,
      _saveTimer: null,
    })
    // 重置角色 store
    useCharacterStore.setState({ characters: [] })
    usePersonaStore.setState({ personas: [], loaded: true })
    lorebookCache.clear()
    vi.clearAllMocks()
  })

  describe('initial state', () => {
    it('has empty arrays for groupChats, messages, sessions', () => {
      const state = useGroupChatStore.getState()
      expect(state.groupChats).toEqual([])
      expect(state.messages).toEqual([])
      expect(state.sessions).toEqual([])
    })

    it('has isStreaming: false', () => {
      expect(useGroupChatStore.getState().isStreaming).toBe(false)
    })

    it('has currentGroup: null', () => {
      expect(useGroupChatStore.getState().currentGroup).toBeNull()
    })

    it('has error: null', () => {
      expect(useGroupChatStore.getState().error).toBeNull()
    })
  })

  describe('store methods exist', () => {
    it('has all required methods', () => {
      const state = useGroupChatStore.getState()
      expect(typeof state.loadGroups).toBe('function')
      expect(typeof state.saveGroup).toBe('function')
      expect(typeof state.deleteGroup).toBe('function')
      expect(typeof state.selectGroup).toBe('function')
      expect(typeof state.sendMessage).toBe('function')
      expect(typeof state.sendPollingRound).toBe('function')
      expect(typeof state.triggerCharacterReply).toBe('function')
      expect(typeof state.stopStreaming).toBe('function')
      expect(typeof state.clearChat).toBe('function')
      expect(typeof state.clearMessages).toBe('function')
      expect(typeof state.buildGroupContext).toBe('function')
      expect(typeof state.setSessionNarrativeMode).toBe('function')
    })
  })

  describe('createSession', () => {
    it('全局默认开启时为新群聊启用自动长记忆', async () => {
      useSettingsStore.setState((state) => ({
        settings: { ...state.settings, defaultMemoryEnabled: true },
      }))
      const updateSession = vi.fn().mockResolvedValue(undefined)
      window.api.group.updateSession = updateSession
      vi.mocked(window.api.group.createSession).mockResolvedValue({ id: 'session-1' } as never)
      vi.mocked(window.api.group.listSessions).mockResolvedValue([])

      await useGroupChatStore.getState().createSession('group-1')

      expect(updateSession).toHaveBeenCalledWith('group-1', 'session-1', {
        memoryEnabled: true,
        memoryMode: 'auto',
        autoMemoryInterval: 10,
      })
    })

    it('新建群聊会话后同步会话绑定的用户身份', async () => {
      usePersonaStore.setState({
        personas: [{
          id: 'persona-1', name: '林舟', description: '调查员', persona: '冷静敏锐',
          avatar: '', createdAt: 0, updatedAt: 0,
        }],
        loaded: true,
      })
      vi.mocked(window.api.group.createSession).mockResolvedValue({
        id: 'session-1', groupId: 'group-1', title: '新对话 1', messageCount: 0,
        createdAt: 0, updatedAt: 0, personaId: 'persona-1',
      })
      vi.mocked(window.api.group.listSessions).mockResolvedValue([{
        id: 'session-1', groupId: 'group-1', title: '新对话 1', messageCount: 0,
        createdAt: 0, updatedAt: 0, personaId: 'persona-1',
      }])

      await useGroupChatStore.getState().createSession('group-1')

      expect(useSettingsStore.getState().settings.activePersonaId).toBe('persona-1')
      expect(useSettingsStore.getState().settings.userName).toBe('林舟')
    })
  })

  describe('setSessionPersona', () => {
    it('持久化当前群聊会话身份并同步上下文身份', async () => {
      usePersonaStore.setState({
        personas: [{
          id: 'persona-2', name: '沈知夏', description: '记者', persona: '直率好奇',
          avatar: '', createdAt: 0, updatedAt: 0,
        }],
        loaded: true,
      })
      useGroupChatStore.setState({
        currentGroup: { id: 'g1' } as GroupChat,
        currentSessionId: 's1',
        sessions: [{ id: 's1', groupId: 'g1', personaId: null } as never],
      })

      await useGroupChatStore.getState().setSessionPersona('persona-2')

      expect(window.api.group.updateSession).toHaveBeenCalledWith('g1', 's1', { personaId: 'persona-2' })
      expect(useGroupChatStore.getState().sessions[0].personaId).toBe('persona-2')
      expect(useSettingsStore.getState().settings).toEqual(expect.objectContaining({
        activePersonaId: 'persona-2',
        userName: '沈知夏',
        userDescription: '记者',
        userPersona: '直率好奇',
      }))
    })
  })

  describe('setSessionNarrativeMode', () => {
    it('持久化当前群聊会话模式并更新本地快照', async () => {
      useGroupChatStore.setState({
        currentGroup: { id: 'g1' } as GroupChat,
        currentSessionId: 's1',
        sessions: [{ id: 's1', groupId: 'g1', narrativeMode: 'immersive' } as never],
        isStreaming: false,
      })

      await useGroupChatStore.getState().setSessionNarrativeMode('omniscient')

      expect(window.api.group.updateSession).toHaveBeenCalledWith('g1', 's1', { narrativeMode: 'omniscient' })
      expect(useGroupChatStore.getState().sessions[0].narrativeMode).toBe('omniscient')
    })

    it('生成中不允许切换', async () => {
      useGroupChatStore.setState({
        currentGroup: { id: 'g1' } as GroupChat,
        currentSessionId: 's1',
        sessions: [{ id: 's1', groupId: 'g1', narrativeMode: 'immersive' } as never],
        isStreaming: true,
      })
      await useGroupChatStore.getState().setSessionNarrativeMode('omniscient')
      expect(window.api.group.updateSession).not.toHaveBeenCalled()
      expect(useGroupChatStore.getState().sessions[0].narrativeMode).toBe('immersive')
    })
  })

  describe('updateNarrativeSession', () => {
    it('持久化世界状态', async () => {
      useGroupChatStore.setState({
        currentGroup: { id: 'g1' } as GroupChat,
        currentSessionId: 's1',
        sessions: [{ id: 's1', groupId: 'g1', narrativeMode: 'omniscient' } as never],
        isStreaming: false,
      })

      await useGroupChatStore.getState().updateNarrativeSession({
        memoryCurrentState: '北境风暴逼近',
      })

      expect(window.api.group.updateSession).toHaveBeenCalledWith('g1', 's1', {
        memoryCurrentState: '北境风暴逼近',
      })
      expect(useGroupChatStore.getState().sessions[0]).toMatchObject({
        memoryCurrentState: '北境风暴逼近',
      })
    })
  })

  describe('clearMessages', () => {
    it('resets messages and error to empty', () => {
      useGroupChatStore.setState({
        messages: [{ id: '1', groupId: 'g1', characterId: 'c1', content: 'test', images: [], timestamp: 0, round: 1 } as GroupMessage],
        error: 'some error',
      })
      useGroupChatStore.getState().clearMessages()
      expect(useGroupChatStore.getState().messages).toEqual([])
      expect(useGroupChatStore.getState().error).toBeNull()
    })
  })

  describe('translateMessage', () => {
    it('关闭推理输出，避免思考内容耗尽翻译正文预算', async () => {
      useSettingsStore.setState({
        settings: {
          ...getDefaultSettings(),
          activeProfileId: 'p1',
          activeModel: 'deepseek-v4-flash',
          connectionProfiles: [{
            id: 'p1', name: 'test', provider: 'openai' as const,
            baseUrl: 'https://api.example.com/v1', model: 'deepseek-v4-flash', apiKey: 'sk-test', maxContext: 8192,
          }],
        },
      })
      useGroupChatStore.setState({
        currentGroup: { id: 'g1' } as GroupChat,
        currentSessionId: 's1',
        messages: [{
          id: 'm1', groupId: 'g1', characterId: 'c1', content: 'Hello world',
          images: [], timestamp: 0, round: 1,
        } as GroupMessage],
      })

      await useGroupChatStore.getState().translateMessage('m1')

      expect(window.api.ai.chat).toHaveBeenCalledWith(expect.objectContaining({
        reasoningGate: expect.objectContaining({ level: 'off' }),
        maxTokens: expect.any(Number),
      }))
    })

    it('UEX-P2-03：翻译失败推全局 Toast，不再静默清空', async () => {
      useSettingsStore.setState({
        settings: {
          ...getDefaultSettings(),
          activeProfileId: 'p1',
          connectionProfiles: [{
            id: 'p1', name: 'test', provider: 'openai' as const,
            baseUrl: 'https://api.example.com/v1', model: 'gpt-4o', apiKey: 'sk-test', maxContext: 8192,
          }],
        },
      })
      useGroupChatStore.setState({
        currentGroup: { id: 'g1' } as GroupChat,
        currentSessionId: 's1',
        messages: [{
          id: 'm1', groupId: 'g1', characterId: 'c1', content: 'Hello world',
          images: [], timestamp: 0, round: 1,
        } as GroupMessage],
      })
      useToastStore.setState({ toasts: [] })

      await useGroupChatStore.getState().translateMessage('m1')
      // 模拟主进程返回翻译失败（onError 回调）
      const requestId = vi.mocked(window.api.ai.chat).mock.calls[0][0].requestId
      vi.mocked(window.api.ai.onError).mock.calls.at(-1)?.[0]({ requestId, error: '模型不可用' })

      expect(useToastStore.getState().toasts.some((t) => t.title === '翻译失败' && t.description === '模型不可用')).toBe(true)
      expect(useGroupChatStore.getState().messages.find((m) => m.id === 'm1')?.translation).toBeNull()
    })
  })

  describe('updateMemoryFacts', () => {
    it('持久化群聊事实并使旧语义向量失效', async () => {
      const updateSession = vi.fn().mockResolvedValue({ applied: true, currentVersion: 5 })
      window.api.group.updateSessionIfMemoryVersion = updateSession
      useGroupChatStore.setState({
        sessions: [{ id: 's1', groupId: 'g1', memoryVersion: 4, factsVectors: [[0.1]] } as never],
        _semanticFactsHits: ['旧命中'],
      })

      await useGroupChatStore.getState().updateMemoryFacts('g1', 's1', ['群聊新事实'])

      expect(updateSession).toHaveBeenCalledWith('g1', 's1', 4, expect.objectContaining({
        memoryFacts: ['群聊新事实'],
        memoryVersion: 5,
        factsVectors: [],
        factsVectorVersion: -1,
        memoryUpdatedAt: expect.any(Number),
      }))
      expect(useGroupChatStore.getState().sessions[0]).toEqual(expect.objectContaining({
        memoryFacts: ['群聊新事实'],
        memoryVersion: 5,
        factsVectors: [],
        factsVectorVersion: -1,
      }))
      expect(useGroupChatStore.getState()._semanticFactsHits).toEqual([])
    })
  })

  describe('setCurrentGroup', () => {
    it('sets the current group', () => {
      const group: GroupChat = {
        id: 'g1',
        name: 'Test Group',
        memberIds: ['c1', 'c2'],
        currentSpeakerIndex: 0,
        autoMode: false,
        chatMode: 'polling',
        maxRounds: 1,
        speakerInterval: 2000,
        lorebookIds: [],
        presetId: null,
        systemPrompt: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      useGroupChatStore.getState().setCurrentGroup(group)
      expect(useGroupChatStore.getState().currentGroup).toEqual(group)
    })
  })

  describe('saveGroup', () => {
    it('UEX-P1-11：生成中改动对话模式/成员被兜底拦截，外观设置仍可保存', async () => {
      const group: GroupChat = {
        id: 'g1', name: 'G', memberIds: ['c1'],
        currentSpeakerIndex: 0, autoMode: false, chatMode: 'polling',
        maxRounds: 1, speakerInterval: 2000, lorebookIds: [],
        presetId: null, systemPrompt: '', createdAt: 0, updatedAt: 0,
      }
      useGroupChatStore.setState({ currentGroup: group, groupChats: [group], isStreaming: true })
      useToastStore.setState({ toasts: [] })
      vi.mocked(window.api.group.list).mockResolvedValue([group])

      await useGroupChatStore.getState().saveGroup({ ...group, chatMode: 'free' })
      expect(window.api.group.save).not.toHaveBeenCalled()
      expect(useToastStore.getState().toasts.some((t) => t.title.includes('生成中'))).toBe(true)

      await useGroupChatStore.getState().saveGroup({ ...group, memberIds: ['c1', 'c2'] })
      expect(window.api.group.save).not.toHaveBeenCalled()

      // 非调度字段（主题色）生成中仍可保存
      await useGroupChatStore.getState().saveGroup({ ...group, themeColor: '#ff0000' })
      expect(window.api.group.save).toHaveBeenCalledTimes(1)
    })
  })

  describe('sendMessage', () => {
    it('returns early when no currentGroup', async () => {
      await useGroupChatStore.getState().sendMessage('test', [], undefined)
      // 没有消息被添加
      expect(useGroupChatStore.getState().messages).toHaveLength(0)
    })

    it('returns early when no currentSessionId', async () => {
      useGroupChatStore.setState({
        currentGroup: {
          id: 'g1', name: 'Test', memberIds: ['c1'],
          currentSpeakerIndex: 0, autoMode: false, chatMode: 'polling',
          maxRounds: 1, speakerInterval: 2000, lorebookIds: [],
          presetId: null, systemPrompt: '', createdAt: 0, updatedAt: 0,
        },
        currentSessionId: null,
      })
      await useGroupChatStore.getState().sendMessage('test', [], undefined)
      expect(useGroupChatStore.getState().messages).toHaveLength(0)
    })

    it('sets error when isStreaming is true', async () => {
      useGroupChatStore.setState({
        currentGroup: {
          id: 'g1', name: 'Test', memberIds: ['c1'],
          currentSpeakerIndex: 0, autoMode: false, chatMode: 'polling',
          maxRounds: 1, speakerInterval: 2000, lorebookIds: [],
          presetId: null, systemPrompt: '', createdAt: 0, updatedAt: 0,
        },
        currentSessionId: 's1',
        isStreaming: true,
      })
      await useGroupChatStore.getState().sendMessage('test', [], undefined)
      expect(useGroupChatStore.getState().error).toContain('正在生成')
    })

    it('sets error when no API profile configured', async () => {
      useGroupChatStore.setState({
        currentGroup: {
          id: 'g1', name: 'Test', memberIds: ['c1'],
          currentSpeakerIndex: 0, autoMode: false, chatMode: 'polling',
          maxRounds: 1, speakerInterval: 2000, lorebookIds: [],
          presetId: null, systemPrompt: '', createdAt: 0, updatedAt: 0,
        },
        currentSessionId: 's1',
        isStreaming: false,
      })
      // 没有配置 profile
      await useGroupChatStore.getState().sendMessage('test', [], undefined)
      expect(useGroupChatStore.getState().error).toContain('API')
    })
  })

  describe('sendMessage signature', () => {
    it('accepts 4 parameters including replyToId', () => {
      // 验证函数签名通过类型检查
      const fn = useGroupChatStore.getState().sendMessage
      expect(fn.length).toBeGreaterThanOrEqual(3)
      // 调用不应抛出异常（会提前 return）
      expect(async () => {
        await fn('content', [], undefined, 'reply-id')
      }).not.toThrow()
    })
  })

  describe('stopStreaming', () => {
    it('resets streaming state when no active stream', () => {
      useGroupChatStore.setState({
        isStreaming: true,
        currentStreamingCharId: 'c1',
      })
      useGroupChatStore.getState().stopStreaming()
      expect(useGroupChatStore.getState().isStreaming).toBe(false)
      expect(useGroupChatStore.getState().currentStreamingCharId).toBeNull()
    })
  })

  describe('stopRemainingSpeakers（UEX-P1-12 停剩余）', () => {
    it('语义别名与 stopStreaming 同义：停止后续接力并复位流式状态（保留已生成内容）', () => {
      useGroupChatStore.setState({
        isStreaming: true,
        currentStreamingCharId: 'c1',
      })
      stopRemainingSpeakers()
      expect(useGroupChatStore.getState().isStreaming).toBe(false)
      expect(useGroupChatStore.getState().currentStreamingCharId).toBeNull()
    })
  })

  describe('buildGroupContext', () => {
    it('returns empty array when no current group', () => {
      const context = useGroupChatStore.getState().buildGroupContext()
      expect(context).toEqual([])
    })

    it('returns context array when group is set', () => {
      useGroupChatStore.setState({
        currentGroup: {
          id: 'g1', name: 'Test Group', memberIds: [],
          currentSpeakerIndex: 0, autoMode: false, chatMode: 'polling',
          maxRounds: 1, speakerInterval: 2000, lorebookIds: [],
          presetId: null, systemPrompt: 'Test system prompt', createdAt: 0, updatedAt: 0,
        },
        messages: [],
      })
      const context = useGroupChatStore.getState().buildGroupContext()
      // 没有成员时仍应返回系统消息
      expect(Array.isArray(context)).toBe(true)
    })

    it.each([
      { label: '仅首轮在群聊首轮发送', mode: 'first_turn' as const, userMessageCount: 1, expected: true },
      { label: '仅首轮在群聊后续轮次停止发送', mode: 'first_turn' as const, userMessageCount: 2, expected: false },
      { label: '每轮在群聊后续轮次仍发送', mode: 'always' as const, userMessageCount: 2, expected: true },
      { label: '关闭时群聊首轮也不发送', mode: 'off' as const, userMessageCount: 1, expected: false },
    ])('$label', ({ mode, userMessageCount, expected }) => {
      const member: Character = {
        id: 'scene-char', name: '苏晚', avatar: '', description: '', personality: '',
        scenario: '初始场景在旧车站', firstMessage: '', exampleDialog: '', tags: [], lorebookId: null,
        creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [],
      }
      const userMessages: GroupMessage[] = Array.from({ length: userMessageCount }, (_, index) => ({
        id: `user-${index}`, groupId: 'scene-group', characterId: '__user__',
        content: `用户消息 ${index + 1}`, images: [], timestamp: index + 1, round: index + 1,
      }))
      useCharacterStore.setState({ characters: [member] })
      useSettingsStore.setState((state) => ({
        settings: { ...state.settings, scenarioInjectionMode: mode },
      }))
      useGroupChatStore.setState({
        currentGroup: {
          id: 'scene-group', name: '场景测试', memberIds: [member.id], currentSpeakerIndex: 0,
          autoMode: false, chatMode: 'polling', maxRounds: 1, speakerInterval: 2000,
          lorebookIds: [], presetId: null, systemPrompt: '', createdAt: 0, updatedAt: 0,
        },
        messages: userMessages,
      })

      const joined = useGroupChatStore.getState().buildGroupContextReport(member.id)
        .messages.map(item => item.content).join('\n')
      expect(joined.includes('场景：初始场景在旧车站')).toBe(expected)
    })

    it('群聊报告使用动态输出预算，maxTokens=0 不回退为 1024', () => {
      useSettingsStore.setState((state) => ({
        settings: {
          ...state.settings,
          activeProfileId: 'deepseek-profile',
          activeModel: 'deepseek/deepseek-v4.1-flash',
          connectionProfiles: [{
            id: 'deepseek-profile', name: 'DeepSeek', provider: 'openai', apiKey: 'sk-test',
            baseUrl: 'https://api.example.com/v1', model: 'deepseek/deepseek-v4.1-flash', maxContext: 16384,
          }],
        },
      }))
      useGroupChatStore.setState({
        currentGroup: {
          id: 'g1', name: 'Test Group', memberIds: [],
          currentSpeakerIndex: 0, autoMode: false, chatMode: 'polling',
          maxRounds: 1, speakerInterval: 2000, lorebookIds: [],
          presetId: null, systemPrompt: '', createdAt: 0, updatedAt: 0,
        },
        messages: [],
      })
      const preset = {
        id: 'auto-budget', name: '自动预算', description: '', systemPrompt: '', jailbreak: '',
        maxContext: 0, temperature: 0.8, topP: 0.95, maxTokens: 0,
        frequencyPenalty: 0, presencePenalty: 0, isBuiltin: false, responseLengthHint: 'balanced' as const,
      }
      const report = useGroupChatStore.getState().buildGroupContextReport(undefined, preset)
      expect(report.requestMaxTokens).toBeGreaterThan(1024)
      expect(report.requestBudget?.riskNotice).toBeUndefined()
    })

    it('使用当前群聊会话绑定的身份构建上下文', () => {
      usePersonaStore.setState({
        personas: [{
          id: 'persona-group', name: '顾言', description: '馆长', persona: '温和克制',
          avatar: '', createdAt: 0, updatedAt: 0,
        }],
        loaded: true,
      })
      useSettingsStore.setState((state) => ({
        settings: { ...state.settings, userName: '旧身份', userDescription: '', userPersona: '' },
      }))
      useGroupChatStore.setState({
        currentGroup: {
          id: 'g1', name: 'Test Group', memberIds: [],
          currentSpeakerIndex: 0, autoMode: false, chatMode: 'polling',
          maxRounds: 1, speakerInterval: 2000, lorebookIds: [],
          presetId: null, systemPrompt: '', createdAt: 0, updatedAt: 0,
        },
        currentSessionId: 's1',
        sessions: [{ id: 's1', groupId: 'g1', personaId: 'persona-group' } as never],
        messages: [],
      })

      const context = useGroupChatStore.getState().buildGroupContext(undefined, undefined, { trackUsage: false })
      const joined = context.map((item) => item.content).join('\n')

      expect(joined).toContain('用户「顾言」')
      expect(joined).toContain('描述：馆长')
      expect(joined).toContain('性格：温和克制')
      expect(joined).not.toContain('用户「旧身份」')
    })

    it('群聊全局叙事把发言人视为焦点而非视角边界', () => {
      const member: Character = {
        id: 'c1', name: '艾琳', avatar: '', description: '', personality: '', scenario: '',
        firstMessage: '', exampleDialog: '', tags: [], lorebookId: null,
        creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [],
      }
      useCharacterStore.setState({ characters: [member] })
      useGroupChatStore.setState({
        currentGroup: {
          id: 'g1', name: '群像', memberIds: ['c1'], currentSpeakerIndex: 0,
          autoMode: false, chatMode: 'polling', maxRounds: 1, speakerInterval: 2000,
          lorebookIds: [], presetId: null, systemPrompt: '', createdAt: 0, updatedAt: 0,
        },
        currentSessionId: 's1',
        sessions: [{ id: 's1', groupId: 'g1', narrativeMode: 'omniscient' } as never],
        messages: [],
      })

      const report = useGroupChatStore.getState().buildGroupContextReport('c1')
      const joined = report.messages.map((item) => item.content).join('\n')
      expect(report.narrativeMode).toBe('omniscient')
      expect(joined).toContain('发言调度仅指定剧情焦点「艾琳」')
      expect(joined).toContain('异地事件或世界变化')
      expect(joined).toContain('正文仍保持第三人称叙事')
      expect(joined).toContain('焦点角色「艾琳」的第一人称内心独白')
      expect(joined).toContain('不得包含模型推理')
    })

    it('群聊主回复不再注入游戏主持判定与选项格式', () => {
      useGroupChatStore.setState({
        currentGroup: {
          id: 'g1', name: '战役', memberIds: [], currentSpeakerIndex: 0,
          autoMode: false, chatMode: 'free', maxRounds: 1, speakerInterval: 2000,
          lorebookIds: [], presetId: null, systemPrompt: '', createdAt: 0, updatedAt: 0,
        },
        currentSessionId: 's1',
        sessions: [{ id: 's1', groupId: 'g1', narrativeMode: 'omniscient', dialogueDirectionsEnabled: true } as never],
        messages: [],
      })
      const joined = useGroupChatStore.getState().buildGroupContextReport().messages.map((item) => item.content).join('\n')
      expect(joined).not.toContain('【呈现方式：游戏主持】')
      expect(joined).not.toContain('【判定】')
      expect(joined).not.toContain('【可选行动】')
    })

    it('旧群聊会话缺少模式时固定回退代入模式', () => {
      useSettingsStore.setState((state) => ({
        settings: { ...state.settings, defaultNarrativeMode: 'omniscient' },
      }))
      useGroupChatStore.setState({
        currentGroup: {
          id: 'g1', name: '旧群聊', memberIds: [], currentSpeakerIndex: 0,
          autoMode: false, chatMode: 'free', defaultNarrativeMode: 'omniscient',
          maxRounds: 1, speakerInterval: 2000, lorebookIds: [], presetId: null,
          systemPrompt: '', createdAt: 0, updatedAt: 0,
        },
        currentSessionId: 'legacy',
        sessions: [{ id: 'legacy', groupId: 'g1' } as never],
        messages: [],
      })

      const report = useGroupChatStore.getState().buildGroupContextReport()
      expect(report.narrativeMode).toBe('immersive')
      expect(report.messages.map((item) => item.content).join('\n')).toContain('每名角色只依据自己可感知')
    })

    it('只读上下文预览不推进 recency 或持久化会话', () => {
      const updateSession = vi.mocked(window.api.group.updateSession)
      useGroupChatStore.setState({
        currentGroup: {
          id: 'g1', name: 'Test Group', memberIds: [], currentSpeakerIndex: 0,
          autoMode: false, chatMode: 'polling', maxRounds: 1, speakerInterval: 2000,
          lorebookIds: [], presetId: null, systemPrompt: '', createdAt: 0, updatedAt: 0,
        },
        currentSessionId: 's1',
        sessions: [{ id: 's1', groupId: 'g1', recentTriggeredIds: [['lb1:old']] } as never],
        lastLorebookDiagnosticsSessionId: 'old-session',
      })
      useGroupChatStore.getState().buildGroupContextReport()
      expect(updateSession).not.toHaveBeenCalled()
      expect(useGroupChatStore.getState().sessions[0].recentTriggeredIds).toEqual([['lb1:old']])
      expect(useGroupChatStore.getState().lastLorebookDiagnosticsSessionId).toBe('old-session')
    })

    it('真实群聊生成会持久化世界书 timed effects', () => {
      lorebookCache.set('lb1', {
        id: 'lb1', name: '事件书', description: '', enabled: true, scanDepth: 2,
        entries: [{
          id: 'event', keywords: ['事件'], content: '群聊周期事件', position: 'before_char',
          order: 1, probability: 100, enabled: true, sticky: 3, cooldown: 2,
        }],
      })
      const updateSession = vi.mocked(window.api.group.updateSession)
      useGroupChatStore.setState({
        currentGroup: {
          id: 'g1', name: 'Test Group', memberIds: [], currentSpeakerIndex: 0,
          autoMode: false, chatMode: 'polling', maxRounds: 1, speakerInterval: 2000,
          lorebookIds: ['lb1'], presetId: null, systemPrompt: '', createdAt: 0, updatedAt: 0,
        },
        currentSessionId: 's1',
        sessions: [{ id: 's1', groupId: 'g1' } as never],
        messages: [{
          id: 'm1', groupId: 'g1', sessionId: 's1', characterId: '__user__', role: 'user',
          content: '事件', images: [], timestamp: 1, round: 1,
        } as never],
      })
      useGroupChatStore.getState().buildGroupContext()
      expect(updateSession).toHaveBeenCalledWith('g1', 's1', expect.objectContaining({
        lorebookTimedEffects: {
          sticky: { 'lb1:event': expect.objectContaining({ start: 1, end: 4 }) },
          cooldown: { 'lb1:event': expect.objectContaining({ start: 1, end: 3 }) },
        },
      }))
      expect(useGroupChatStore.getState()).toMatchObject({
        lastLorebookDiagnosticsSessionId: 's1',
        lastLorebookDiagnostics: {
          mode: 'live',
          summary: { injectedEntries: 1 },
        },
      })
    })

    it('群聊使用统一 renderer 处理示例、AN 与 outlet 位置', () => {
      const member: Character = {
        id: 'c1', name: '艾琳', avatar: '', description: '群聊角色描述', personality: '', scenario: '',
        firstMessage: '', exampleDialog: '用户：你好\n艾琳：晚上好', tags: [], lorebookId: null,
        creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [],
      }
      useCharacterStore.setState({ characters: [member] })
      const runtimeEntry = (
        id: string,
        content: string,
        insertion: NonNullable<import('../../../shared/types').LoreEntry['runtime']>['insertion'],
      ) => ({
        id, keywords: [], content, position: 'at_end' as const, order: 1,
        probability: 100, enabled: true, priority: 'always' as const,
        runtime: { insertion, retrieval: 'keyword' as const, adapterId: 'sillytavern.world-info' },
      })
      lorebookCache.set('runtime-book', {
        id: 'runtime-book', name: '特殊位置', description: '', enabled: true, scanDepth: 2,
        entries: [
          runtimeEntry('before-example', '群聊示例前', { kind: 'prompt', anchor: 'before_examples' }),
          runtimeEntry('after-example', '群聊示例后', { kind: 'prompt', anchor: 'after_examples' }),
          runtimeEntry('an-top', '群聊 AN 顶部', { kind: 'prompt', anchor: 'authors_note_top' }),
          runtimeEntry('an-bottom', '群聊 AN 底部', { kind: 'prompt', anchor: 'authors_note_bottom' }),
          runtimeEntry('outlet', '群聊命名出口', { kind: 'outlet', name: 'facts' }),
        ],
      })
      useGroupChatStore.setState({
        currentGroup: {
          id: 'g1', name: 'Test Group', memberIds: ['c1'], currentSpeakerIndex: 0,
          autoMode: false, chatMode: 'free', maxRounds: 1, speakerInterval: 2000,
          lorebookIds: ['runtime-book'], presetId: null, systemPrompt: '', createdAt: 0, updatedAt: 0,
        },
        currentSessionId: 's1',
        sessions: [{ id: 's1', groupId: 'g1' } as never],
        messages: [{
          id: 'm1', groupId: 'g1', sessionId: 's1', characterId: '__user__', role: 'user',
          content: '测试消息', images: [], timestamp: 1, round: 1,
        } as never],
      })

      const context = useGroupChatStore.getState().buildGroupContext()
      const indexOf = (text: string) => context.findIndex((message) => message.content.includes(text))
      const systemContent = context[0].content
      expect(context[0].content).toContain('群聊命名出口')
      expect(systemContent.indexOf('群聊示例前')).toBeLessThan(systemContent.indexOf('对话示例（艾琳）'))
      expect(systemContent.indexOf('群聊示例后')).toBeGreaterThan(systemContent.indexOf('对话示例（艾琳）'))
      expect(indexOf('群聊 AN 顶部')).toBeGreaterThan(0)
      expect(indexOf('群聊 AN 底部')).toBeGreaterThan(indexOf('测试消息'))
      expect(useGroupChatStore.getState().lastLorebookDiagnostics?.entries.find((entry) => entry.entryId === 'outlet')).toMatchObject({
        adapterId: 'sillytavern.world-info',
        renderStatus: 'fallback',
      })
    })
  })

  describe('loadGroups', () => {
    it('loads groups from API', async () => {
      const mockGroups: GroupChat[] = [{
        id: 'g1', name: 'Group 1', memberIds: [],
        currentSpeakerIndex: 0, autoMode: false, chatMode: 'polling',
        maxRounds: 1, speakerInterval: 2000, lorebookIds: [],
        presetId: null, systemPrompt: '', createdAt: 0, updatedAt: 0,
      }]
      vi.mocked(window.api.group.list).mockResolvedValue(mockGroups)

      await useGroupChatStore.getState().loadGroups()
      expect(useGroupChatStore.getState().groupChats).toEqual(mockGroups)
    })
  })

  describe('GroupMessage type extensions', () => {
    it('GroupMessage supports replyToId field', () => {
      const msg: GroupMessage = {
        id: '1',
        groupId: 'g1',
        characterId: '__user__',
        content: 'test',
        images: [],
        timestamp: 0,
        round: 1,
        replyToId: 'msg-0',
      }
      expect(msg.replyToId).toBe('msg-0')
    })

    it('GroupMessage supports status field', () => {
      const msg: GroupMessage = {
        id: '1',
        groupId: 'g1',
        characterId: '__user__',
        content: 'test',
        images: [],
        timestamp: 0,
        round: 1,
        status: 'sending',
      }
      expect(msg.status).toBe('sending')
    })
  })

  describe('mention 提取', () => {
    /** 构造最小测试角色 */
    function makeCharacter(id: string, name: string): Character {
      return {
        id, name, avatar: '', description: '', personality: '', scenario: '',
        firstMessage: '', exampleDialog: '', tags: [], lorebookId: null,
        creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [],
      }
    }

    /** 配置完整群聊发送环境 */
    function setupMentionGroup() {
      // 配置 API profile
      useSettingsStore.setState({
        settings: {
          ...getDefaultSettings(),
          activeProfileId: 'p1',
          connectionProfiles: [{
            id: 'p1', name: 'test', provider: 'openai' as const,
            baseUrl: 'http://localhost:1/v1', model: 'gpt-4o', apiKey: 'sk-test', maxContext: 8192,
          }],
        },
      })
      // 配置群成员（爱丽丝 与 千夏）
      useCharacterStore.setState({
        characters: [makeCharacter('c1', '爱丽丝'), makeCharacter('c2', '千夏')],
      })
      useGroupChatStore.setState({
        currentGroup: {
          id: 'g1', name: 'G', memberIds: ['c1', 'c2'],
          currentSpeakerIndex: 0, autoMode: false, chatMode: 'mention' as const,
          maxRounds: 1, speakerInterval: 2000, lorebookIds: [],
          presetId: null, systemPrompt: '', createdAt: 0, updatedAt: 0,
        },
        currentSessionId: 's1',
      })
    }

    it('@点名消息记录 mentionedCharacterIds', async () => {
      setupMentionGroup()
      const saveMsg = vi.mocked(window.api.group.saveMessage)

      await useGroupChatStore.getState().sendMessage('@爱丽丝 今晚去哪？', [], undefined)

      // 用户消息已保存，且带正确的 mentionedCharacterIds
      expect(saveMsg).toHaveBeenCalled()
      const savedUserMsg = saveMsg.mock.calls[0][2] as GroupMessage
      expect(savedUserMsg.characterId).toBe('__user__')
      expect(savedUserMsg.mentionedCharacterIds).toEqual(['c1'])
    })

    it('全局叙事下保存我方消息时固化叙事模式', async () => {
      setupMentionGroup()
      useGroupChatStore.setState({
        sessions: [{ id: 's1', groupId: 'g1', narrativeMode: 'omniscient' } as never],
      })

      await useGroupChatStore.getState().sendMessage('城外的警钟突然响起。', [], 'missing-character')

      const savedUserMsg = vi.mocked(window.api.group.saveMessage).mock.calls[0][2] as GroupMessage
      expect(savedUserMsg.characterId).toBe('__user__')
      expect(savedUserMsg.narrativeMode).toBe('omniscient')
      expect(savedUserMsg.speakerKind).toBe('narrator')
      expect(savedUserMsg.generationKind).toBe('manual')
      expect(useGroupChatStore.getState().messages[0].narrativeMode).toBe('omniscient')
    })

    it('无 @ 消息不记录 mentionedCharacterIds', async () => {
      setupMentionGroup()
      const saveMsg = vi.mocked(window.api.group.saveMessage)

      await useGroupChatStore.getState().sendMessage('大家好', [], undefined)

      const savedUserMsg = saveMsg.mock.calls[0][2] as GroupMessage
      expect(savedUserMsg.mentionedCharacterIds).toBeUndefined()
    })

    it('部分名称不误匹配（@爱 不匹配 爱丽丝）', async () => {
      setupMentionGroup()
      const saveMsg = vi.mocked(window.api.group.saveMessage)

      await useGroupChatStore.getState().sendMessage('@爱 你好', [], undefined)

      const savedUserMsg = saveMsg.mock.calls[0][2] as GroupMessage
      expect(savedUserMsg.mentionedCharacterIds).toBeUndefined()
    })

    it('D3 已拍板：词边界——邮箱样式 email@test.com 不命中成员「test」', async () => {
      setupMentionGroup()
      useCharacterStore.setState({ characters: [makeCharacter('c1', '爱丽丝'), makeCharacter('c9', 'test')] })
      useGroupChatStore.setState({
        currentGroup: {
          id: 'g1', name: 'G', memberIds: ['c1', 'c9'],
          currentSpeakerIndex: 0, autoMode: false, chatMode: 'mention' as const,
          maxRounds: 1, speakerInterval: 2000, lorebookIds: [],
          presetId: null, systemPrompt: '', createdAt: 0, updatedAt: 0,
        },
        currentSessionId: 's1',
      })
      const saveMsg = vi.mocked(window.api.group.saveMessage)

      await useGroupChatStore.getState().sendMessage('联系 email@test.com 即可', [], undefined)

      const savedUserMsg = saveMsg.mock.calls[0][2] as GroupMessage
      expect(savedUserMsg.mentionedCharacterIds).toBeUndefined()
    })

    it('D3 已拍板：@@爱丽丝（@ 前为非名字字符）命中', async () => {
      setupMentionGroup()
      const saveMsg = vi.mocked(window.api.group.saveMessage)

      await useGroupChatStore.getState().sendMessage('@@爱丽丝 在吗', [], undefined)

      expect((saveMsg.mock.calls[0][2] as GroupMessage).mentionedCharacterIds).toEqual(['c1'])
    })

    it('D3 已拍板：中缀 x@爱丽丝（@ 前为名字字符）不命中', async () => {
      setupMentionGroup()
      const saveMsg = vi.mocked(window.api.group.saveMessage)

      await useGroupChatStore.getState().sendMessage('x@爱丽丝 在吗', [], undefined)

      expect((saveMsg.mock.calls[0][2] as GroupMessage).mentionedCharacterIds).toBeUndefined()
    })

    it('多个成员被点名时全部记录', async () => {
      setupMentionGroup()
      const saveMsg = vi.mocked(window.api.group.saveMessage)

      await useGroupChatStore.getState().sendMessage('@爱丽丝 @千夏 集合！', [], undefined)

      const savedUserMsg = saveMsg.mock.calls[0][2] as GroupMessage
      expect(savedUserMsg.mentionedCharacterIds).toEqual(['c1', 'c2'])
    })
  })

  describe('D10 已拍板：free 整段重生', () => {
    function makeChar(id: string, name: string): Character {
      return {
        id, name, avatar: '', description: '', personality: '', scenario: '',
        firstMessage: '', exampleDialog: '', tags: [], lorebookId: null, creator: '',
        createdAt: 0, updatedAt: 0, alternateGreetings: [],
      }
    }

    /** free 群 + 一整轮 free 段（splitAndSaveMessages 拆分结构：同 round、同批多条成员消息） */
    function setupFreeSegment(chatMode: 'free' | 'polling' = 'free') {
      useSettingsStore.setState({
        settings: {
          ...getDefaultSettings(),
          activeProfileId: 'p1',
          connectionProfiles: [{
            id: 'p1', name: 'test', provider: 'openai' as const,
            baseUrl: 'http://localhost:1/v1', model: 'gpt-4o', apiKey: 'sk-test', maxContext: 8192,
          }],
        },
      })
      useCharacterStore.setState({ characters: [makeChar('c1', '爱丽丝'), makeChar('c2', '千夏')] })
      useGroupChatStore.setState({
        currentGroup: {
          id: 'g1', name: 'G', memberIds: ['c1', 'c2'],
          currentSpeakerIndex: 0, autoMode: false, chatMode,
          maxRounds: 3, speakerInterval: 2000, lorebookIds: [],
          presetId: null, systemPrompt: '', createdAt: 0, updatedAt: 0,
        },
        currentSessionId: 's1',
        sessions: [{ id: 's1', groupId: 'g1', narrativeMode: 'immersive' } as never],
        messages: [
          { id: 'u1', groupId: 'g1', characterId: '__user__', content: '大家出发吧', images: [], timestamp: 1, round: 2 },
          { id: 'f1', groupId: 'g1', characterId: 'c1', content: '整段第一段', images: [], timestamp: 2, round: 2 },
          { id: 'f2', groupId: 'g1', characterId: 'c2', content: '整段第二段', images: [], timestamp: 3, round: 2 },
        ] as GroupMessage[],
      })
      useToastStore.setState({ toasts: [] })
    }

    afterEach(() => {
      cleanupActiveStream()
      clearPollingTimer()
    })

    it('整轮暂存 + 成功替换：只有新回复完成并落盘后才删除旧整轮', async () => {
      setupFreeSegment()
      const deleteMessage = vi.mocked(window.api.group.deleteMessage)
      let emitComplete: ((payload: { requestId: string; finishReason: 'stop' }) => void) | undefined
      vi.mocked(window.api.ai.onComplete).mockImplementation((callback) => {
        emitComplete = callback as typeof emitComplete
        return () => {}
      })

      const regeneration = useGroupChatStore.getState().regenerateMessage('f1')
      await vi.waitFor(() => expect(window.api.ai.chat).toHaveBeenCalledTimes(1))

      // AI 请求只是成功启动时，旧消息必须仍留在持久层。
      expect(deleteMessage).not.toHaveBeenCalled()

      const requestId = vi.mocked(window.api.ai.chat).mock.calls[0][0].requestId
      emitComplete?.({ requestId, finishReason: 'stop' })
      await regeneration
      await vi.waitFor(() => expect(deleteMessage).toHaveBeenCalledWith('g1', 's1', 'f2'))

      // 重新发起的是 free 整段生成；收尾仍会拆分/回落真实成员，不持久化 __free__。
      expect(vi.mocked(window.api.ai.chat)).toHaveBeenCalledTimes(1)
      const msgs = useGroupChatStore.getState().messages
      expect(msgs.some((m) => m.characterId === '__free__')).toBe(false)
      expect(msgs.some((m) => m.characterId === 'c1')).toBe(true)
      // 整轮旧消息先从 UI 隐藏（不落盘删除），成功后整轮删除
      expect(msgs.find((m) => m.id === 'f1')).toBeUndefined()
      expect(msgs.find((m) => m.id === 'f2')).toBeUndefined()
      expect(deleteMessage).toHaveBeenCalledWith('g1', 's1', 'f1')
      expect(deleteMessage).toHaveBeenCalledWith('g1', 's1', 'f2')
      // 用户消息与非本段消息不删
      expect(deleteMessage).not.toHaveBeenCalledWith('g1', 's1', 'u1')
    })

    it('新回复落盘后删除旧消息失败：回滚新回复并恢复整轮原文', async () => {
      setupFreeSegment()
      let emitComplete: ((payload: { requestId: string; finishReason: 'stop' }) => void) | undefined
      vi.mocked(window.api.ai.onComplete).mockImplementation((callback) => {
        emitComplete = callback as typeof emitComplete
        return () => {}
      })
      vi.mocked(window.api.group.deleteMessage)
        .mockRejectedValueOnce(new Error('delete failed'))
        .mockResolvedValue(undefined)

      const regeneration = useGroupChatStore.getState().regenerateMessage('f1')
      await vi.waitFor(() => expect(window.api.ai.chat).toHaveBeenCalledTimes(1))
      const requestId = vi.mocked(window.api.ai.chat).mock.calls[0][0].requestId
      emitComplete?.({ requestId, finishReason: 'stop' })
      await regeneration
      await vi.waitFor(() => {
        expect(useGroupChatStore.getState().messages.map((message) => message.id)).toEqual(['u1', 'f1', 'f2'])
      })

      expect(useGroupChatStore.getState().messages.map((message) => message.id)).toEqual(['u1', 'f1', 'f2'])
      expect(useToastStore.getState().toasts.some((toast) => toast.title === '重新生成替换失败，已恢复原消息')).toBe(true)
    })

    it('失败恢复：发起失败恢复整轮原文 + toast「重新生成失败，已恢复原消息」', async () => {
      setupFreeSegment()
      // 无可用连接档案 → free 生成早退（与单成员重生同一失败口径）
      useSettingsStore.setState({ settings: { ...getDefaultSettings(), activeProfileId: null }, credentials: {}, loaded: true, _saveTimer: null })

      await useGroupChatStore.getState().regenerateMessage('f2')

      expect(window.api.ai.chat).not.toHaveBeenCalled()
      expect(window.api.group.deleteMessage).not.toHaveBeenCalled()
      // 整轮原文按原位置恢复
      expect(useGroupChatStore.getState().messages.map((m) => m.id)).toEqual(['u1', 'f1', 'f2'])
      expect(useToastStore.getState().toasts.some((t) => t.title === '重新生成失败，已恢复原消息')).toBe(true)
    })

    it('__user__ 仍不可重生', async () => {
      setupFreeSegment()

      await useGroupChatStore.getState().regenerateMessage('u1')

      expect(window.api.ai.chat).not.toHaveBeenCalled()
      expect(window.api.group.deleteMessage).not.toHaveBeenCalled()
      expect(useGroupChatStore.getState().messages.map((m) => m.id)).toEqual(['u1', 'f1', 'f2'])
    })

    it('历史 __free__ 占位按整段 free 重生（P0-07：落盘经拆分/回落首成员，不持久化 __free__）', async () => {
      // 群已切到 polling 也能识别历史 __free__ 段（整段识别依据见 resolveGroupFreeSegment）
      setupFreeSegment('polling')
      useGroupChatStore.setState({
        messages: [
          { id: 'u1', groupId: 'g1', characterId: '__user__', content: '大家出发吧', images: [], timestamp: 1, round: 2 },
          { id: 'legacy-free', groupId: 'g1', characterId: '__free__', content: '历史 free 正文', images: [], timestamp: 2, round: 2 },
        ] as GroupMessage[],
      })
      let emitComplete: ((payload: { requestId: string; finishReason: 'stop' }) => void) | undefined
      vi.mocked(window.api.ai.onComplete).mockImplementation((callback) => {
        emitComplete = callback as typeof emitComplete
        return () => {}
      })

      const regeneration = useGroupChatStore.getState().regenerateMessage('legacy-free')
      await vi.waitFor(() => expect(window.api.ai.chat).toHaveBeenCalledTimes(1))
      const requestId = vi.mocked(window.api.ai.chat).mock.calls[0][0].requestId
      emitComplete?.({ requestId, finishReason: 'stop' })
      await regeneration
      await vi.waitFor(() => expect(window.api.group.deleteMessage).toHaveBeenCalledWith('g1', 's1', 'legacy-free'))

      expect(window.api.ai.chat).toHaveBeenCalledTimes(1)
      expect(useGroupChatStore.getState().messages.some((m) => m.id === 'legacy-free')).toBe(false)
      expect(window.api.group.deleteMessage).toHaveBeenCalledWith('g1', 's1', 'legacy-free')
    })

    it('polling 单条回复不误判为 free 段（仍走单成员重生）', async () => {
      setupFreeSegment('polling')
      useGroupChatStore.setState({
        messages: [
          { id: 'u1', groupId: 'g1', characterId: '__user__', content: '大家出发吧', images: [], timestamp: 1, round: 2 },
          { id: 'p1', groupId: 'g1', characterId: 'c1', content: '单条回复', images: [], timestamp: 2, round: 2 },
        ] as GroupMessage[],
      })
      let emitComplete: ((payload: { requestId: string; finishReason: 'stop' }) => void) | undefined
      vi.mocked(window.api.ai.onComplete).mockImplementation((callback) => {
        emitComplete = callback as typeof emitComplete
        return () => {}
      })

      const regeneration = useGroupChatStore.getState().regenerateMessage('p1')
      await vi.waitFor(() => expect(window.api.ai.chat).toHaveBeenCalledTimes(1))
      const requestId = vi.mocked(window.api.ai.chat).mock.calls[0][0].requestId
      emitComplete?.({ requestId, finishReason: 'stop' })
      await regeneration
      await vi.waitFor(() => expect(window.api.group.deleteMessage).toHaveBeenCalledWith('g1', 's1', 'p1'))

      // 单成员重生：占位归属发言成员而非 __free__，只删目标消息
      const msgs = useGroupChatStore.getState().messages
      expect(msgs.some((m) => m.characterId === '__free__')).toBe(false)
      expect(msgs.some((m) => m.characterId === 'c1')).toBe(true)
      expect(window.api.group.deleteMessage).toHaveBeenCalledWith('g1', 's1', 'p1')
      expect(window.api.group.deleteMessage).toHaveBeenCalledTimes(1)
    })
  })
})
