/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
 
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
const TEST_ROOT = '/tmp/qingyu-orchestrator-cov2-test'
vi.mock('electron', () => ({ app: { getPath: () => TEST_ROOT } }))
import { ChatOrchestrator } from '../orchestrator'
import { FakeModelPort } from '../fakeModel'
import type { ChatCommand } from '../../../shared/chat-core/commands'
import type { MessagePort, ContextPort } from '../ports'
import { sessionLock } from '../sessionLock'

function mp(): MessagePort & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>()
  return {
    store,
    async findSession() { return { id: 's1', sessionId: 's1', characterId: 'c1' } },
    async findByRequestId() { return null },
    async appendUserMessage(i) { return { id: i.id } },
    async commitAssistantMessage(i) { return { id: i.id } },
    async updateAssistantMessage() {},
    async findMessage(_s, id) { return { id, role: 'assistant', content: 'old', swipes: ['old'], swipeIndex: 0 } },
    async appendSwipedCandidate(id, c) { return { id, content: c, swipes: ['old', c], swipeIndex: 1 } },
  } as unknown as MessagePort & { store: Map<string, unknown> }
}
function ctx(): ContextPort {
  return { async build() { return { messages: [{ role: 'user', content: 'hi' }], fingerprint: 'fp', model: { provider: 'openai', model: 'gpt-4o-mini' } } } }
}
beforeEach(() => { rmSync(TEST_ROOT, { recursive: true, force: true }); sessionLock.clear() })
afterEach(() => { rmSync(TEST_ROOT, { recursive: true, force: true }); sessionLock.clear() })

describe('orchestrator coverage2', () => {
  it('invalid command 抛 INVALID_COMMAND', async () => {
    const orch = new ChatOrchestrator({ messagePort: mp(), contextPort: ctx(), modelPort: new FakeModelPort({ kind: 'success', chunks: ['a'] }) })
    const bad = { type: 'send', requestId: '', sessionId: '', content: '', client: { kind: 'desktop', clientId: 'c1', protocolVersion: 2 } } as unknown as ChatCommand
    await expect(orch.handle(bad)).rejects.toMatchObject({ code: 'INVALID_COMMAND' })
  })
  it('regenerate 空回复抛 INVALID_MODEL_RESPONSE', async () => {
    const orch = new ChatOrchestrator({ messagePort: mp(), contextPort: ctx(), modelPort: new FakeModelPort({ kind: 'success', chunks: [''] }) })
    const c: ChatCommand = { type: 'regenerate', requestId: 'req-empty-reg', sessionId: 's1', messageId: 'msg-1', client: { kind: 'desktop', clientId: 'c1', protocolVersion: 2 } }
    await expect(orch.handle(c)).rejects.toMatchObject({ code: 'INVALID_MODEL_RESPONSE' })
  })
  it('retry 不存在抛 TASK_NOT_FOUND', async () => {
    const orch = new ChatOrchestrator({ messagePort: mp(), contextPort: ctx(), modelPort: new FakeModelPort({ kind: 'success', chunks: ['a'] }) })
    const c: ChatCommand = { type: 'retry_generation', requestId: 'req-retry-no', retryOfTaskId: 'not-exist', client: { kind: 'desktop', clientId: 'c1', protocolVersion: 2 } }
    await expect(orch.handle(c)).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' })
  })
})
