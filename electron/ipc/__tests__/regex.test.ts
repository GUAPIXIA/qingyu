/**
 * regex IPC 处理器单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockReadJson = vi.fn()

vi.mock('../../services/storage', () => ({
  DIRS: { config: () => '/mock/config' },
  readJson: mockReadJson,
  writeJson: vi.fn(),
  withFileLock: vi.fn((_path: string, fn: () => unknown) => fn()),
}))

vi.mock('../../services/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
  }
})

import { registerRegexIPC } from '../regex'

describe('regex IPC', () => {
  let handlers: Record<string, Function>

  beforeEach(async () => {
    vi.clearAllMocks()
    mockReadJson.mockReturnValue([])
    handlers = {}
    const mockIpcMain = {
      handle: vi.fn((channel: string, handler: Function) => {
        handlers[channel] = handler
      }),
    }
    const mod = await import('../regex')
    mod.registerRegexIPC(mockIpcMain as any)
  })

  describe('regex:list', () => {
    it('返回正则规则列表', async () => {
      const result = await handlers['regex:list']()
      expect(Array.isArray(result)).toBe(true)
    })
  })
})
