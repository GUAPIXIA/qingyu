/**
 * 群聊“等待用户节点”门控：只有自动接力结束后才生成下一步方向，
 * 中间轮次不得为每条回复都发起方向请求（方案 §4.4）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { generateGroupDialogueDirectionsMock, refreshGroupDialogueDirectionsMock, checkPollingContinueMock } = vi.hoisted(() => ({
  generateGroupDialogueDirectionsMock: vi.fn(async () => []),
  refreshGroupDialogueDirectionsMock: vi.fn(async () => undefined),
  checkPollingContinueMock: vi.fn(async () => false),
}))

// 模块级替换：store 内部通过模块导出调用，因此刷新入口同样需要被替换
// （refreshGroupDialogueDirections 的真实行为由 dialogueDirectionRunner.test.ts 覆盖）
vi.mock('../dialogueDirectionRunner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../dialogueDirectionRunner')>()
  return {
    ...actual,
    generateGroupDialogueDirections: generateGroupDialogueDirectionsMock,
    refreshGroupDialogueDirections: refreshGroupDialogueDirectionsMock,
  }
})

// streamGroupAI 立即回调 onComplete，模拟一次完成的角色回复
vi.mock('../groupStreamController', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../groupStreamController')>()
  return {
    ...actual,
    checkPollingContinue: checkPollingContinueMock,
    // 真实实现先落盘并把 isStreaming 置回 false，再调用 onComplete（groupStreamController）
    streamGroupAI: vi.fn(async (set, _get, _group, _sessionId, speaker, round, onComplete) => {
      set({ isStreaming: false })
      onComplete()
      void speaker; void round
    }),
    streamGroupAIFree: vi.fn(async () => { /* noop */ }),
    checkAutoMemory: vi.fn(),
    cleanupActiveStream: vi.fn(),
    clearPollingTimer: vi.fn(),
    getActiveStream: vi.fn(() => null),
  }
})

import { useGroupChatStore } from '../useGroupChatStore'
import { useSettingsStore } from '../useSettingsStore'
import { useCharacterStore } from '../useCharacterStore'
import { getDefaultSettings } from '../../../shared/defaults'
import type { Character, GroupChat } from '../../../shared/types'

function makeCharacter(): Character {
  return {
    id: 'char-1', name: '艾莉丝', avatar: '', description: '', personality: '',
    scenario: '', firstMessage: '', exampleDialog: '', tags: [], lorebookId: null,
    creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [],
  }
}

function setupGroup(opts: { chatMode: GroupChat['chatMode']; autoMode: boolean; directionsEnabled: boolean }) {
  useCharacterStore.setState({ characters: [makeCharacter()] })
  useSettingsStore.setState({
    settings: {
      ...getDefaultSettings(),
      userName: '林舟',
      // sendMessage 要求已配置连接
      activeProfileId: 'p1',
      connectionProfiles: [{
        id: 'p1', name: '测试', provider: 'openai', apiKey: 'sk-test',
        baseUrl: 'https://api.example.com', model: 'test-model',
      }] as never,
    },
    credentials: {}, loaded: true, _saveTimer: null,
  })
  const group: GroupChat = {
    id: 'g1', name: '群像', memberIds: ['char-1'], currentSpeakerIndex: 0,
    autoMode: opts.autoMode, chatMode: opts.chatMode, maxRounds: 3, speakerInterval: 1000,
    lorebookIds: [], presetId: null, systemPrompt: '', createdAt: 0, updatedAt: 0,
  }
  useGroupChatStore.setState({
    currentGroup: group,
    groupChats: [group],
    currentSessionId: 'gs1',
    sessions: [{
      id: 'gs1', groupId: 'g1', title: '会话', messageCount: 0, createdAt: 0, updatedAt: 0,
      dialogueDirectionsEnabled: opts.directionsEnabled,
    } as never],
    messages: [{
      id: 'ga1', groupId: 'g1', characterId: 'char-1', content: '港口已经封锁。',
      images: [], timestamp: 1, round: 1,
    } as never],
    isStreaming: false,
    error: null,
  })
}

