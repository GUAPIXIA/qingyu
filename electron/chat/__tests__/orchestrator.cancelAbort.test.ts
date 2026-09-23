/**
 * cancel-abort：cancel 真 abort 后台模型流的回归用例
 *
 * ① cancel 后底层 signal 被 abort（spy 断言）
 * ② 取消保留已积累正文，commit 恰一次（requestId+'-cancel'），事件流终局唯一
 * ③ cancel 与自然完成竞态：先到先得，终态唯一，无 unhandled rejection
 * ④ 重复 cancel 幂等：同一收口结果，不重复落盘
 * ⑤ 'Aborted' 收口：已 commit 以 commit 为准，不再重复落盘
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'

const TEST_ROOT = '/tmp/qingyu-orchestrator-cancel-abort-test'
vi.mock('electron', () => ({ app: { getPath: () => TEST_ROOT } }))

import { ChatOrchestrator } from '../orchestrator'
import { getTaskSnapshot, readEvents, updateTask } from '../taskStore'
import { transitionTask, getTaskAbort } from '../taskManager'
import { sessionLock } from '../sessionLock'
import type { TaskState, TaskSnapshot } from '../../../shared/chat-core/events'
import type { ChatCommand } from '../../../shared/chat-core/commands'
import type {
  MessagePort,
  ContextPort,
  ModelPort,
  ModelRequest,
  ModelCallbacks,
  ModelResult,
  PersistAssistantMessage,
} from '../ports'

function newAbortedError(): Error {
  const e = new Error('This operation was aborted')
  e.name = 'AbortError'
  return e
}

/**
 * 可控 ModelPort：模拟真实 fetch 流——emit 逐步产出正文，abort 时以 AbortError 拒绝；
 * resolve 模拟自然完成。abortSpy 供「cancel 后底层 signal 被 abort」断言。
 */
class GatedModelPort implements ModelPort {
  signal: AbortSignal | null = null
  readonly abortSpy = vi.fn()
  private onChunkFn: (delta: string) => void = () => {}
  private resolveFn: (r: ModelResult) => void = () => {}
  private markStarted: () => void = () => {}
  readonly started: Promise<void>

  constructor() {
    this.started = new Promise<void>((resolve) => { this.markStarted = resolve })
  }

  stream(_request: ModelRequest, callbacks: ModelCallbacks, signal: AbortSignal): Promise<ModelResult> {
    this.signal = signal
    this.onChunkFn = callbacks.onChunk
    signal.addEventListener('abort', this.abortSpy, { once: true })
    return new Promise<ModelResult>((resolve, reject) => {
      this.resolveFn = resolve
      // 模拟底层 fetch/undici：abort 即以 AbortError 拒绝（真 abort 语义）
      signal.addEventListener('abort', () => reject(newAbortedError()), { once: true })
      this.markStarted()
    })
  }

  emit(delta: string): void {
    this.onChunkFn(delta)
  }

  resolve(text: string): void {
    this.resolveFn({ text })
  }
}

function mp(): { messagePort: MessagePort; commits: PersistAssistantMessage[] } {
  const commits: PersistAssistantMessage[] = []
  const messagePort = {
    async findSession() {
      return { id: 's1', sessionId: 's1', characterId: 'c1' }
    },
    async findByRequestId() {
      return null
    },
    async appendUserMessage(i: { id: string }) {
      return { id: i.id }
    },
    async commitAssistantMessage(i: PersistAssistantMessage) {
      commits.push(i)
      return { id: i.id }
    },
    async updateAssistantMessage() {},
    async findMessage(_s: string, id: string) {
      return { id, role: 'assistant', content: 'old', swipes: ['old'], swipeIndex: 0 }
    },
    async appendSwipedCandidate(id: string, c: string) {
      return { id, content: c, swipes: ['old', c], swipeIndex: 1 }
    },
  } as unknown as MessagePort
  return { messagePort, commits }
}

function ctx(): ContextPort {
  return {
    async build() {
      return {
        messages: [{ role: 'user' as const, content: 'hi' }],
        fingerprint: 'fp',
        requestMaxTokens: 2048,
        model: { provider: 'openai', model: 'gpt-4o-mini' },
      }
    },
  }
}

