import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  splitAndSaveMessages,
  checkAutoMemory,
  checkPollingContinue,
  cleanupActiveStream,
  clearPollingTimer,
  getActiveStream,
  markPendingGroupCompression,
} from '../groupStreamController'
import { useSettingsStore } from '../useSettingsStore'
import { useCharacterStore } from '../useCharacterStore'
import { getDefaultSettings } from '../../../shared/defaults'
import type { GroupChat, GroupMessage, Character } from '../../../shared/types'

function makeCharacter(id: string, name: string): Character {
  return {
    id, name, avatar: '', description: '', personality: '',
    scenario: '', firstMessage: '', exampleDialog: '', tags: [], lorebookId: null,
    creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [],
  }
}

function makeGroup(overrides: Partial<GroupChat> = {}): GroupChat {
  return {
    id: 'g1', name: '测试群', memberIds: ['c1', 'c2'],
    currentSpeakerIndex: 0, autoMode: false, chatMode: 'polling',
    maxRounds: 3, speakerInterval: 2000, lorebookIds: [],
    presetId: null, systemPrompt: '', createdAt: 0, updatedAt: 0,
    ...overrides,
  }
}

function setup() {
  useSettingsStore.setState({
    settings: { ...getDefaultSettings(), userName: '用户', activeProfileId: 'p1' } as any,
    credentials: {}, loaded: true, _saveTimer: null,
  })
  useCharacterStore.setState({
    characters: [makeCharacter('c1', '爱丽丝'), makeCharacter('c2', '千夏')],
  })
  ;(window.api.group as any).saveMessage = vi.fn().mockResolvedValue(undefined)
  ;(window.api.group as any).save = vi.fn().mockResolvedValue(undefined)
}

describe('splitAndSaveMessages 群聊自由发言拆分', () => {
  beforeEach(() => {
    setup()
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanupActiveStream()
    clearPollingTimer()
    vi.useRealTimers()
  })

  it('按【角色名】拆分多条消息并保存', async () => {
    const set = vi.fn()
    const content = '【爱丽丝】你好呀\n【千夏】大家好！'
    await splitAndSaveMessages(set as any, (() => ({})) as any, makeGroup(), 's1', content, 2, 'ph-1')

    expect(window.api.group.saveMessage).toHaveBeenCalledTimes(2)
    const calls = vi.mocked(window.api.group.saveMessage).mock.calls
    const saved1 = calls[0][2] as GroupMessage
    const saved2 = calls[1][2] as GroupMessage
    expect(saved1.characterId).toBe('c1')
    expect(saved1.content).toBe('你好呀')
    expect(saved2.characterId).toBe('c2')
    expect(saved2.content).toBe('大家好！')

    // 占位消息被移除，新消息加入并按时间排序
    const state = set.mock.calls[0][0]({ messages: [{ id: 'ph-1' }] })
    expect(state.messages.some((m: GroupMessage) => m.id === 'ph-1')).toBe(false)
    expect(state.messages).toHaveLength(2)
    expect(state.isStreaming).toBe(false)
  })

  it('角色名匹配大小写与空格不敏感', async () => {
    const set = vi.fn()
    await splitAndSaveMessages(set as any, (() => ({})) as any, makeGroup(), 's1', '【 爱丽丝 】说话', 1, 'ph')
    const saved = vi.mocked(window.api.group.saveMessage).mock.calls[0][2] as GroupMessage
    expect(saved.characterId).toBe('c1')
  })

  it('未识别角色内容追加到前一条成员消息', async () => {
    const set = vi.fn()
    const content = '【爱丽丝】第一句\n【路人甲】乱入内容'
    await splitAndSaveMessages(set as any, (() => ({})) as any, makeGroup(), 's1', content, 1, 'ph')

    const saved = vi.mocked(window.api.group.saveMessage).mock.calls
    // 第一条是爱丽丝，路人甲的内容追加到爱丽丝消息中
    expect(saved[0][2].content).toContain('第一句')
    expect(saved[0][2].content).toContain('未识别角色「路人甲」: 乱入内容')
    expect(saved).toHaveLength(1)
  })

  it('无任何角色标记时回退为第一个成员消息', async () => {
    const set = vi.fn()
    await splitAndSaveMessages(set as any, (() => ({})) as any, makeGroup(), 's1', '没有标记的普通文本', 1, 'ph-1')

    const state = set.mock.calls[0][0]({ messages: [{ id: 'ph-1' }] })
    const msg = state.messages.find((m: GroupMessage) => m.id === 'ph-1')
    expect(msg.characterId).toBe('c1')
    expect(msg.content).toBe('没有标记的普通文本')
    expect(window.api.group.saveMessage).toHaveBeenCalledWith('g1', 's1', expect.objectContaining({
      id: 'ph-1', characterId: 'c1',
    }))
  })

  it('首段角色标记前有 preamble 文本时保留', async () => {
    const set = vi.fn()
    const content = '（旁白）\n【爱丽丝】正文'
    await splitAndSaveMessages(set as any, (() => ({})) as any, makeGroup(), 's1', content, 1, 'ph')
    const saved = vi.mocked(window.api.group.saveMessage).mock.calls[0][2] as GroupMessage
    expect(saved.content).toBe('正文')
  })

  it('占位消息更新为空内容时使用 (无回复)', async () => {
    const set = vi.fn()
    await splitAndSaveMessages(set as any, (() => ({})) as any, makeGroup(), 's1', '', 1, 'ph-1')
    const state = set.mock.calls[0][0]({ messages: [{ id: 'ph-1' }] })
    const msg = state.messages.find((m: GroupMessage) => m.id === 'ph-1')
    expect(msg.content).toBe('(无回复)')
  })
})

