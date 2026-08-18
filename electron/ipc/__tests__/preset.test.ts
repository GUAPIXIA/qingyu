/**
 * preset IPC 处理器单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Preset } from '../../../shared/types'

const { mockWriteJson, mockListJsonFilesAsync, mockRemoveFile } = vi.hoisted(() => ({
  mockWriteJson: vi.fn(),
  mockListJsonFilesAsync: vi.fn<() => Promise<Record<string, unknown>[]>>(async () => []),
  mockRemoveFile: vi.fn(),
}))

vi.mock('../../services/storage', () => ({
  DIRS: { presets: () => '/mock/presets' },
  writeJson: mockWriteJson,
  listJsonFilesAsync: mockListJsonFilesAsync,
  removeFile: mockRemoveFile,
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

import { getBuiltinPresets } from '../preset'

describe('preset IPC', () => {
  let handlers: Record<string, (...args: unknown[]) => unknown>

  beforeEach(async () => {
    vi.clearAllMocks()
    handlers = {}
    const mockIpcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers[channel] = handler
      }),
    }
    const mod = await import('../preset')
    mod.registerPresetIPC(mockIpcMain as any, {} as any)
  })

  describe('preset:list', () => {
    it('返回预设列表', async () => {
      mockListJsonFilesAsync.mockResolvedValue([{ id: 'p1', name: '测试预设' }])
      const result = await handlers['preset:list']() as unknown[]
      expect(Array.isArray(result)).toBe(true)
    })

    it('空目录返回内置预设', async () => {
      mockListJsonFilesAsync.mockResolvedValue([])
      const result = await handlers['preset:list']() as unknown[]
      // 即使没有自定义预设，也应返回内置预设
      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBeGreaterThan(0)
    })
  })

  describe('内置预设', () => {
    it('都有明确分组，短回复模式关闭心理描写', () => {
      const presets = getBuiltinPresets()
      expect(presets.every((preset) => Boolean(preset.group))).toBe(true)
      expect(presets.find((preset) => preset.id === 'builtin-short')?.enableThoughtFormat).toBe(false)
    })
  })

  describe('preset:save', () => {
    it('保存预设', async () => {
      const preset = { id: 'p1', name: '测试预设', content: {} }
      const saved = await handlers['preset:save'](null, preset) as Preset
      expect(mockWriteJson).toHaveBeenCalled()
      expect(saved).toMatchObject({ id: 'p1', name: '测试预设', temperature: 0.8 })
    })

    it('保存内置预设时创建副本且不修改调用方对象', async () => {
      const preset = getBuiltinPresets()[0]
      const originalId = preset.id
      const saved = await handlers['preset:save'](null, preset) as Preset
      expect(saved.id).not.toBe(originalId)
      expect(saved.isBuiltin).toBe(false)
      expect(preset.id).toBe(originalId)
      expect(preset.isBuiltin).toBe(true)
    })
  })
})
