/**
 * “下一步方向”稳定性回归（用户反馈：开启后时有“生成不出来”，以及生成几秒后自动消失）。
 *
 * 锁住两条不变量：
 * 1. 方向是否仍然可见，只取决于「产生它的那条消息」是否被改动——
 *    会话的世界状态 / 叙事模式 / 身份刷新不得让已生成的方向凭空消失；
 * 2. 服务端未返回 finish_reason（'unknown'）不等于正文不可用，不得整段丢弃；
 *    自动链路失败必须给出可见提示（toast），手动「换一批」只走内联错误。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Character, Message } from '../../../shared/types'
import { matchesFeatureSource } from '../../../shared/featureSource'
import { generateSingleDialogueDirections } from '../dialogueDirectionRunner'
import { useSettingsStore } from '../useSettingsStore'
import { useToastStore } from '../useToastStore'
import type { ChatState } from '../../features/chat/chatStoreTypes'

const DIRECTIONS = [
  { id: 'safe', label: '追问封锁原因', content: '先不与守卫冲突，试着追问港口突然封锁的原因。', tendency: 'safe' },
  { id: 'explore', label: '寻找其他入口', content: '暂时离开正门，沿港口外围查看是否存在无人值守的通道。', tendency: 'explore' },
  { id: 'risky', label: '冒险直接闯关', content: '趁守卫注意力被分散时尝试突破封锁，承担立即暴露的风险。', tendency: 'risky' },
] as const

function makeCharacter(): Character {
  return {
    id: 'char-1', name: '艾莉丝', avatar: '', description: '港口守卫队长',
    personality: '', scenario: '', firstMessage: '', exampleDialog: '', tags: [],
    lorebookId: null, creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [],
  }
}

function makeMessages(): Message[] {
  return [
    { id: 'u1', sessionId: 's1', characterId: 'char-1', role: 'user', content: '港口发生了什么？', images: [], isEditing: false, timestamp: 1 },
    { id: 'a1', sessionId: 's1', characterId: 'char-1', role: 'assistant', content: '港口已经封锁，任何人都不能通过。', images: [], isEditing: false, timestamp: 2, narrativeMode: 'immersive' },
  ]
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1', characterId: 'char-1', title: '港口', narrativeMode: 'immersive',
    dialogueDirectionsEnabled: true, memoryCurrentState: '北门封锁', ...overrides,
  }
}

function makeStore(messages: Message[], session = makeSession()) {
  const state = {
    messages,
    sessions: [session],
    currentSessionId: 's1',
  } as unknown as ChatState
  const set = vi.fn((partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => {
    const next = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, next)
  })
  return { set, get: () => state, raw: state }
}

function stubAiText(text: string, finishReason: import('../../../shared/types').AIFinishReason = 'stop') {
  let onChunkCb: ((data: { requestId: string; text: string }) => void) | undefined
  let onCompleteCb: ((payload: import('../../../shared/ipc-api').AIDonePayload) => void) | undefined
  vi.mocked(window.api.ai.onChunk).mockImplementation((cb) => { onChunkCb = cb; return vi.fn() })
  vi.mocked(window.api.ai.onComplete).mockImplementation((cb) => { onCompleteCb = cb; return vi.fn() })
  vi.mocked(window.api.ai.onError).mockReturnValue(vi.fn())
  vi.mocked(window.api.ai.chat).mockImplementation(async (params) => {
    queueMicrotask(() => {
      onChunkCb?.({ requestId: params.requestId, text })
      onCompleteCb?.({ requestId: params.requestId, finishReason })
    })
  })
}

/** 与 MessageBubble / GroupChatMessage 选择器同一判定式。 */
function isVisibleNow(state: ChatState, messageId: string): boolean {
  const message = state.messages.find((m) => m.id === messageId)
  if (!message?.dialogueDirectionsSource) return false
  return matchesFeatureSource(
    message.dialogueDirectionsSource,
    state.messages,
    state.sessions.find((s) => s.id === message.sessionId),
  )
}

