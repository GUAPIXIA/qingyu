// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/qingyu-memory-summary-test' } }))

import { createMemorySummaryService } from '../memorySummaryService'

function makeDeps(overrides: Record<string, unknown> = {}) {
  const session = {
    id: 'session-1',
    characterId: 'character-1',
    memoryEnabled: true,
    memoryMode: 'auto',
    autoMemoryInterval: 2,
    memory: '',
    memoryFacts: [],
    memoryVersion: 0,
  }
  const messages = [
    { id: 'm1', sessionId: session.id, characterId: session.characterId, role: 'user', content: '你好', timestamp: 1 },
    { id: 'm2', sessionId: session.id, characterId: session.characterId, role: 'assistant', content: '你好呀', timestamp: 2 },
  ]
  return {
    fetchBuildData: vi.fn(async () => ({
      character: { id: 'character-1', name: 'Aiko' },
      settings: {
        settings: { userName: '大本', activeModel: 'gpt-4o-mini' },
        profile: {
          name: 'test', provider: 'openai', apiKey: 'test-key', baseUrl: 'https://example.test/v1',
          model: 'gpt-4o-mini', maxContext: 32768,
        },
      },
    })),
    listSessions: vi.fn(async () => [session]),
    readMessages: vi.fn(() => messages),
    updateSessionIfMemoryVersion: vi.fn(async () => ({ applied: true, currentVersion: 1 })),
    complete: vi.fn(async () => ({
      text: '【当前状态】\n两人正在交谈。\n\n【时间线】\n两人互相问候。\n\n【事实提案】\n```json\n[]\n```',
    })),
    countTokens: vi.fn((text: string) => Math.max(1, Math.ceil(text.length / 2))),
    now: vi.fn(() => 123456),
    ...overrides,
  }
}

describe('memorySummaryService', () => {
  it('恢复取消全部旧记忆任务，立即重试不复用旧请求', async () => {
    const completion = '【当前状态】\n新状态\n\n【时间线】\n新事件'
    const complete = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue({ text: completion })
    const deps = makeDeps({ complete }), service = createMemorySummaryService(deps as never)
    const old = service.summarize({ characterId: 'character-1', sessionId: 'session-1', automatic: true })
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce())
    service.cancelAll()
    expect(await old).toEqual({ status: 'skipped', reason: 'stale_version' })
    const current = await service.summarize({ characterId: 'character-1', sessionId: 'session-1', automatic: true })
    expect(complete).toHaveBeenCalledTimes(2)
    expect(current.status).toBe('summarized')
    expect(deps.updateSessionIfMemoryVersion).toHaveBeenCalledOnce()
  })
  it('自动模式达到间隔后总结并以 memoryVersion 乐观锁提交', async () => {
    const deps = makeDeps()
    const service = createMemorySummaryService(deps as never)

    const result = await service.summarize({
      characterId: 'character-1', sessionId: 'session-1', automatic: true,
    })

    expect(result.status).toBe('summarized')
    expect(deps.complete).toHaveBeenCalledOnce()
    expect(deps.updateSessionIfMemoryVersion).toHaveBeenCalledWith(
      'character-1',
      'session-1',
      0,
      expect.objectContaining({
        memory: '两人互相问候。',
        memoryCurrentState: '两人正在交谈。',
        memoryLastMessageId: 'm2',
        memoryVersion: 1,
      }), expect.objectContaining({ messages: expect.any(Array), mode: 'range' }))
  })

  it('未达到自动间隔时不请求模型', async () => {
    const deps = makeDeps({
      listSessions: vi.fn(async () => [{
        id: 'session-1', characterId: 'character-1', memoryEnabled: true,
        memoryMode: 'auto', autoMemoryInterval: 10, memory: '', memoryFacts: [], memoryVersion: 0,
      }]),
    })
    const service = createMemorySummaryService(deps as never)

    const result = await service.summarize({
      characterId: 'character-1', sessionId: 'session-1', automatic: true,
    })

    expect(result).toMatchObject({ status: 'skipped', reason: 'interval_not_reached' })
    expect(deps.complete).not.toHaveBeenCalled()
  })

  it('同一会话并发请求复用同一个总结任务', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const deps = makeDeps({
      complete: vi.fn(async () => {
        await gate
        return { text: '【当前状态】\n交谈中。\n【时间线】\n已问候。\n【事实提案】\n```json\n[]\n```' }
      }),
    })
    const service = createMemorySummaryService(deps as never)

    const first = service.summarize({ characterId: 'character-1', sessionId: 'session-1', automatic: true })
    const second = service.summarize({ characterId: 'character-1', sessionId: 'session-1', automatic: false })
    release()
    const [a, b] = await Promise.all([first, second])

    expect(a).toEqual(b)
    expect(deps.complete).toHaveBeenCalledOnce()
  })

  it('自动检查因手动模式跳过时，不会吞掉并发的手动总结', async () => {
    let releaseSessions!: () => void
    const sessionsGate = new Promise<void>((resolve) => { releaseSessions = resolve })
    const manualSession = {
      id: 'session-1', characterId: 'character-1', memoryEnabled: true,
      memoryMode: 'manual', autoMemoryInterval: 2, memory: '', memoryFacts: [], memoryVersion: 0,
    }
    const deps = makeDeps({
      listSessions: vi.fn(async () => {
        await sessionsGate
        return [manualSession]
      }),
      readMessages: vi.fn(() => [
        { id: 'm1', role: 'user', content: '一' },
        { id: 'm2', role: 'assistant', content: '二' },
        { id: 'm3', role: 'user', content: '三' },
        { id: 'm4', role: 'assistant', content: '四' },
      ]),
    })
    const service = createMemorySummaryService(deps as never)

    const automatic = service.summarize({ characterId: 'character-1', sessionId: 'session-1', automatic: true })
    const manual = service.summarize({ characterId: 'character-1', sessionId: 'session-1', automatic: false })
    releaseSessions()
    const [autoResult, manualResult] = await Promise.all([automatic, manual])

    expect(autoResult).toMatchObject({ status: 'skipped', reason: 'manual_mode' })
    expect(manualResult.status).toBe('summarized')
    expect(deps.complete).toHaveBeenCalledOnce()
  })
})


