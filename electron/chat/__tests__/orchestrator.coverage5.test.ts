/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
 
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
const TEST_ROOT = '/tmp/qingyu-orchestrator-cov5-test'
vi.mock('electron', () => ({ app: { getPath: () => TEST_ROOT } }))
import { ChatOrchestrator } from '../orchestrator'
import { FakeModelPort } from '../fakeModel'
import type { ChatCommand } from '../../../shared/chat-core/commands'
import type { MessagePort, ContextPort } from '../ports'
import { sessionLock } from '../sessionLock'

function mp(): MessagePort {
  return {
    async findSession() { return { id: 's1', sessionId: 's1', characterId: 'c1' } },
    async findByRequestId() { return null },
    async appendUserMessage(i) { return { id: (i as { id: string }).id } },
    async commitAssistantMessage(i) { return { id: (i as { id: string }).id } },
    async updateAssistantMessage() {},
    async findMessage(_s, id) { return { id, role: 'assistant', content: 'old', swipes: ['old'], swipeIndex: 0 } },
    async appendSwipedCandidate(id, c) { return { id, content: c, swipes: ['old', c], swipeIndex: 1 } },
  } as unknown as MessagePort
}
function ctx(): ContextPort {
  return { async build() { return { messages: [{ role: 'user', content: 'hi' }], fingerprint: 'fp', model: { provider: 'openai', model: 'gpt-4o-mini' } } } }
}
beforeEach(() => { rmSync(TEST_ROOT, { recursive: true, force: true }); sessionLock.clear() })
afterEach(() => { rmSync(TEST_ROOT, { recursive: true, force: true }); sessionLock.clear() })

describe('orchestrator coverage5', () => {
  it('覆盖 mapProviderError 各分支', async () => {
    const { nanoid } = await import('nanoid')
    const mocked = vi.mocked(nanoid)
    const cases: Array<{ err: string; code: string }> = [
      { err: 'timeout', code: 'PROVIDER_TIMEOUT' },
      { err: 'rate limited', code: 'PROVIDER_RATE_LIMITED' },
      { err: 'unavailable', code: 'PROVIDER_UNAVAILABLE' },
      { err: 'network error', code: 'PROVIDER_UNAVAILABLE' },
    ]
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i]
      mocked.mockReturnValueOnce(`mock-id-${i}-a`).mockReturnValueOnce(`mock-id-${i}-b`)
      const orch = new ChatOrchestrator({ messagePort: mp(), contextPort: ctx(), modelPort: new FakeModelPort({ kind: 'fail_before', error: c.err }) })
      const cmd = { type: 'send', requestId: `req-${c.code}-${i}-${Date.now()}`, sessionId: `s1-${i}`, content: 'hi', client: { kind: 'desktop', clientId: 'c1', protocolVersion: 2 } } as unknown as ChatCommand
      await expect(orch.handle(cmd)).rejects.toMatchObject({ code: c.code })
    }
  })
  it('覆盖 cancel 已取消幂等', async () => {
    const { createTask } = await import('../taskStore')
    const snap = { schemaVersion: 1 as const, taskId: 'task-cancelled', requestId: 'req-cancelled', type: 'send' as const, state: 'cancelled' as const, sessionId: 's1', characterId: 'c1', client: { kind: 'desktop' as const, clientId: 'c1', protocolVersion: 2 as const }, accumulatedText: '', lastSequence: 1, createdAt: Date.now(), updatedAt: Date.now() }
    createTask(snap as unknown as import('../../../shared/chat-core/events').TaskSnapshot)
    const orch = new ChatOrchestrator({ messagePort: mp(), contextPort: ctx(), modelPort: new FakeModelPort({ kind: 'success', chunks: ['a'] }) })
    const res = await orch.cancel('task-cancelled')
    expect(res.state).toBe('cancelled')
  })
})
