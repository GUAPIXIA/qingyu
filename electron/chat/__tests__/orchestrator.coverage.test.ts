/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rmSync } from 'node:fs'

const TEST_ROOT = '/tmp/qingyu-orchestrator-cov-test'
vi.mock('electron', () => ({ app: { getPath: () => TEST_ROOT } }))

import { ChatOrchestrator } from '../orchestrator'
import { FakeModelPort } from '../fakeModel'
import { findByRequestId } from '../taskStore'
import { sessionLock } from '../sessionLock'
import type { ChatCommand } from '../../../shared/chat-core/commands'
import type { MessagePort, ContextPort } from '../ports'

function mp(): MessagePort & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>()
  return {
    store,
    async findSession() { return { id: 's1', sessionId: 's1', characterId: 'c1' } },
    async findByRequestId(s, r) { return store.get(`${s}:${r}`) as never ?? null },
    async appendUserMessage(i) { store.set(`${i.sessionId}:${i.requestId}`, { id: i.id }); return { id: i.id } },
    async commitAssistantMessage(i) { return { id: i.id } },
    async updateAssistantMessage() {},
    async findMessage(_s, id) { return { id, role: 'assistant', content: 'old', swipes: ['old'], swipeIndex: 0 } },
    async appendSwipedCandidate(id, c) { return { id, content: c, swipes: ['old', c], swipeIndex: 1 } },
  } as unknown as MessagePort & { store: Map<string, unknown> }
}
function ctx(): ContextPort {
  return { async build() { return { messages: [{ role: 'user', content: 'hi' }], fingerprint: 'fp', model: { provider: 'openai', model: 'gpt-4o-mini' } } } }
}
function cmd(o: Partial<ChatCommand> = {}): ChatCommand {
  return { type: 'send', requestId: 'req-' + Math.random().toString(36).slice(2,6), sessionId: 's1', characterId: 'c1', content: 'hello', client: { kind: 'desktop', clientId: 'c1', protocolVersion: 2 }, ...o } as ChatCommand
}

beforeEach(() => { rmSync(TEST_ROOT, { recursive: true, force: true }); sessionLock.clear() })
afterEach(() => { rmSync(TEST_ROOT, { recursive: true, force: true }); sessionLock.clear() })

describe('orchestrator coverage', () => {
  it('retry_generation 复用 userMessageId', async () => {
    const m = mp()
    // 直接创建 interrupted 任务以测试 retry（completed 重试会走不同分支）
    const { createTask } = await import('../taskStore')
    const base: import('../../../shared/chat-core/events').TaskSnapshot = {
      schemaVersion: 1,
      taskId: 'task-retry-base',
      requestId: 'req-retry-base',
      type: 'send',
      state: 'interrupted',
      sessionId: 's-retry',
      characterId: 'c1',
      client: { kind: 'desktop', clientId: 'c1', protocolVersion: 2 },
      accumulatedText: 'part',
      lastSequence: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      userMessageId: 'msg-user-1',
    }
    createTask(base)
    const orch = new ChatOrchestrator({ messagePort: m, contextPort: ctx(), modelPort: new FakeModelPort({ kind: 'success', chunks: ['a'] }) })
    const c2: ChatCommand = { type: 'retry_generation', requestId: 'req-retry-2', retryOfTaskId: 'task-retry-base', client: { kind: 'desktop', clientId: 'c1', protocolVersion: 2 } }
    const s2 = await orch.handle(c2)
    expect(s2.state).toBe('completed')
    expect(s2.retryOfTaskId).toBe('task-retry-base')
  })

  it('provider 错误映射', async () => {
    const m = mp()
    const orch = new ChatOrchestrator({ messagePort: m, contextPort: ctx(), modelPort: new FakeModelPort({ kind: 'fail_before', error: 'rate limited' }) })
    const c = cmd({ requestId: 'req-rate', sessionId: 's-rate' })
    await expect(orch.handle(c)).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED' })
  })

  it('toolGate L0 自动通过', async () => {
    const m = mp()
    const orch = new ChatOrchestrator({ messagePort: m, contextPort: ctx(), modelPort: new FakeModelPort({ kind: 'success', chunks: ['hi [TOOL_CALL:[{"id":"1","function":{"name":"get_time","arguments":"{}"}}]]'] }) })
    const c = cmd({ requestId: 'req-tool-l0', sessionId: 's-tool-l0' })
    const s = await orch.handle(c)
    expect(s.state).toBe('completed')
  })

  it('无效 session 抛 SESSION_NOT_FOUND', async () => {
    const m = mp()
    m.findSession = async () => null
    const orch = new ChatOrchestrator({ messagePort: m, contextPort: ctx(), modelPort: new FakeModelPort({ kind: 'success', chunks: ['a'] }) })
    const c = cmd({ requestId: 'req-no-sess', sessionId: 'not-found' })
    await expect(orch.handle(c)).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
  })

  it('cancel 未知任务抛 TASK_NOT_FOUND', async () => {
    const orch = new ChatOrchestrator({ messagePort: mp(), contextPort: ctx(), modelPort: new FakeModelPort({ kind: 'success', chunks: ['a'] }) })
    await expect(orch.cancel('no-such')).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' })
  })
})
