/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'

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
        requestMaxTokens: 2048,
        model: { provider: 'openai', model: 'gpt-4o-mini', profileId: 'p1', apiKey: 'sk-secret-must-not-leak', baseUrl: 'https://api.example.com/v1' },
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

  it('回复落盘后由主进程统一调度自动长记忆，且不阻塞任务完成', async () => {
    const mp = makeMessagePort()
    const schedule = vi.fn()
    const orch = new ChatOrchestrator({
      messagePort: mp,
      contextPort: makeContextPort(),
      modelPort: new FakeModelPort({ kind: 'success', chunks: ['remember me'] }),
      memoryScheduler: { schedule },
    })

    const snap = await orch.handle(cmd({ requestId: 'req-memory', sessionId: 'sess-memory' }))

    expect(snap.state).toBe('completed')
    expect(schedule).toHaveBeenCalledOnce()
    expect(schedule).toHaveBeenCalledWith({
      sessionId: 'sess-memory',
      characterId: 'char-1',
    })
  })

  it('记忆调度器同步失败不反转已完成的主对话', async () => {
    const orch = new ChatOrchestrator({
      messagePort: makeMessagePort(),
      contextPort: makeContextPort(),
      modelPort: new FakeModelPort({ kind: 'success', chunks: ['ok'] }),
      memoryScheduler: { schedule: () => { throw new Error('scheduler unavailable') } },
    })

    const snap = await orch.handle(cmd({ requestId: 'req-memory-fail', sessionId: 'sess-memory-fail' }))

    expect(snap.state).toBe('completed')
  })

  // 2026-09-13 修复：任务快照落盘（data/tasks）与 task:started 事件外发都不得携带凭据
  it('任务快照与事件记录落盘均不携带 apiKey/baseUrl', async () => {
    const mp = makeMessagePort()
    const orch = new ChatOrchestrator({
      messagePort: mp,
      contextPort: makeContextPort(),
      modelPort: new FakeModelPort({ kind: 'success', chunks: ['ok'] }),
    })

    const snap = await orch.handle(cmd({ requestId: 'req-secret', sessionId: 'sess-secret' }))

    expect(snap.model).toEqual({ provider: 'openai', model: 'gpt-4o-mini', profileId: 'p1' })
    // 端到端：扫描该次任务落盘的全部文件（任务快照 + 事件日志）
    const leaked: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) { walk(full); continue }
        const text = readFileSync(full, 'utf-8')
        if (text.includes('sk-secret-must-not-leak') || text.includes('api.example.com')) {
          leaked.push(relative(TEST_ROOT, full))
        }
      }
    }
    if (existsSync(TEST_ROOT)) walk(TEST_ROOT)
    expect(leaked).toEqual([])
  })

  it('send 将会话叙事模式固化到我方消息', async () => {
    const mp = makeMessagePort()
    mp.findSession = async (sessionId) => ({
      id: sessionId,
      sessionId,
      characterId: 'char-1',
      narrativeMode: 'omniscient',
    })
    const appendUserMessage = vi.spyOn(mp, 'appendUserMessage')
    const orch = new ChatOrchestrator({
      messagePort: mp,
      contextPort: makeContextPort(),
      modelPort: new FakeModelPort({ kind: 'success', chunks: ['response'] }),
    })

    await orch.handle(cmd({ requestId: 'req-narrator', sessionId: 'sess-narrator' }))

    expect(appendUserMessage).toHaveBeenCalledWith(expect.objectContaining({
      narrativeMode: 'omniscient',
      speakerKind: 'narrator',
      generationKind: 'manual',
    }))
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

  it('把上下文服务的动态输出预算传给模型端口', async () => {
    const requests: Array<{ maxTokens?: number }> = []
    const orch = new ChatOrchestrator({
      messagePort: makeMessagePort(),
      contextPort: {
        async build() {
          return {
            messages: [{ role: 'user', content: 'hi' }],
            fingerprint: 'fp-budget',
            model: { provider: 'openai', model: 'deepseek-v4-pro' },
            requestMaxTokens: 4096,
          }
        },
      },
      modelPort: {
        async stream(request, callbacks) {
          requests.push(request)
          callbacks.onChunk('回复')
          return { text: '回复' }
        },
      },
    })

    await orch.handle(cmd({ requestId: 'req-budget', sessionId: 'sess-budget' }))
    expect(requests[0]?.maxTokens).toBe(4096)
  })
})