describe('群聊等待用户节点门控', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    checkPollingContinueMock.mockResolvedValue(false)
  })

  it('mention 模式：回复完成即轮到用户，生成方向', async () => {
    setupGroup({ chatMode: 'mention', autoMode: false, directionsEnabled: true })

    await useGroupChatStore.getState().sendMessage('你好', [], 'char-1')

    expect(generateGroupDialogueDirectionsMock).toHaveBeenCalledTimes(1)
    expect(generateGroupDialogueDirectionsMock).toHaveBeenCalledWith(
      expect.any(Function), expect.any(Function),
      expect.objectContaining({ messageId: 'ga1', userName: '林舟' }),
    )
  })

  it('polling 自动接力仍在继续：不为中间回复生成方向', async () => {
    checkPollingContinueMock.mockResolvedValue(true)
    setupGroup({ chatMode: 'polling', autoMode: true, directionsEnabled: true })

    await useGroupChatStore.getState().sendMessage('你好', [], 'char-1')

    expect(checkPollingContinueMock).toHaveBeenCalled()
    expect(generateGroupDialogueDirectionsMock).not.toHaveBeenCalled()
  })

  it('polling 自动接力已结束（轮数上限）：生成方向', async () => {
    checkPollingContinueMock.mockResolvedValue(false)
    setupGroup({ chatMode: 'polling', autoMode: true, directionsEnabled: true })

    await useGroupChatStore.getState().sendMessage('你好', [], 'char-1')

    expect(generateGroupDialogueDirectionsMock).toHaveBeenCalledTimes(1)
  })

  it('会话未开启方向：即使轮到用户也不生成', async () => {
    setupGroup({ chatMode: 'mention', autoMode: false, directionsEnabled: false })

    await useGroupChatStore.getState().sendMessage('你好', [], 'char-1')

    expect(generateGroupDialogueDirectionsMock).not.toHaveBeenCalled()
  })

  it('切换群聊叙事模式后触发方向刷新', async () => {
    setupGroup({ chatMode: 'mention', autoMode: false, directionsEnabled: true })
    refreshGroupDialogueDirectionsMock.mockClear()

    await useGroupChatStore.getState().setSessionNarrativeMode('omniscient')

    expect(refreshGroupDialogueDirectionsMock).toHaveBeenCalledTimes(1)
  })

  it('模式未实际变化时不触发刷新', async () => {
    setupGroup({ chatMode: 'mention', autoMode: false, directionsEnabled: true })
    refreshGroupDialogueDirectionsMock.mockClear()

    await useGroupChatStore.getState().setSessionNarrativeMode('immersive')

    expect(refreshGroupDialogueDirectionsMock).not.toHaveBeenCalled()
  })

  it('用户发言后清空上一轮方向', async () => {
    setupGroup({ chatMode: 'mention', autoMode: false, directionsEnabled: true })
    useGroupChatStore.setState((st) => ({
      messages: st.messages.map((m) => ({
        ...m,
        dialogueDirections: [
          { id: 'safe', label: '追问原因', content: '先不与守卫冲突，试着追问封锁的原因。', tendency: 'safe' as const },
        ],
      })),
    }))

    await useGroupChatStore.getState().sendMessage('我压低声音问', [], 'char-1')

    const cleared = useGroupChatStore.getState().messages.filter(
      (m) => (m.dialogueDirections?.length ?? 0) > 0,
    )
    expect(cleared).toHaveLength(0)
  })

  it('即时接话（人工一次性触发）完成后生成方向', async () => {
    setupGroup({ chatMode: 'free', autoMode: false, directionsEnabled: true })

    await useGroupChatStore.getState().triggerCharacterReply('char-1')

    expect(generateGroupDialogueDirectionsMock).toHaveBeenCalledTimes(1)
  })
})
