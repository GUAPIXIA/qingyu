/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
const TEST_ROOT = '/tmp/qingyu-orchestrator-cov3-test'
vi.mock('electron', () => ({ app: { getPath: () => TEST_ROOT } }))
import { ChatOrchestrator } from '../orchestrator'
import { FakeModelPort } from '../fakeModel'
import type { ChatCommand } from '../../../shared/chat-core/commands'
import type { MessagePort, ContextPort } from '../ports'
import { sessionLock } from '../sessionLock'

function mp(over: Partial<MessagePort> = {}): MessagePort {
  return {
    async findSession() { return { id: 's1', sessionId: 's1', characterId: 'c1' } },
    async findByRequestId() { return null },
    async appendUserMessage(i) { return { id: i.id } },
    async commitAssistantMessage(i) { return { id: i.id } },
    async updateAssistantMessage() {},
    async findMessage(_s, id) { return { id, role: 'assistant', content: 'old', swipes: ['old'], swipeIndex: 0 } },
    async appendSwipedCandidate(id, c) { return { id, content: c, swipes: ['old', c], swipeIndex: 1 } },
    ...over,
  } as unknown as MessagePort
}
function ctx(): ContextPort {
  return { async build() { return { messages: [{ role: 'user', content: 'hi' }], fingerprint: 'fp', model: { provider: 'openai', model: 'gpt-4o-mini' } } } }
}
beforeEach(() => { rmSync(TEST_ROOT, { recursive: true, force: true }); sessionLock.clear() })
afterEach(() => { rmSync(TEST_ROOT, { recursive: true, force: true }); sessionLock.clear() })

describe('orchestrator coverage3', () => {
  it('send 空 content 无图 抛 INVALID_COMMAND', async () => {
    const orch = new ChatOrchestrator({ messagePort: mp(), contextPort: ctx(), modelPort: new FakeModelPort({ kind: 'success', chunks: ['a'] }) })
    const c = { type: 'send', requestId: 'req-empty', sessionId: 's1', content: '   ', images: [], client: { kind: 'desktop', clientId: 'c1', protocolVersion: 2 } } as unknown as ChatCommand
    await expect(orch.handle(c)).rejects.toMatchObject({ code: 'INVALID_COMMAND' })
  })
  it('regenerate 目标非 assistant 抛 INVALID_COMMAND', async () => {
    const m = mp({ async findMessage() { return { id: 'msg-1', role: 'user', content: 'hi' } } } as unknown as MessagePort)
    const orch = new ChatOrchestrator({ messagePort: m, contextPort: ctx(), modelPort: new FakeModelPort({ kind: 'success', chunks: ['a'] }) })
    const c: ChatCommand = { type: 'regenerate', requestId: 'req-reg-bad', sessionId: 's1', messageId: 'msg-1', client: { kind: 'desktop', clientId: 'c1', protocolVersion: 2 } }
    await expect(orch.handle(c)).rejects.toMatchObject({ code: 'INVALID_COMMAND' })
  })
  it('continue 正常', async () => {
    const orch = new ChatOrchestrator({ messagePort: mp(), contextPort: ctx(), modelPort: new FakeModelPort({ kind: 'success', chunks: ['cont'] }) })
    const c: ChatCommand = { type: 'continue', requestId: 'req-cont', sessionId: 's1', client: { kind: 'desktop', clientId: 'c1', protocolVersion: 2 } }
    const snap = await orch.handle(c)
    expect(snap.state).toBe('completed')
  })
})
