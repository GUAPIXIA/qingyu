/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
 
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
const TEST_ROOT = '/tmp/qingyu-orchestrator-cov6-test'
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
  return { async build() { return { messages: [{ role: 'user', content: 'hi' }], fingerprint: 'fp', model: { provider: 'openai', model: 'deepseek-v4-flash' } } } }
}
beforeEach(() => { rmSync(TEST_ROOT, { recursive: true, force: true }); sessionLock.clear() })
afterEach(() => { rmSync(TEST_ROOT, { recursive: true, force: true }); sessionLock.clear() })

describe('orchestrator coverage6 - flash model', () => {
  it('deepseek-v4-flash 模型路由', async () => {
    const orch = new ChatOrchestrator({ messagePort: mp(), contextPort: ctx(), modelPort: new FakeModelPort({ kind: 'success', chunks: ['flash ok'] }) })
    const c = { type: 'send', requestId: 'req-flash-1', sessionId: 's1', content: 'hi', client: { kind: 'desktop', clientId: 'c1', protocolVersion: 2 } } as unknown as ChatCommand
    const snap = await orch.handle(c)
    expect(snap.state).toBe('completed')
    expect(snap.model?.model).toBe('deepseek-v4-flash')
  })
  it('continue 空内容新气泡', async () => {
    const orch = new ChatOrchestrator({ messagePort: mp(), contextPort: ctx(), modelPort: new FakeModelPort({ kind: 'success', chunks: ['cont2'] }) })
    const c: ChatCommand = { type: 'continue', requestId: 'req-cont-flash', sessionId: 's1', client: { kind: 'desktop', clientId: 'c1', protocolVersion: 2 } }
    const snap = await orch.handle(c)
    expect(snap.accumulatedText).toBe('cont2')
  })
})
