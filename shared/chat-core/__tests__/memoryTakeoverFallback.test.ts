/**
 * W8 接管回滚路径（spec T2）：materializeMemoryInjection 异常时必须回落
 * fitLayeredMemoryBudget，system 仍含【当前状态】，且不抛到调用方。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../memoryCandidates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../memoryCandidates')>()
  return {
    ...actual,
    materializeMemoryInjection: vi.fn(() => {
      throw new Error('materialize-boom')
    }),
  }
})

import { buildContextMessagesFromData } from '../contextBuilder'
import { makeData, makeFact } from './contextBuildFixtures'

function makeFallbackData() {
  const base = makeData()
  return {
    ...base,
    chat: {
      ...base.chat,
      sessions: [
        {
          ...base.chat.sessions[0],
          memoryEnabled: true,
          memoryCurrentState: '回滚状态：仍在废土避难所',
          memory: '1. 早期事件\n2. 近期事件',
          memoryFacts: [makeFact({ id: 'rb-1', subject: '主角', predicate: '状态', value: '回滚事实值' })],
          memoryUpdatedAt: 3500,
        },
      ],
    },
  }
}

describe('W8 记忆接管回滚（materialize 异常）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('物化抛错时回落 fitLayeredMemoryBudget，仍注入状态且不崩溃', () => {
    const data = makeFallbackData()
    const built = buildContextMessagesFromData(data, { shadow: 'shadow' })
    const systemText = built.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n')
    expect(systemText).toContain('【当前状态】')
    expect(systemText).toContain('回滚状态：仍在废土避难所')
    expect(systemText).toContain('回滚事实值')
    expect(built.memoryShadow?.degraded).toBe(false)
  })

  it('回落不修改输入存储快照', () => {
    const data = makeFallbackData()
    const snapshot = JSON.stringify(data)
    buildContextMessagesFromData(data, { shadow: 'shadow' })
    expect(JSON.stringify(data)).toBe(snapshot)
  })
})
