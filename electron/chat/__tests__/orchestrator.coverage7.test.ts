/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'

const TEST_ROOT = '/tmp/qingyu-orchestrator-cov7-test'
vi.mock('electron', () => ({ app: { getPath: () => TEST_ROOT } }))

import { ChatOrchestrator } from '../orchestrator'
import { FakeModelPort } from '../fakeModel'
import { sessionLock } from '../sessionLock'
import type { ChatCommand } from '../../../shared/chat-core/commands'
import type { MessagePort, ContextPort } from '../ports'

function mp(opts?: Partial<MessagePort>): MessagePort {
  return {
    async findSession() {
      return { id: 's1', sessionId: 's1', characterId: 'c1' }
    },
    async findByRequestId() {
      return null
    },
    async appendUserMessage(i) {
      return { id: (i as { id: string }).id }
    },
    async commitAssistantMessage(i) {
      return { id: (i as { id: string }).id }
    },
    async updateAssistantMessage() {},
    async findMessage(_s, id) {
      return { id, role: 'assistant', content: 'old', swipes: ['old'], swipeIndex: 0 }
    },
    async appendSwipedCandidate(id, c) {
      return { id, content: c, swipes: ['old', c], swipeIndex: 1 }
    },
    ...opts,
  } as unknown as MessagePort
}
function ctx(): ContextPort {
  return {
    async build() {
      return {
        messages: [{ role: 'user', content: 'hi' }],
        fingerprint: 'fp',
        model: { provider: 'openai', model: 'gpt-4o-mini' },
      }
    },
  }
}

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  sessionLock.clear()
})
afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  sessionLock.clear()
  vi.restoreAllMocks()
  vi.unmock('../toolGate')
})

