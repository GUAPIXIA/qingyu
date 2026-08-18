/**
 * preset IPC 处理器单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockReadJsonAsync = vi.fn()
const mockWriteJson = vi.fn()
const mockListJsonFilesAsync = vi.fn(async () => [])

vi.mock('../../services/storage', () => ({
  DIRS: { presets: () => '/mock/presets' },
  readJsonAsync: mockReadJsonAsync,
  writeJson: mockWriteJson,
  listJsonFilesAsync: mockListJsonFilesAsync,
}))

vi.mock('../../services/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

vi.mock('../../utils/pathGuard', () => ({
  safeId: vi.fn(),
}))

vi.mock('../../ipc/settings', () => ({
  restoreSecrets: vi.fn(),
}))

import { registerPresetIPC } from '../preset'

describe('preset IPC', () => {
  let handlers: Record<string, Function>

  beforeEach(async () => {
    vi.clearAllMocks()
    handlers = {}
    const mockIpcMain = {
      handle: vi.fn((channel: string, handler: Function) => {
        handlers[channel] = handler
      }),
    }
    const mod = await import('../preset')
    mod.registerPresetIPC(mockIpcMain as any)
  })

  describe('preset:list', () => {
    it('返回预设列表', async () => {
      mockListJsonFilesAsync.mockResolvedValue(['preset1.json'])
      mockReadJsonAsync.mockResolvedValue({ id: 'p1', name: '测试预设' })
      const result = await handlers['preset:list']()
      expect(Array.isArray(result)).toBe(true)
    })

    it('空目录返回内置预设', async () => {
      mockListJsonFilesAsync.mockResolvedValue([])
      const result = await handlers['preset:list']()
      // 即使没有自定义预设，也应返回内置预设
      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBeGreaterThan(0)
    })
  })

  describe('preset:save', () => {
    it('保存预设', async () => {
      const preset = { id: 'p1', name: '测试预设', content: {} }
      await handlers['preset:save'](null, preset)
      expect(mockWriteJson).toHaveBeenCalled()
    })
  })
})