describe('方向可见性只跟随目标消息', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(window.api.preset.list).mockResolvedValue([])
    vi.mocked(window.api.chat.commitFeatureResult).mockResolvedValue(true)
    useToastStore.setState({ toasts: [] })
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        userName: '林舟',
        activeProfileId: 'p1',
        connectionProfiles: [{
          id: 'p1', name: '测试', provider: 'openai', apiKey: 'sk-test',
          baseUrl: 'https://api.example.com', model: 'test-model',
        }] as never,
      },
    }))
  })

  it('会话世界状态刷新后方向仍然可见（此前的“几秒后自动消失”）', async () => {
    stubAiText(`<directions>${JSON.stringify(DIRECTIONS)}</directions>`)
    const { set, get, raw } = makeStore(makeMessages())

    const applied = await generateSingleDialogueDirections(
      set as never, get as never, { messageId: 'a1', character: makeCharacter() },
    )

    expect(applied).toHaveLength(3)
    expect(isVisibleNow(raw, 'a1')).toBe(true)

    // 模拟回复完成几秒后：长记忆写回新的 memoryCurrentState，渲染层刷新 sessions
    raw.sessions = [makeSession({ memoryCurrentState: '港口全境封锁，北门与南门均有守卫。' })] as never
    expect(isVisibleNow(raw, 'a1')).toBe(true)

    // 叙事模式与身份同理：属于会话级刷新，不应让卡片消失
    raw.sessions = [makeSession({ memoryCurrentState: '港口全境封锁，北门与南门均有守卫。', narrativeMode: 'omniscient', personaId: 'p2' })] as never
    expect(isVisibleNow(raw, 'a1')).toBe(true)
  })

  it('来源指纹不再包含会话字段（主进程复核同样口径）', async () => {
    stubAiText(`<directions>${JSON.stringify(DIRECTIONS)}</directions>`)
    const { set, get } = makeStore(makeMessages())

    await generateSingleDialogueDirections(set as never, get as never, { messageId: 'a1', character: makeCharacter() })

    const commit = vi.mocked(window.api.chat.commitFeatureResult).mock.calls[0][2] as { source: { mode: string; session?: unknown; messages: unknown[] } }
    expect(commit.source.mode).toBe('message')
    expect(commit.source.session).toBeUndefined()
    expect(commit.source.messages).toHaveLength(1)
  })

  it('目标消息正文被替换后方向失效（重生成 / 编辑 / Swipe）', async () => {
    stubAiText(`<directions>${JSON.stringify(DIRECTIONS)}</directions>`)
    const { set, get, raw } = makeStore(makeMessages())

    await generateSingleDialogueDirections(set as never, get as never, { messageId: 'a1', character: makeCharacter() })
    expect(isVisibleNow(raw, 'a1')).toBe(true)

    raw.messages = raw.messages.map((message) => message.id === 'a1'
      ? { ...message, content: '港口已经解封，守卫换成了商队。' }
      : message) as never
    expect(isVisibleNow(raw, 'a1')).toBe(false)
  })

  it('其他消息增删不影响已生成的方向', async () => {
    stubAiText(`<directions>${JSON.stringify(DIRECTIONS)}</directions>`)
    const { set, get, raw } = makeStore(makeMessages())

    await generateSingleDialogueDirections(set as never, get as never, { messageId: 'a1', character: makeCharacter() })
    raw.messages = [...raw.messages, { id: 'sys-1', sessionId: 's1', characterId: 'char-1', role: 'system', content: '已保存', images: [], isEditing: false, timestamp: 99 }] as never

    expect(isVisibleNow(raw, 'a1')).toBe(true)
  })

  it('服务端不返回 finish_reason（unknown）时仍接受正文', async () => {
    stubAiText(`<directions>${JSON.stringify(DIRECTIONS)}</directions>`, 'unknown')
    const { set, get, raw } = makeStore(makeMessages())

    const applied = await generateSingleDialogueDirections(
      set as never, get as never, { messageId: 'a1', character: makeCharacter() },
    )

    expect(applied).toHaveLength(3)
    expect(raw.messages.find((m) => m.id === 'a1')?.dialogueDirections).toHaveLength(3)
  })

  it('截断（length）仍按失败处理，不写入半截结构', async () => {
    stubAiText(`<directions>${JSON.stringify(DIRECTIONS)}</directions>`, 'length')
    const { set, get, raw } = makeStore(makeMessages())

    const applied = await generateSingleDialogueDirections(
      set as never, get as never, { messageId: 'a1', character: makeCharacter() },
    )

    expect(applied).toEqual([])
    expect(raw.messages.find((m) => m.id === 'a1')?.dialogueDirections).toBeUndefined()
  })
})

describe('失败可见性', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(window.api.preset.list).mockResolvedValue([])
    useToastStore.setState({ toasts: [] })
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        userName: '林舟',
        activeProfileId: 'p1',
        connectionProfiles: [{
          id: 'p1', name: '测试', provider: 'openai', apiKey: 'sk-test',
          baseUrl: 'https://api.example.com', model: 'test-model',
        }] as never,
      },
    }))
  })

  it('自动链路提交被拒（并发写入导致来源失配）时弹一次可见提示', async () => {
    stubAiText(`<directions>${JSON.stringify(DIRECTIONS)}</directions>`)
    const { set, get } = makeStore(makeMessages())
    vi.mocked(window.api.chat.commitFeatureResult).mockResolvedValue(false)

    const applied = await generateSingleDialogueDirections(
      set as never, get as never, { messageId: 'a1', character: makeCharacter(), notifyFailure: true },
    )

    expect(applied).toEqual([])
    expect(useToastStore.getState().toasts.map((t) => t.title)).toContain('下一步方向生成失败')
  })

  it('手动「换一批」失败不弹窗（由卡片内联错误提示）', async () => {
    stubAiText(`<directions>${JSON.stringify(DIRECTIONS)}</directions>`)
    const { set, get } = makeStore(makeMessages())
    vi.mocked(window.api.chat.commitFeatureResult).mockResolvedValue(false)

    await generateSingleDialogueDirections(set as never, get as never, { messageId: 'a1', character: makeCharacter() })

    expect(useToastStore.getState().toasts).toHaveLength(0)
  })
})
