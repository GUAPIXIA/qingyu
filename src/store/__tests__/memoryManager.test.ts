import { beforeEach, describe, expect, it, vi } from 'vitest'

const { vectorizeSessionFactsMock } = vi.hoisted(() => ({
  vectorizeSessionFactsMock: vi.fn(),
}))

vi.mock('../streamController', () => ({
  vectorizeSessionFacts: vectorizeSessionFactsMock,
}))

import { maybeRunAutoMemorySummary, runMemorySummary } from '../memoryManager'

const character = { id: 'char-1', name: 'Aiko' } as never

function state(overrides: Record<string, unknown> = {}) {
  return {
    currentSessionId: 's1',
    sessions: [{
      id: 's1', characterId: 'char-1', memoryEnabled: true, memoryMode: 'auto',
      autoMemoryInterval: 2, memory: '', memoryUpdatedAt: 0,
    }],
    messages: [
      { id: 'm1', role: 'user', content: '你好' },
      { id: 'm2', role: 'assistant', content: '你好呀' },
    ],
    summarizingMemoryKey: null,
    ...overrides,
  }
}

function installApi(result: unknown) {
  const summarizeMemory = vi.fn(async () => result)
  const listSessions = vi.fn(async () => [{
    id: 's1', characterId: 'char-1', memoryEnabled: true, memoryMode: 'auto',
    autoMemoryInterval: 2, memory: '新时间线', memoryUpdatedAt: 1,
  }])
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { chat: { summarizeMemory, listSessions } },
  })
  return { summarizeMemory, listSessions }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runMemorySummary 主进程代理', () => {
  it('成功后刷新会话并触发事实向量化', async () => {
    const api = installApi({
      status: 'summarized',
      summary: '新时间线',
      currentState: '森林中',
      facts: [{ id: 'f1', subject: 'Aiko', predicate: '位置', value: '森林' }],
      memoryVersion: 2,
    })
    const current = state()
    const set = vi.fn()

    const result = await runMemorySummary(() => current as never, set as never, character)

    expect(result).toBe('新时间线')
    expect(api.summarizeMemory).toHaveBeenCalledWith('char-1', 's1', false)
    expect(api.listSessions).toHaveBeenCalledWith('char-1')
    expect(vectorizeSessionFactsMock).toHaveBeenCalledWith(
      'char-1', 's1', expect.any(Array), 2,
    )
  })

  it('手动总结消息不足时给出可见反馈', async () => {
    installApi({ status: 'skipped', reason: 'insufficient_messages' })
    const set = vi.fn()

    const result = await runMemorySummary(() => state() as never, set as never, character)

    expect(result).toBeNull()
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringContaining('没有需要总结的新消息'),
    }))
  })

  it('主进程错误转换为界面可见错误', async () => {
    const summarizeMemory = vi.fn(async () => { throw new Error('API 500') })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { chat: { summarizeMemory, listSessions: vi.fn() } },
    })
    const set = vi.fn()

    const result = await runMemorySummary(() => state() as never, set as never, character)

    expect(result).toBeNull()
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringContaining('AI 服务暂时不可用'),
    }))
  })
})

describe('maybeRunAutoMemorySummary', () => {
  it('达到间隔后请求主进程自动总结', async () => {
    const api = installApi({ status: 'skipped', reason: 'interval_not_reached' })

    await maybeRunAutoMemorySummary(() => state() as never, vi.fn() as never, character)

    expect(api.summarizeMemory).toHaveBeenCalledWith('char-1', 's1', true)
  })

  it('未达到间隔时不跨进程请求', async () => {
    const api = installApi({ status: 'skipped', reason: 'interval_not_reached' })

    await maybeRunAutoMemorySummary(() => state({
      sessions: [{
        id: 's1', characterId: 'char-1', memoryEnabled: true, memoryMode: 'auto',
        autoMemoryInterval: 10, memory: '', memoryUpdatedAt: 0,
      }],
    }) as never, vi.fn() as never, character)

    expect(api.summarizeMemory).not.toHaveBeenCalled()
  })
})
