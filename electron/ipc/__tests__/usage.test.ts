/**
 * usage IPC 处理器单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../services/storage', () => ({
  DIRS: { config: () => '/mock/config' },
  readJson: vi.fn(() => []),
  writeJson: vi.fn(),
}))

vi.mock('../../services/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

vi.mock('../../services/usage', () => ({
  getSummary: vi.fn(() => ({ totalInput: 0, totalOutput: 0, totalChars: 0, count: 0 })),
  queryUsage: vi.fn(() => []),
  aggregateUsage: vi.fn(() => []),
  clearUsage: vi.fn(),
}))

describe('usage IPC', () => {
  let handlers: Record<string, (...args: unknown[]) => unknown>

  beforeEach(async () => {
    vi.clearAllMocks()
    handlers = {}
    const mockIpcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers[channel] = handler
      }),
    }
    const mod = await import('../usage')
    mod.registerUsageIPC(mockIpcMain as any)
  })

  describe('usage:summary', () => {
    it('返回用量摘要', async () => {
      const result = await handlers['usage:summary'](null, {})
      expect(result).toHaveProperty('totalChars')
    })
  })

  describe('usage:query', () => {
    it('返回用量记录', async () => {
      const result = await handlers['usage:query'](null, {})
      expect(Array.isArray(result)).toBe(true)
    })
  })
})