describe('checkAutoMemory 自动记忆触发', () => {
  it('记忆未启用或非 auto 模式时不触发', () => {
    const state = {
      sessions: [{ id: 's1', memoryEnabled: false, memoryMode: 'auto', autoMemoryInterval: 10, memoryUpdatedAt: 0 }],
      currentSessionId: 's1',
      messages: [],
      triggerMemorySummary: vi.fn(),
    }
    checkAutoMemory((() => state) as any)
    expect(state.triggerMemorySummary).not.toHaveBeenCalled()
  })

  it('新消息数达到间隔时触发摘要', () => {
    const trigger = vi.fn()
    const state = {
      sessions: [{ id: 's1', memoryEnabled: true, memoryMode: 'auto', autoMemoryInterval: 3, memoryUpdatedAt: 0 }],
      currentSessionId: 's1',
      messages: [
        { id: 'a', timestamp: 100 }, { id: 'b', timestamp: 200 }, { id: 'c', timestamp: 300 },
      ],
      triggerMemorySummary: trigger,
    }
    checkAutoMemory((() => state) as any)
    expect(trigger).toHaveBeenCalled()
  })

  it('新消息数不足时不触发', () => {
    const trigger = vi.fn()
    const state = {
      sessions: [{ id: 's1', memoryEnabled: true, memoryMode: 'auto', autoMemoryInterval: 10, memoryUpdatedAt: 0 }],
      currentSessionId: 's1',
      messages: [{ id: 'a', timestamp: 100 }, { id: 'b', timestamp: 200 }],
      triggerMemorySummary: trigger,
    }
    checkAutoMemory((() => state) as any)
    expect(trigger).not.toHaveBeenCalled()
  })
})

describe('checkPollingContinue polling 轮询', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    clearPollingTimer()
    vi.useRealTimers()
  })

  it('达到最大轮数时不继续', async () => {
    const set = vi.fn()
    const state = {
      currentGroup: makeGroup({ maxRounds: 1 }),
      messages: [
        { characterId: 'c1', round: 1 },
        { characterId: 'c2', round: 1 },
      ],
      memberIds: ['c1', 'c2'],
      sendPollingRound: vi.fn(),
    }
    await checkPollingContinue(set as any, (() => state) as any, makeGroup())
    expect(state.sendPollingRound).not.toHaveBeenCalled()
  })

  it('无最后角色消息时不继续', async () => {
    const set = vi.fn()
    const state = {
      currentGroup: makeGroup(),
      messages: [{ characterId: '__user__', round: 1 }],
      sendPollingRound: vi.fn(),
    }
    await checkPollingContinue(set as any, (() => state) as any, makeGroup())
    expect(state.sendPollingRound).not.toHaveBeenCalled()
  })

  it('正常时更新 speaker 并定时触发下一轮', async () => {
    const set = vi.fn()
    const sendPollingRound = vi.fn()
    const group = makeGroup({ currentSpeakerIndex: 0 })
    const state = {
      currentGroup: group,
      messages: [{ characterId: 'c1', round: 1 }],
      memberIds: ['c1', 'c2'],
      isStreaming: false,
      sendPollingRound,
    }
    await checkPollingContinue(set as any, (() => state) as any, group)

    // currentSpeakerIndex 更新为下一个成员
    expect(set).toHaveBeenCalledWith({ currentGroup: { ...group, currentSpeakerIndex: 1 } })
    expect(window.api.group.save).toHaveBeenCalled()

    // 定时器触发后发送下一轮
    await vi.advanceTimersByTimeAsync(2000)
    expect(sendPollingRound).toHaveBeenCalledWith('c2')
  })

  it('定时器触发时若正在流式则不继续', async () => {
    const set = vi.fn()
    const sendPollingRound = vi.fn()
    const group = makeGroup({ currentSpeakerIndex: 0 })
    const state = {
      currentGroup: group,
      messages: [{ characterId: 'c1', round: 1 }],
      memberIds: ['c1', 'c2'],
      isStreaming: true, // 流式中
      sendPollingRound,
    }
    await checkPollingContinue(set as any, (() => state) as any, group)
    await vi.advanceTimersByTimeAsync(2000)
    expect(sendPollingRound).not.toHaveBeenCalled()
  })
})

describe('流状态管理', () => {
  afterEach(() => {
    cleanupActiveStream()
    clearPollingTimer()
  })

  it('getActiveStream 初始为 null', () => {
    expect(getActiveStream()).toBeNull()
  })

  it('cleanupActiveStream 对空状态安全', () => {
    expect(() => cleanupActiveStream()).not.toThrow()
  })

  it('markPendingGroupCompression 记录压缩任务（get 为内部状态无法直读，验证不抛错）', () => {
    expect(() => markPendingGroupCompression({
      groupId: 'g1', sessionId: 's1', droppedText: 'x', droppedStartTs: 0, droppedEndTs: 1,
    })).not.toThrow()
  })
})
