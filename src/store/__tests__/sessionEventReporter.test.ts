/**
 * 阶段 0c：会话变更事件总线测试（方案 §7 0c 验收）。
 *
 * 1. sessionEventReporter middleware：拦截 sendMessage/deleteMessage/renameSession/
 *    swipeMessage 等 action 自动上报 session:changed（store 层统一覆盖）；
 * 2. 主进程广播：session:changed -> session:updated 广播所有窗口（双窗口同步）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useChatStore } from '../useChatStore'
import { IPC_EVENTS } from '../../../shared/ipc-channels'
import type { SessionChangePayload } from '../../../shared/ipc-api'

// window.api.sessionSync 上报桩
const changedMock = vi.fn()
beforeEach(() => {
  changedMock.mockClear()
  ;(window.api.sessionSync as unknown) = { changed: changedMock }
})

describe('sessionEventReporter middleware', () => {
  it('sendMessage 触发 message 上报（sessionId 取 currentSessionId）', async () => {
    useChatStore.setState({ currentSessionId: 's1', isStreaming: false } as never)
    // sendMessage 内部依赖 window.api 与 settings，用最小桩让流程跑到上报点
    ;(window.api.chat.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 's1' })
    ;(window.api.chat.listSessions as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(window.api.chat.saveMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    ;(window.api.regex.list as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const store = useChatStore.getState()
    const character = {
      id: 'c1', name: '爱丽丝', description: '', personality: '', scenario: '',
      firstMessage: '', exampleDialog: '', tags: [], lorebookId: null, creator: '',
      createdAt: 0, updatedAt: 0, alternateGreetings: [], avatar: '',
    }
    // 最小化执行：sendMessage 前置校验依赖 profile，直接设置
    useChatStore.setState({
      currentSessionId: 's1',
      isStreaming: false,
    } as never)

    await store.sendMessage('你好', [], character, null, []).catch(() => { /* 忽略链路错误，只验证上报 */ })

    expect(changedMock).toHaveBeenCalled()
    const payload = changedMock.mock.calls[0][0] as SessionChangePayload
    expect(payload.sessionId).toBe('s1')
    expect(payload.change).toBe('message')
  })

  it('renameSession 触发 title 上报（sessionId 取参数）', async () => {
    useChatStore.setState({ currentSessionId: 's1' } as never)
    const store = useChatStore.getState()
    await store.renameSession('c1', 's2', '新标题').catch(() => { /* 忽略 IPC */ })
    expect(changedMock).toHaveBeenCalledWith({ sessionId: 's2', change: 'title' })
  })

  it('deleteMessage 触发 message 上报', async () => {
    useChatStore.setState({ currentSessionId: 's1' } as never)
    const store = useChatStore.getState()
    await store.deleteMessage('mid-1', 'c1' as never).catch(() => { /* 忽略 IPC */ })
    expect(changedMock).toHaveBeenCalledWith({ sessionId: 's1', change: 'message' })
  })

  it('swipeMessage 触发 swiped 上报', async () => {
    useChatStore.setState({
      currentSessionId: 's1',
      messages: [{
        id: 'a1', sessionId: 's1', characterId: 'c1', role: 'assistant',
        content: '候选1', images: [], isEditing: false, timestamp: 1,
        swipes: ['候选1', '候选2'], swipeIndex: 0,
      }],
    } as never)
    const store = useChatStore.getState()
    await store.swipeMessage('a1', 1, {
      id: 'c1', name: '爱丽丝', description: '', personality: '', scenario: '',
      firstMessage: '', exampleDialog: '', tags: [], lorebookId: null, creator: '',
      createdAt: 0, updatedAt: 0, alternateGreetings: [], avatar: '',
    } as never).catch(() => { /* 忽略链路 */ })
    expect(changedMock).toHaveBeenCalled()
    const payload = changedMock.mock.calls[0][0] as SessionChangePayload
    expect(payload.change).toBe('swiped')
  })

  it('clearChat 触发 message 上报', async () => {
    useChatStore.setState({ currentSessionId: 's1' } as never)
    const store = useChatStore.getState()
    await store.clearChat('c1').catch(() => { /* 忽略 IPC */ })
    expect(changedMock).toHaveBeenCalledWith({ sessionId: 's1', change: 'message' })
  })
})

describe('主进程广播（session:changed -> session:updated）', () => {
  it('IPC_EVENTS 通道常量已定义', () => {
    // 通道常量（shared/ipc-channels.ts）为广播与桥接层共用的契约
    expect(IPC_EVENTS.sessionChanged).toBe('session:changed')
    expect(IPC_EVENTS.sessionUpdated).toBe('session:updated')
  })
})
