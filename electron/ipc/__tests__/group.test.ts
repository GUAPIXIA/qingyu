/**
 * group IPC 处理器单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../services/storage', () => ({
  DIRS: {
    groups: () => '/mock/groups',
    groupSessions: () => '/mock/group-sessions',
  },
  readJson: vi.fn(),
  writeJson: vi.fn(),
  readJsonAsync: vi.fn(async () => []),
  listJsonFilesAsync: vi.fn(async () => []),
}))

vi.mock('../../services/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

vi.mock('../../ipc/chat', () => ({
  messagesCacheInvalidate: vi.fn(),
}))

vi.mock('../../utils/pathGuard', () => ({
  safeId: vi.fn(),
}))

vi.mock('nanoid', () => ({
  nanoid: () => 'mock-id-123',
}))

describe('group IPC', () => {
  let handlers: Record<string, (...args: unknown[]) => unknown>

  beforeEach(async () => {
    vi.clearAllMocks()
    handlers = {}
    const mockIpcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers[channel] = handler
      }),
    }
    const mod = await import('../group')
    mod.registerGroupIPC(mockIpcMain as any)
  })

  describe('group:list', () => {
    it('返回空列表当无群聊', async () => {
      const result = await handlers['group:list']()
      expect(result).toEqual([])
    })
  })
})
