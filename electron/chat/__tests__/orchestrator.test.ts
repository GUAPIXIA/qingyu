/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rmSync } from 'node:fs'

const TEST_ROOT = '/tmp/qingyu-orchestrator-test'
vi.mock('electron', () => ({ app: { getPath: () => TEST_ROOT } }))

import { ChatOrchestrator } from '../orchestrator'
import { FakeModelPort } from '../fakeModel'
import { findByRequestId, getTaskSnapshot } from '../taskStore'
import { sessionLock } from '../sessionLock'
import type { ChatCommand } from '../../../shared/chat-core/commands'
import type { MessagePort, ContextPort } from '../ports'

function makeMessagePort(): MessagePort & { store: Map<string, { id: string; requestId: string }>; assistant: Map<string, string> } {
  const store = new Map<string, { id: string; requestId: string }>()
  const assistant = new Map<string, string>()
  return {
    store,
    assistant,
    async findSession(sessionId) {
      if (sessionId === 'not-found') return null
      return { id: sessionId, sessionId, characterId: 'char-1' }
    },
    async findByRequestId(sessionId, requestId) {
      return store.get(`${sessionId}:${requestId}`) ?? null
    },
    async appendUserMessage(input) {
      store.set(`${input.sessionId}:${input.requestId}`, { id: input.id, requestId: input.requestId })
      return { id: input.id }
    },
    async commitAssistantMessage(input) {
      assistant.set(input.generationTaskId, input.content)
      return { id: input.id }
    },
    async updateAssistantMessage() {},
    async findMessage(_sessionId: string, messageId: string) {
      return { id: messageId, role: 'assistant', content: 'old', swipes: ['old'], swipeIndex: 0 }
    },
    async appendSwipedCandidate(messageId: string, content: string) {
      return { id: messageId, content, swipes: ['old', content], swipeIndex: 1 }
    },
  }
}

function makeContextPort(): ContextPort {
  return {
    async build() {
      return {
        messages: [{ role: 'user', content: 'hi' }],
        fingerprint: 'fp-1',
        model: { provider: 'openai', model: 'gpt-4o-mini' },
      }
    },
  }
}

function cmd(over: Partial<ChatCommand> = {}): ChatCommand {
  return {
    type: 'send',
    requestId: 'req-' + Math.random().toString(36).slice(2, 6),
    sessionId: 'sess-1',
    characterId: 'char-1',
    content: 'hello',
    client: { kind: 'desktop', clientId: 'c1', protocolVersion: 2 },
    ...over,
  } as ChatCommand
}

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  sessionLock.clear()
})
afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  sessionLock.clear()
})