describe('orchestrator coverage7 - 剩余分支', () => {
  it('任务锁冲突 -> TASK_CONFLICT 且标记 failed', async () => {
    const m = mp()
    // 手动占住 s-conflict
    sessionLock.tryAcquire('s-conflict', 'holder')
    const orch = new ChatOrchestrator({
      messagePort: m,
      contextPort: ctx(),
      modelPort: new FakeModelPort({ kind: 'success', chunks: ['a'] }),
    })
    const cmd = {
      type: 'send',
      requestId: 'req-conflict-1',
      sessionId: 's-conflict',
      characterId: 'c1',
      content: 'hi',
      client: { kind: 'desktop', clientId: 'c1', protocolVersion: 2 },
    } as unknown as ChatCommand
    await expect(orch.handle(cmd)).rejects.toMatchObject({ code: 'TASK_CONFLICT' })
    // 验证快照已被标记 failed
    const { getTaskSnapshot: _get } = await import('../taskStore')
    void _get
    // 即使失败也应存在 failed 状态
    const { findByRequestId } = await import('../taskStore')
    const found = findByRequestId('req-conflict-1')
    expect(found?.state).toBe('failed')
  })

  it('findByRequestId 命中 -> 复用 userMessageId 不重复写入', async () => {
    let appendCalled = 0
    const m = mp({
      async findByRequestId() {
        return { id: 'existing-msg-id' }
      },
      async appendUserMessage() {
        appendCalled++
        return { id: 'should-not-be-called' }
      },
    })
    const orch = new ChatOrchestrator({
      messagePort: m,
      contextPort: ctx(),
      modelPort: new FakeModelPort({ kind: 'success', chunks: ['hello'] }),
    })
    const cmd = {
      type: 'send',
      requestId: 'req-dup-msg',
      sessionId: 's1',
      characterId: 'c1',
      content: 'hello',
      client: { kind: 'desktop', clientId: 'c1', protocolVersion: 2 },
    } as unknown as ChatCommand
    const snap = await orch.handle(cmd)
    expect(snap.userMessageId).toBe('existing-msg-id')
    expect(appendCalled).toBe(0)
    expect(snap.state).toBe('completed')
  })

  it('Aborted 且 accumulated 非空 -> commit 部分消息并 cancelled', async () => {
    // 自定义 ModelPort：先 onChunk 再抛 Aborted
    const abortingPort = {
      async stream(_req, callbacks, _signal) {
        callbacks.onChunk('part-')
        callbacks.onChunk('text')
        throw new Error('Aborted')
      },
    } as unknown as import('../ports').ModelPort
    let committed: unknown = null
    const m = mp({
      async commitAssistantMessage(i) {
        committed = i
        return { id: (i as { id: string }).id }
      },
    })
    const orch = new ChatOrchestrator({ messagePort: m, contextPort: ctx(), modelPort: abortingPort })
    const cmd = {
      type: 'send',
      requestId: 'req-abort-part',
      sessionId: 's-abort',
      content: 'hi',
      client: { kind: 'desktop', clientId: 'c1', protocolVersion: 2 },
    } as unknown as ChatCommand
    const snap = await orch.handle(cmd)
    expect(snap.state).toBe('cancelled')
    expect(committed).toBeTruthy()
    expect((committed as { content: string }).content).toBe('part-text')
  })

  it('Aborted 且 accumulated 为空 -> cancelled 不落盘', async () => {
    const abortingPort = {
      async stream(_req, _cb, _signal) {
        throw new Error('Aborted')
      },
    } as unknown as import('../ports').ModelPort
    let commitCalled = false
    const m = mp({
      async commitAssistantMessage() {
        commitCalled = true
        return { id: 'x' }
      },
    })
    const orch = new ChatOrchestrator({ messagePort: m, contextPort: ctx(), modelPort: abortingPort })
    const cmd = {
      type: 'send',
      requestId: 'req-abort-empty',
      sessionId: 's-abort-empty',
      content: 'hi',
      client: { kind: 'desktop', clientId: 'c1', protocolVersion: 2 },
    } as unknown as ChatCommand
    const snap = await orch.handle(cmd)
    expect(snap.state).toBe('cancelled')
    expect(commitCalled).toBe(false)
  })

  it('工具 deny -> 抛 TOOL_PERMISSION_DENIED', async () => {
    // write_file 为 L2 风险，需走授权；mock requestToolPermission 返回 false -> deny
    const perm = await import('../../mcp/toolPermission')
    const spy = vi.spyOn(perm, 'requestToolPermission').mockResolvedValue(false)
    const m = mp()
    const orch = new ChatOrchestrator({
      messagePort: m,
      contextPort: ctx(),
      modelPort: new FakeModelPort({
        kind: 'success',
        chunks: ['hi [TOOL_CALL:[{"function":{"name":"write_file","arguments":"{\\"path\\":\\"/tmp/x\\"}"}}]]'],
      }),
    })
    const cmd = {
      type: 'send',
      requestId: 'req-tool-deny-' + Date.now(),
      sessionId: 's-tool-deny-' + Date.now(),
      content: 'hi',
      client: { kind: 'desktop', clientId: 'c1', protocolVersion: 2 },
    } as unknown as ChatCommand
    await expect(orch.handle(cmd)).rejects.toMatchObject({ code: 'TOOL_PERMISSION_DENIED' })
    spy.mockRestore()
  })

  it('accumulated 与 modelResult 文本不一致 -> 覆盖', async () => {
    // FakeModel 会 onChunk 累加，但返回不同 text
    const customPort = {
      async stream(_req, callbacks, _signal) {
        callbacks.onChunk('chunk-a')
        return { text: 'final-diff', usage: undefined }
      },
    } as unknown as import('../ports').ModelPort
    const m = mp()
    const orch = new ChatOrchestrator({ messagePort: m, contextPort: ctx(), modelPort: customPort })
    const cmd = {
      type: 'send',
      requestId: 'req-diff-text',
      sessionId: 's-diff',
      content: 'hi',
      client: { kind: 'desktop', clientId: 'c1', protocolVersion: 2 },
    } as unknown as ChatCommand
    const snap = await orch.handle(cmd)
    expect(snap.state).toBe('completed')
    expect(snap.accumulatedText).toBe('final-diff')
  })

  it('TOOL_CALL JSON 解析失败 -> 忽略工具流程按普通文本完成', async () => {
    const m = mp()
    const orch = new ChatOrchestrator({
      messagePort: m,
      contextPort: ctx(),
      modelPort: new FakeModelPort({ kind: 'success', chunks: ['hi [TOOL_CALL: not-json '] }),
    })
    const cmd = {
      type: 'send',
      requestId: 'req-tool-badjson',
      sessionId: 's-badjson',
      content: 'hi',
      client: { kind: 'desktop', clientId: 'c1', protocolVersion: 2 },
    } as unknown as ChatCommand
    const snap = await orch.handle(cmd)
    expect(snap.state).toBe('completed')
  })
})
