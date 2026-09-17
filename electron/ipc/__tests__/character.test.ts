/**
 * character IPC 处理器单元测试
 * 覆盖：list / get / save / delete / bindLorebook / exportPng / exportJson / exportCover
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ===== Mocks =====
const mockListCharacters = vi.fn()
const mockGetCharacter = vi.fn()
const mockSaveCharacter = vi.fn()
const mockDeleteCharacter = vi.fn()
const mockExportCharacterToPng = vi.fn()
const mockExportCharacterToJson = vi.fn()
const mockExportCharacterCover = vi.fn()
const mockGetCoverExtension = vi.fn()
const mockWithFileLock = vi.fn((_path: string, fn: () => unknown) => fn())
const mockExistsSync = vi.fn(() => true)
const mockSafeId = vi.fn()

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: mockExistsSync,
  }
})

vi.mock('../../services/charCard', () => ({
  listCharacters: mockListCharacters,
  getCharacter: mockGetCharacter,
  saveCharacterThroughDomain: mockSaveCharacter,
  deleteCharacterThroughDomain: mockDeleteCharacter,
  exportCharacterToPng: mockExportCharacterToPng,
  exportCharacterToJson: mockExportCharacterToJson,
  exportCharacterCover: mockExportCharacterCover,
  getCoverExtension: mockGetCoverExtension,
  importCharacterFromPng: vi.fn(),
  importCharacterFromJson: vi.fn(),
  importCardFrontendExtensions: vi.fn(),
  reloadAvatarFromUrl: vi.fn(),
}))

vi.mock('../../services/storage', () => ({
  DIRS: {
    characters: () => '/mock/characters',
    lorebooks: () => '/mock/lorebooks',
    config: () => '/mock/config',
  },
  readJson: vi.fn(),
  withFileLock: mockWithFileLock,
}))

vi.mock('../../services/lorebookMatcher', () => ({
  suggestLorebooks: vi.fn(() => []),
}))

vi.mock('../../utils/pathGuard', () => ({
  safeId: mockSafeId,
}))

vi.mock('../../services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

vi.mock('../../utils/safeSend', () => ({
  safeSend: vi.fn(),
}))

// ===== 测试数据 =====
const mockCharacter = {
  id: 'test-char-001',
  name: '测试角色',
  description: '测试描述',
  personality: '温柔',
  scenario: '现代都市',
  firstMessage: '你好！',
  updatedAt: Date.now(),
}

// ===== 测试 =====
describe('character IPC', () => {
  let handlers: Record<string, (...args: unknown[]) => unknown>
  let mockDialog: { showSaveDialog: ReturnType<typeof vi.fn> }

  beforeEach(async () => {
    vi.clearAllMocks()
    mockListCharacters.mockResolvedValue([mockCharacter])
    mockGetCharacter.mockReturnValue(mockCharacter)
    mockWithFileLock.mockImplementation((_path: string, fn: () => unknown) => fn())
    mockExistsSync.mockReturnValue(true)

    // 注册 IPC handlers 并捕获
    handlers = {}
    const mockIpcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers[channel] = handler
      }),
    }
    mockDialog = { showSaveDialog: vi.fn() }

    // 动态导入以触发 handler 注册
    const mod = await import('../character')
    mod.registerCharacterIPC(mockIpcMain as any, mockDialog as any)
  })

  describe('character:list', () => {
    it('返回角色列表', async () => {
      const result = await handlers['character:list']()
      expect(mockListCharacters).toHaveBeenCalled()
      expect(result).toEqual([mockCharacter])
    })
  })

  describe('character:get', () => {
    it('返回指定角色', async () => {
      const result = await handlers['character:get'](null, 'test-char-001')
      expect(mockSafeId).toHaveBeenCalledWith('test-char-001')
      expect(mockGetCharacter).toHaveBeenCalledWith('test-char-001')
      expect(result).toEqual(mockCharacter)
    })
  })

  describe('character:save', () => {
    it('保存角色并更新时间戳', async () => {
      const charToSave = { ...mockCharacter }
      await handlers['character:save'](null, charToSave)
      expect(mockSafeId).toHaveBeenCalledWith('test-char-001')
      expect(mockSaveCharacter).toHaveBeenCalled()
      // 验证 updatedAt 被更新
      const savedChar = mockSaveCharacter.mock.calls[0][0]
      expect(savedChar.updatedAt).toBeGreaterThan(0)
    })
  })

  describe('character:delete', () => {
    it('删除角色', async () => {
      await handlers['character:delete'](null, 'test-char-001')
      expect(mockSafeId).toHaveBeenCalledWith('test-char-001')
      expect(mockDeleteCharacter).toHaveBeenCalledWith('test-char-001')
    })
  })

  describe('character:bindLorebook', () => {
    it('解绑世界书（传 null）不触发 existsSync 检查', async () => {
      mockGetCharacter.mockReturnValue({ ...mockCharacter, boundLorebookIds: ['lb-001'] })

      await handlers['character:bindLorebook'](null, 'test-char-001', null)
      expect(mockSaveCharacter).toHaveBeenCalled()
      const savedChar = mockSaveCharacter.mock.calls[0][0]
      expect(savedChar.boundLorebookIds).toEqual([])
    })
  })

  describe('character:exportJson', () => {
    it('角色不存在时抛异常', async () => {
      mockGetCharacter.mockReturnValue(null)
      await expect(
        handlers['character:exportJson'](null, 'nonexistent')
      ).rejects.toThrow('角色不存在')
    })
  })

  describe('character:exportPng', () => {
    it('角色不存在时抛异常', async () => {
      mockGetCharacter.mockReturnValue(null)
      await expect(
        handlers['character:exportPng'](null, 'nonexistent')
      ).rejects.toThrow('角色不存在')
    })
  })

  describe('character:exportCover', () => {
    it('角色不存在时抛异常', async () => {
      mockGetCharacter.mockReturnValue(null)
      await expect(
        handlers['character:exportCover'](null, 'nonexistent')
      ).rejects.toThrow('角色不存在')
    })

    it('无封面时返回 ok:false 且不弹保存框', async () => {
      mockGetCoverExtension.mockReturnValue(null)
      const result = await handlers['character:exportCover'](null, 'test-char-001')
      expect(result).toEqual({ ok: false, error: '该角色没有可导出的封面图片' })
      expect(mockDialog.showSaveDialog).not.toHaveBeenCalled()
      expect(mockExportCharacterCover).not.toHaveBeenCalled()
    })

    it('按封面真实格式作为默认文件名导出', async () => {
      mockGetCoverExtension.mockReturnValue('jpg')
      mockDialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/out.jpg' })

      const result = await handlers['character:exportCover'](null, 'test-char-001')

      expect(mockDialog.showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({
        defaultPath: `${mockCharacter.name}-封面.jpg`,
        filters: [{ name: 'JPG 图片', extensions: ['jpg'] }],
      }))
      expect(mockExportCharacterCover).toHaveBeenCalledWith(mockCharacter, '/tmp/out.jpg')
      expect(result).toEqual({ ok: true })
    })

    it('用户取消时返回 canceled 且不写文件', async () => {
      mockGetCoverExtension.mockReturnValue('png')
      mockDialog.showSaveDialog.mockResolvedValue({ canceled: true })

      const result = await handlers['character:exportCover'](null, 'test-char-001')

      expect(mockExportCharacterCover).not.toHaveBeenCalled()
      expect(result).toEqual({ ok: false, canceled: true })
    })

    it('底层写入抛错时返回 ok:false 而不是 reject', async () => {
      mockGetCoverExtension.mockReturnValue('png')
      mockDialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/out.png' })
      mockExportCharacterCover.mockImplementation(() => { throw new Error('磁盘只读') })

      const result = await handlers['character:exportCover'](null, 'test-char-001')

      expect(result).toEqual({ ok: false, error: '磁盘只读' })
    })
  })
})
