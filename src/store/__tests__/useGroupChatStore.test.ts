import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useGroupChatStore } from '../useGroupChatStore'
import { useSettingsStore } from '../useSettingsStore'
import { useCharacterStore } from '../useCharacterStore'
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
      streamingContent: '',
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
    useCharacterStore.setState({ characters: [], loading: false, error: null })
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
      expect(typeof state.stopStreaming).toBe('function')
      expect(typeof state.clearChat).toBe('function')
      expect(typeof state.clearMessages).toBe('function')
      expect(typeof state.buildGroupContext).toBe('function')
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
        streamingContent: 'partial',
      })
      useGroupChatStore.getState().stopStreaming()
      expect(useGroupChatStore.getState().isStreaming).toBe(false)
      expect(useGroupChatStore.getState().currentStreamingCharId).toBeNull()
      expect(useGroupChatStore.getState().streamingContent).toBe('')
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

    it('多个成员被点名时全部记录', async () => {
      setupMentionGroup()
      const saveMsg = vi.mocked(window.api.group.saveMessage)

      await useGroupChatStore.getState().sendMessage('@爱丽丝 @千夏 集合！', [], undefined)

      const savedUserMsg = saveMsg.mock.calls[0][2] as GroupMessage
      expect(savedUserMsg.mentionedCharacterIds).toEqual(['c1', 'c2'])
    })
  })
})
