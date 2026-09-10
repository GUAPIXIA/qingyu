import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsageRecord } from '../../../shared/types'

vi.mock('../storage', () => ({
  DIRS: { config: () => '/mock/config' },
  readJson: vi.fn(() => []),
  writeJson: vi.fn(),
  withFileLock: vi.fn(),
}))

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

import { aggregateUsage } from '../usage'

function record(timestamp: string, totalChars: number): UsageRecord {
  return {
    id: timestamp,
    timestamp: Date.parse(timestamp),
    characterId: 'char-1',
    sessionId: 'session-1',
    model: 'model-1',
    inputChars: 0,
    outputChars: totalChars,
    totalChars,
  }
}

describe('aggregateUsage 按天统计', () => {
  beforeEach(() => vi.clearAllMocks())

  it('按用户时区归日，并按日期倒序而不是按字符量排序', () => {
    const result = aggregateUsage([
      record('2026-09-09T15:30:00.000Z', 900),
      record('2026-09-09T16:30:00.000Z', 10),
    ], 'day', 'Asia/Shanghai')

    expect(result.map((item) => item.key)).toEqual(['2026-09-10', '2026-09-09'])
    expect(result.map((item) => item.totalChars)).toEqual([10, 900])
  })
})
