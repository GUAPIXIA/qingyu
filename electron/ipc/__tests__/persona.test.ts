/**
 * persona IPC 处理器单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockExistsSync = vi.fn(() => true)
const mockReadFileSync = vi.fn(() => '[]')

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
  }
})

vi.mock('../../services/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

vi.mock('../../utils/pathGuard', () => ({
  safeId: vi.fn(),
}))

vi.mock('../../services/storage', () => ({
  DIRS: { config: () => '/mock/config' },
  withFileLock: vi.fn((_path: string, fn: () => unknown) => fn()),
}))

describe('persona IPC', () => {
  let handlers: Record<string, (...args: unknown[]) => unknown>

  beforeEach(async () => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('[]')
    handlers = {}
    const mockIpcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers[channel] = handler
      }),
    }
    const mod = await import('../persona')
    mod.registerPersonaIPC(mockIpcMain as any)
  })

  describe('persona:list', () => {
    it('返回人设列表', async () => {
      const result = await handlers['persona:list']()
      expect(Array.isArray(result)).toBe(true)
    })
  })
})