describe('Orchestrator', () => {
  it('send 完整流程：多 chunk -> completed', async () => {
    const mp = makeMessagePort()
    const orch = new ChatOrchestrator({
      messagePort: mp,
      contextPort: makeContextPort(),
      modelPort: new FakeModelPort({ kind: 'success', chunks: ['hello ', 'world'], usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } }),
    })
    const c = cmd({ requestId: 'req-ok', sessionId: 'sess-ok' })
    const snap = await orch.handle(c)
    expect(snap.state).toBe('completed')
    expect(snap.accumulatedText).toBe('hello world')
    expect(snap.assistantMessageId).toBeTruthy()
  })

  it('持久幂等：同 requestId 返回同一任务', async () => {
    const mp = makeMessagePort()
    const orch = new ChatOrchestrator({
      messagePort: mp,
      contextPort: makeContextPort(),
      modelPort: new FakeModelPort({ kind: 'success', chunks: ['a'] }),
    })
    const c = cmd({ requestId: 'req-dup', sessionId: 'sess-dup' })
    const s1 = await orch.handle(c)
    const s2 = await orch.handle(c)
    expect(s1.taskId).toBe(s2.taskId)
    expect(mp.store.size).toBe(1) // 用户消息仅一条
  })

  it('首包前失败 -> failed', async () => {
    const mp = makeMessagePort()
    const orch = new ChatOrchestrator({
      messagePort: mp,
      contextPort: makeContextPort(),
      modelPort: new FakeModelPort({ kind: 'fail_before', error: 'network unavailable' }),
    })
    const c = cmd({ requestId: 'req-f1', sessionId: 'sess-f1' })
    await expect(orch.handle(c)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' })
    expect(findByRequestId('req-f1')?.state).toBe('failed')
  })

  it('流中失败 -> failed', async () => {
    const mp = makeMessagePort()
    const orch = new ChatOrchestrator({
      messagePort: mp,
      contextPort: makeContextPort(),
      modelPort: new FakeModelPort({ kind: 'fail_mid', chunks: ['part'], error: 'timeout' }),
    })
    const c = cmd({ requestId: 'req-f2', sessionId: 'sess-f2' })
    await expect(orch.handle(c)).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' })
    expect(findByRequestId('req-f2')?.state).toBe('failed')
  })

  it('取消幂等', async () => {
    // 直接构造 streaming 任务，测试 cancel 幂等（completed 任务 cancel 应保持 completed）
    const { createTask } = await import('../taskStore')
    const mp = makeMessagePort()
    const orch = new ChatOrchestrator({
      messagePort: mp,
      contextPort: makeContextPort(),
      modelPort: new FakeModelPort({ kind: 'success', chunks: ['a'] }),
    })
    const snapStreaming = {
      schemaVersion: 1 as const,
      taskId: 'task-cancel-1',
      requestId: 'req-c1',
      type: 'send' as const,
      state: 'streaming' as const,
      sessionId: 'sess-c',
      characterId: 'char-1',
      client: { kind: 'desktop' as const, clientId: 'c1', protocolVersion: 2 as const },
      accumulatedText: 'partial',
      lastSequence: 2,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    createTask(snapStreaming as unknown as import('../../../shared/chat-core/events').TaskSnapshot)
    const c1 = await orch.cancel('task-cancel-1')
    expect(c1.state).toBe('cancelled')
    const c2 = await orch.cancel('task-cancel-1')
    expect(c2.state).toBe('cancelled')
    // completed 任务取消应保持 completed
    const cCompleted = cmd({ requestId: 'req-c2', sessionId: 'sess-c2' })
    const snapDone = await orch.handle(cCompleted)
    expect(snapDone.state).toBe('completed')
    const c3 = await orch.cancel(snapDone.taskId)
    expect(c3.state).toBe('completed')
  })

  it('同 session 并发 -> TASK_CONFLICT', async () => {
    const mp = makeMessagePort()
    const slow = new FakeModelPort({ kind: 'success', chunks: ['slow'], delayMs: 50 })
    const orch = new ChatOrchestrator({
      messagePort: mp,
      contextPort: makeContextPort(),
      modelPort: slow,
    })
    const c1 = cmd({ requestId: 'req-con1', sessionId: 'sess-con' })
    const c2 = cmd({ requestId: 'req-con2', sessionId: 'sess-con' })
    const p1 = orch.handle(c1)
    // 让 p1 先获取锁
    await new Promise((r) => setTimeout(r, 5))
    await expect(orch.handle(c2)).rejects.toMatchObject({ code: 'TASK_CONFLICT' })
    await p1
  })

  it('regenerate 追加新候选', async () => {
    const mp = makeMessagePort()
    const orch = new ChatOrchestrator({
      messagePort: mp,
      contextPort: makeContextPort(),
      modelPort: new FakeModelPort({ kind: 'success', chunks: ['new'] }),
    })
    const c: ChatCommand = {
      type: 'regenerate',
      requestId: 'req-reg-1',
      sessionId: 'sess-reg',
      messageId: 'msg-1',
      client: { kind: 'desktop', clientId: 'c1', protocolVersion: 2 },
    }
    const snap = await orch.handle(c)
    expect(snap.state).toBe('completed')
    expect(snap.accumulatedText).toBe('new')
  })

  it('regenerate 失败不破坏旧候选', async () => {
    const mp = makeMessagePort()
    const orch = new ChatOrchestrator({
      messagePort: mp,
      contextPort: makeContextPort(),
      modelPort: new FakeModelPort({ kind: 'fail_before', error: 'timeout' }),
    })
    const c: ChatCommand = {
      type: 'regenerate',
      requestId: 'req-reg-fail',
      sessionId: 'sess-reg',
      messageId: 'msg-1',
      client: { kind: 'desktop', clientId: 'c1', protocolVersion: 2 },
    }
    await expect(orch.handle(c)).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' })
    expect(findByRequestId('req-reg-fail')?.state).toBe('failed')
  })

  it('continue 新气泡', async () => {
    const mp = makeMessagePort()
    const orch = new ChatOrchestrator({
      messagePort: mp,
      contextPort: makeContextPort(),
      modelPort: new FakeModelPort({ kind: 'success', chunks: ['cont'] }),
    })
    const c: ChatCommand = {
      type: 'continue',
      requestId: 'req-cont-1',
      sessionId: 'sess-cont',
      client: { kind: 'desktop', clientId: 'c1', protocolVersion: 2 },
    }
    const snap = await orch.handle(c)
    expect(snap.state).toBe('completed')
    expect(snap.accumulatedText).toBe('cont')
  })
})