describe('记忆任务来源和生命周期', () => {
  it('提交携带有序消息来源和独立任务身份，公开引用没有连接凭据', async () => {
    const deps = makeDeps()
    const service = createMemorySummaryService(deps as never)
    await service.summarize({ characterId: 'character-1', sessionId: 'session-1', automatic: true })
    const params = (deps.complete.mock.calls as any)[0][0] as any
    expect(params.observability.featureTask.owner).toEqual({ kind: 'single', characterId: 'character-1', sessionId: 'session-1' })
    expect(params.observability.featureTask.sourceRef.messages.map((ref: { id: string }) => ref.id)).toEqual(['m1', 'm2'])
    expect(JSON.stringify(params.observability.featureTask)).not.toContain('test-key')
    expect((deps.updateSessionIfMemoryVersion.mock.calls as any)[0][4]).toEqual(params.observability.featureTask.sourceRef)
  })

  it('删除会话取消运行记忆，晚到完成不提交；之后允许新的任务', async () => {
    let resolveOld!: (value: unknown) => void
    const complete = vi.fn(() => new Promise(resolve => { resolveOld = resolve }))
    const deps = makeDeps({ complete })
    const service = createMemorySummaryService(deps as never)
    const pending = service.summarize({ characterId: 'character-1', sessionId: 'session-1', automatic: true })
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce())
    service.cancel('character-1', 'session-1')
    expect(await pending).toEqual({ status: 'skipped', reason: 'stale_version' })
    resolveOld({ text: '【当前状态】旧状态。\n【时间线】旧事件。', finishReason: 'stop' })
    await Promise.resolve()
    expect(deps.updateSessionIfMemoryVersion).not.toHaveBeenCalled()
  })
})


it('记忆源更新只取消失效窗口，正常追加新消息不影响已选范围', async () => {
  const complete = vi.fn(() => new Promise(() => {}))
  const deps = makeDeps({ complete })
  const original = await deps.readMessages(), current = [...original]
  deps.readMessages.mockImplementation(() => current)
  const service = createMemorySummaryService(deps as never)
  const pending = service.summarize({ characterId: 'character-1', sessionId: 'session-1', automatic: true })
  await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce())
  const signal = (complete.mock.calls as any)[0][1] as AbortSignal
  current.push({ ...original[1], id: 'm3', timestamp: 3, content: '后续正常追加' })
  service.invalidateSource('character-1', 'session-1')
  expect(signal.aborted).toBe(false)
  current[0] = { ...original[0], content: '历史正文已编辑' }
  service.invalidateSource('character-1', 'session-1')
  expect(signal.aborted).toBe(true)
  expect(await pending).toEqual({ status: 'skipped', reason: 'stale_version' })
  expect(deps.updateSessionIfMemoryVersion).not.toHaveBeenCalled()
})