function cmd(over: Record<string, unknown>): ChatCommand {
  return {
    type: 'send',
    requestId: 'req-cancel-abort',
    sessionId: 's-cancel-abort',
    characterId: 'c1',
    content: 'hi',
    client: { kind: 'desktop', clientId: 'c1', protocolVersion: 2 },
    ...over,
  } as unknown as ChatCommand
}

/** 断言再向终态转换抛 TASK_CONFLICT（终态唯一不可翻转） */
function expectTerminalFrozen(taskId: string, to: TaskState): void {
  try {
    transitionTask(taskId, to)
    expect.unreachable(`终态不应允许转换到 ${to}`)
  } catch (e) {
    expect((e as { code?: string }).code).toBe('TASK_CONFLICT')
  }
}

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  sessionLock.clear()
})
afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  sessionLock.clear()
})

describe('cancel-abort：cancel 真 abort 后台模型流', () => {
  it('① cancel 后底层 signal 被 abort（spy 断言）', async () => {
    const { messagePort, commits } = mp()
    const model = new GatedModelPort()
    const orch = new ChatOrchestrator({ messagePort, contextPort: ctx(), modelPort: model })
    const accepted = orch.start(cmd({ requestId: 'req-abort-spy', sessionId: 's-abort-spy' }))
    await model.started
    expect(model.signal?.aborted).toBe(false)
    model.emit('已见正文')

    const snap = await orch.cancel(accepted.taskId)

    // 真 abort：cancel 时底层 signal 被 abort（fetch 层随之中断，不再跑完）
    expect(model.abortSpy).toHaveBeenCalledOnce()
    expect(model.signal?.aborted).toBe(true)
    expect(snap.state).toBe('cancelled')
    // 'Aborted' 收口：保留已积累正文（本用例兼验 commit 恰一次）
    expect(commits).toHaveLength(1)
    expect(commits[0].content).toBe('已见正文')
    expect(commits[0].requestId).toBe('req-abort-spy-cancel')
    expect(snap.assistantMessageId).toBe(commits[0].id)
  })

  it('② 取消保留已积累正文：commit 恰一次 + 事件流终局唯一', async () => {
    const { messagePort, commits } = mp()
    const model = new GatedModelPort()
    const orch = new ChatOrchestrator({ messagePort, contextPort: ctx(), modelPort: model })
    const accepted = orch.start(cmd({ requestId: 'req-keep-text', sessionId: 's-keep-text' }))
    await model.started
    model.emit('你好')
    model.emit('世界')

    const snap = await orch.cancel(accepted.taskId)

    expect(snap.state).toBe('cancelled')
    expect(commits).toHaveLength(1) // 恰一次，不重复落盘
    expect(commits[0].content).toBe('你好世界') // 完整已积累正文
    expect(commits[0].requestId).toBe('req-keep-text-cancel')
    expect(snap.assistantMessageId).toBe(commits[0].id)
    expect(snap.accumulatedText).toBe('你好世界')
    // 事件流：终局事件恰一个 task:cancelled（cancelTask 唯一终局，收口不补发）
    const page = readEvents(accepted.taskId, 0, 500)
    const terminal = page.events.filter((e) =>
      ['task:cancelled', 'task:completed', 'task:failed', 'task:interrupted'].includes(e.type))
    expect(terminal).toHaveLength(1)
    expect(terminal[0]?.type).toBe('task:cancelled')
    // 收口完成后依旧只有一条消息
    expect(commits).toHaveLength(1)
  })

  it('③ 竞态（cancel 先到）：终态唯一 cancelled，不可被完成/失败翻转', async () => {
    const { messagePort, commits } = mp()
    const model = new GatedModelPort()
    const orch = new ChatOrchestrator({ messagePort, contextPort: ctx(), modelPort: model })
    const accepted = orch.start(cmd({ requestId: 'req-race-cancel', sessionId: 's-race-cancel' }))
    await model.started
    model.emit('部分')

    const snap = await orch.cancel(accepted.taskId) // cancel 先到先得

    expect(snap.state).toBe('cancelled')
    expectTerminalFrozen(accepted.taskId, 'completed')
    expectTerminalFrozen(accepted.taskId, 'failed')
    expect(getTaskSnapshot(accepted.taskId)?.state).toBe('cancelled')
    expect(commits).toHaveLength(1) // 保留已见正文，仍恰一次
  })

  it('③ 竞态（完成先到）：completed 终态唯一，cancel 不翻转也不产生第二条消息', async () => {
    const { messagePort, commits } = mp()
    const model = new GatedModelPort()
    const orch = new ChatOrchestrator({ messagePort, contextPort: ctx(), modelPort: model })
    const accepted = orch.start(cmd({ requestId: 'req-race-done', sessionId: 's-race-done' }))
    await model.started
    model.emit('全文')
    model.resolve('全文') // 自然完成先到先得
    await vi.waitFor(() => expect(getTaskSnapshot(accepted.taskId)?.state).toBe('completed'))

    const snap = await orch.cancel(accepted.taskId)

    expect(snap.state).toBe('completed')
    expect(snap.assistantMessageId).toBeTruthy()
    expect(commits).toHaveLength(1) // 已 commit 以 commit 为准
    expect(commits[0].requestId).toBe('req-race-done') // 正常收尾 commit（非 -cancel）
  })

  it('③ 同 tick 竞态：cancel 抢占终态，收尾 commit 被 TASK_CONFLICT 拦截且无 unhandled rejection', async () => {
    const { messagePort, commits } = mp()
    const model = new GatedModelPort()
    const orch = new ChatOrchestrator({ messagePort, contextPort: ctx(), modelPort: model })
    const accepted = orch.start(cmd({ requestId: 'req-race-tick', sessionId: 's-race-tick' }))
    await model.started
    model.emit('全文')
    model.resolve('全文') // 自然完成入队
    const snap = await orch.cancel(accepted.taskId) // 同 tick 抢占（先到先得）

    expect(snap.state).toBe('cancelled')
    // 后台 handle 走 TASK_CONFLICT 收口，由 start() 的 void completion.catch 吸收
    // （vitest 无 unhandled rejection 判错即为通过）
    await vi.waitFor(() => expect(getTaskAbort(accepted.taskId)).toBeUndefined())
    expect(getTaskSnapshot(accepted.taskId)?.state).toBe('cancelled')
    // 收尾 commit 被 TASK_CONFLICT 拦截（既有语义），已见正文由渲染层兜底落盘
    expect(commits).toHaveLength(0)
  })

  it('④ 重复 cancel 幂等：同一收口结果，不重复落盘', async () => {
    const { messagePort, commits } = mp()
    const model = new GatedModelPort()
    const orch = new ChatOrchestrator({ messagePort, contextPort: ctx(), modelPort: model })
    const accepted = orch.start(cmd({ requestId: 'req-repeat-cancel', sessionId: 's-repeat-cancel' }))
    await model.started
    model.emit('正文')

    const [s1, s2] = await Promise.all([
      orch.cancel(accepted.taskId),
      orch.cancel(accepted.taskId),
    ])

    expect(s1.state).toBe('cancelled')
    expect(s2.state).toBe('cancelled')
    expect(s1.assistantMessageId).toBe(s2.assistantMessageId) // 同一收口结果
    expect(commits).toHaveLength(1) // 不重复落盘
    // 收口后的再次 cancel 幂等
    const s3 = await orch.cancel(accepted.taskId)
    expect(s3.state).toBe('cancelled')
    expect(s3.assistantMessageId).toBe(s1.assistantMessageId)
    // abort 幂等：不产生额外副作用
    expect(model.abortSpy).toHaveBeenCalledOnce()
  })

  it("⑤ 'Aborted' 收口：已 commit 以 commit 为准，不再重复落盘", async () => {
    const { messagePort, commits } = mp()
    const model = new GatedModelPort()
    const orch = new ChatOrchestrator({ messagePort, contextPort: ctx(), modelPort: model })
    const accepted = orch.start(cmd({ requestId: 'req-already-committed', sessionId: 's-already-committed' }))
    await model.started
    model.emit('已见')
    // 模拟收尾竞态中已有 commit（assistantMessageId 已登记）
    updateTask(accepted.taskId, (s: TaskSnapshot) => ({ ...s, assistantMessageId: 'pre-committed-id' }))

    const snap = await orch.cancel(accepted.taskId)

    expect(snap.state).toBe('cancelled')
    expect(commits).toHaveLength(0) // 以已 commit 为准，不重复落盘
    expect(snap.assistantMessageId).toBe('pre-committed-id')
  })
})
