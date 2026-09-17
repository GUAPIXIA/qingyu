/**
 * preset IPC 处理器单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Preset } from '../../../shared/types'

interface DomainWriteCall {
  domain: string
  entityType: string
  entityId: string
  payload: Record<string, unknown>
  files: { path: string; content: string | null }[]
}

const { mockWriteJson, mockListJsonFilesAsync, mockRemoveFile, mockWriteThroughDomain, mockDeleteThroughDomain } =
  vi.hoisted(() => ({
    mockWriteJson: vi.fn(),
    mockListJsonFilesAsync: vi.fn<() => Promise<Record<string, unknown>[]>>(async () => []),
    mockRemoveFile: vi.fn(),
    mockWriteThroughDomain: vi.fn(),
    mockDeleteThroughDomain: vi.fn(),
  }))

vi.mock('../../services/storage', () => ({
  DIRS: { presets: () => '/mock/presets' },
  writeJson: mockWriteJson,
  serializeJson: (data: unknown) => JSON.stringify(data, null, 2),
  listJsonFilesAsync: mockListJsonFilesAsync,
  removeFile: mockRemoveFile,
}))

// 阶段 2 S2-04：preset 写入必须经事务入口（不再直接 writeJson/removeFile）
vi.mock('../../domain/syncDomainService', () => ({
  writeThroughDomain: mockWriteThroughDomain,
  deleteThroughDomain: mockDeleteThroughDomain,
  commitThroughDomain: vi.fn(),
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
      expect(mockWriteThroughDomain).toHaveBeenCalledTimes(1)
      const input = mockWriteThroughDomain.mock.calls[0][0] as DomainWriteCall
      expect(input.domain).toBe('preset')
      expect(input.entityType).toBe('preset')
      expect(input.entityId).toBe('p1')
      expect(input.files[0].path.endsWith('p1.json')).toBe(true)
      // 文件字节与原 writeJson(JSON.stringify(data, null, 2)) 一致
      expect(JSON.parse(input.files[0].content as string)).toMatchObject({ id: 'p1', name: '测试预设' })
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

  describe('preset:delete', () => {
    it('落 tombstone 并删除对应文件（不裸 unlink）', async () => {
      await handlers['preset:delete'](null, 'p1')
      expect(mockDeleteThroughDomain).toHaveBeenCalledTimes(1)
      const input = mockDeleteThroughDomain.mock.calls[0][0] as DomainWriteCall
      expect(input.domain).toBe('preset')
      expect(input.entityId).toBe('p1')
      expect(input.files).toEqual([{ path: expect.stringContaining('p1.json'), content: null }])
    })
  })
})
