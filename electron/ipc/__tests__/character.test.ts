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
const mockImportFromPng = vi.fn()
const mockImportFromJson = vi.fn()
const mockImportCardExtras = vi.fn()
const mockResolveConflict = vi.fn()
const mockRemoveCharacterMedia = vi.fn()
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
  importCharacterFromPng: mockImportFromPng,
  importCharacterFromJson: mockImportFromJson,
  importCardFrontendExtensions: mockImportCardExtras,
  resolveImportConflict: mockResolveConflict,
  removeCharacterMediaFiles: mockRemoveCharacterMedia,
  reloadAvatarFromUrl: vi.fn(),
}))

vi.mock('../../services/storage', () => ({
  DIRS: {
    characters: () => '/mock/characters',
    lorebooks: () => '/mock/lorebooks',
    config: () => '/mock/config',
    groups: () => '/mock/groups',
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
  let mockDialog: { showSaveDialog: ReturnType<typeof vi.fn>; showOpenDialog: ReturnType<typeof vi.fn> }

  beforeEach(async () => {
    vi.clearAllMocks()
    mockListCharacters.mockResolvedValue([mockCharacter])
    mockGetCharacter.mockReturnValue(mockCharacter)
    mockWithFileLock.mockImplementation((_path: string, fn: () => unknown) => fn())
    mockExistsSync.mockReturnValue(true)
    // UEX-P2-04：批量导入用例的默认解析/落地行为（单个用例内可按需覆盖）
    mockImportFromPng.mockImplementation(async (filePath: string) => ({ id: `id-${filePath}`, name: filePath, avatar: '' }))
    mockImportFromJson.mockImplementation(async (filePath: string) => ({ id: `id-${filePath}`, name: filePath, avatar: '' }))
    mockImportCardExtras.mockImplementation(() => ({ regexCount: 0, quickReplyCount: 0, skipped: [] }))
    mockSaveCharacter.mockImplementation(() => {})
    // UEX-P1-17：查重/冲突判定默认「正常导入」（单个用例内可按需覆盖）
    mockResolveConflict.mockImplementation((incoming: { name?: string }) => ({
      outcome: 'imported',
      character: incoming,
      note: `已导入：${incoming.name ?? ''}`,
    }))
    mockRemoveCharacterMedia.mockImplementation(() => {})

    // 注册 IPC handlers 并捕获
    handlers = {}
    const mockIpcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers[channel] = handler
      }),
    }
    mockDialog = { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() }

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

    // UEX-P1-18：导出结果回传 { ok, path?/error? }
    it('成功时返回 ok:true 与落盘路径', async () => {
      mockDialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/out.json' })
      const result = await handlers['character:exportJson'](null, 'test-char-001')
      expect(mockExportCharacterToJson).toHaveBeenCalledWith(mockCharacter, '/tmp/out.json')
      expect(result).toEqual({ ok: true, path: '/tmp/out.json' })
    })

    it('用户取消时返回 canceled 且不写文件', async () => {
      mockDialog.showSaveDialog.mockResolvedValue({ canceled: true })
      const result = await handlers['character:exportJson'](null, 'test-char-001')
      expect(mockExportCharacterToJson).not.toHaveBeenCalled()
      expect(result).toEqual({ ok: false, canceled: true })
    })

    it('底层写入抛错时返回 ok:false 而不是 reject', async () => {
      mockDialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/out.json' })
      mockExportCharacterToJson.mockImplementation(() => { throw new Error('磁盘只读') })
      const result = await handlers['character:exportJson'](null, 'test-char-001')
      expect(result).toEqual({ ok: false, error: '磁盘只读' })
    })
  })

  describe('character:exportPng', () => {
    it('角色不存在时抛异常', async () => {
      mockGetCharacter.mockReturnValue(null)
      await expect(
        handlers['character:exportPng'](null, 'nonexistent')
      ).rejects.toThrow('角色不存在')
    })

    // UEX-P1-18：导出结果回传 { ok, path?/error? }
    it('成功时返回 ok:true 与落盘路径', async () => {
      mockDialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/out.png' })
      const result = await handlers['character:exportPng'](null, 'test-char-001')
      expect(mockExportCharacterToPng).toHaveBeenCalledWith(mockCharacter, '/tmp/out.png')
      expect(result).toEqual({ ok: true, path: '/tmp/out.png' })
    })

    it('用户取消时返回 canceled 且不写文件', async () => {
      mockDialog.showSaveDialog.mockResolvedValue({ canceled: true })
      const result = await handlers['character:exportPng'](null, 'test-char-001')
      expect(mockExportCharacterToPng).not.toHaveBeenCalled()
      expect(result).toEqual({ ok: false, canceled: true })
    })

    it('底层写入抛错时返回 ok:false 而不是 reject', async () => {
      mockDialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/out.png' })
      mockExportCharacterToPng.mockImplementation(() => { throw new Error('磁盘只读') })
      const result = await handlers['character:exportPng'](null, 'test-char-001')
      expect(result).toEqual({ ok: false, error: '磁盘只读' })
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

  // ===== UEX-P2-04：批量导入取消能力 + 防重入 =====
  describe('character:importBatch（UEX-P2-04 取消/防重入）', () => {
    const mockEvent = { sender: {} }

    it('取消后不再处理剩余文件，返回 canceled 汇总（成功/失败/未处理）', async () => {
      mockDialog.showOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: ['/cards/a.png', '/cards/b.png', '/cards/c.png'],
      })
      // 第一个文件解析时触发取消：其余文件停在文件边界不再解析
      mockImportFromPng.mockImplementation(async (filePath: string) => {
        if (filePath.endsWith('a.png')) {
          void handlers['character:importBatchCancel']()
        }
        return { id: `id-${filePath}`, name: filePath, avatar: '' }
      })

      const result = (await handlers['character:importBatch'](mockEvent)) as Record<string, unknown>

      expect(result.canceled).toBe(true)
      expect(result.successCount).toBe(0)
      expect(result.failCount).toBe(0)
      expect(result.skippedCount).toBe(3)
      expect(result.results).toEqual([])
      expect(mockImportFromPng).toHaveBeenCalledTimes(1) // b/c 不再解析
      expect(mockSaveCharacter).not.toHaveBeenCalled() // 落盘全部停止
    })

    it('落盘阶段取消后停止处理剩余文件，已完成的导入保留（不回滚）', async () => {
      mockDialog.showOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: ['a.png', 'b.png', 'c.png', 'd.png', 'e.png'],
      })
      // 第一次落盘即触发取消：并发池（3 并发 / 5 文件）在下一个文件边界停止
      mockSaveCharacter.mockImplementation(() => {
        void handlers['character:importBatchCancel']()
      })

      const result = (await handlers['character:importBatch'](mockEvent)) as Record<string, unknown>

      expect(mockImportFromPng).toHaveBeenCalledTimes(5) // 阶段1解析均已完成（不强杀）
      expect(mockSaveCharacter).toHaveBeenCalledTimes(1) // 只有取消前已开始的 1 个文件落盘
      expect(result.canceled).toBe(true)
      expect(result.successCount).toBe(1) // 已完成的导入保留
      expect(result.failCount).toBe(0)
      expect(result.skippedCount).toBe(4)
      expect(result.results).toHaveLength(1)
    })

    it('重复取消幂等：无批次时取消安全，批内重复取消结果不变', async () => {
      // 无进行中批次：取消是安全 no-op，不抛错
      await handlers['character:importBatchCancel']()
      await handlers['character:importBatchCancel']()

      mockDialog.showOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: ['a.png', 'b.png', 'c.png'],
      })
      // 批内连续两次取消：结果与单次取消一致
      mockSaveCharacter.mockImplementation(() => {
        void handlers['character:importBatchCancel']()
        void handlers['character:importBatchCancel']()
      })

      const result = (await handlers['character:importBatch'](mockEvent)) as Record<string, unknown>

      expect(result.canceled).toBe(true)
      expect(result.successCount).toBe(1)
      expect(result.failCount).toBe(0)
      expect(result.skippedCount).toBe(2)
      expect(mockSaveCharacter).toHaveBeenCalledTimes(1)
    })

    it('防重入：进行中批次再次触发返回「已有导入任务进行中」，结束后可立即重新发起', async () => {
      let resolveDialog!: (v: unknown) => void
      mockDialog.showOpenDialog.mockImplementationOnce(() => new Promise((resolve) => { resolveDialog = resolve }))

      const first = handlers['character:importBatch'](mockEvent) as Promise<unknown>
      // 批次进行中再次触发：主进程兜底直接报错
      const second = (await handlers['character:importBatch'](mockEvent)) as Record<string, unknown>
      expect(second).toEqual({ success: false, error: '已有导入任务进行中' })

      // 结束第一个批次（选文件对话框取消）
      resolveDialog({ canceled: true })
      expect(await first).toEqual({ success: false, canceled: true })

      // 取消/结束后立即重新发起：正常放行（不再报「已有导入任务进行中」）
      mockDialog.showOpenDialog.mockResolvedValueOnce({ canceled: true })
      expect(await handlers['character:importBatch'](mockEvent)).toEqual({ success: false, canceled: true })
    })
  })

  // ===== UEX-P1-17：导入查重（相同跳过、冲突副本、显式覆盖） =====
  describe('character:importJson（UEX-P1-17 导入查重）', () => {
    const mockEvent = { sender: {} }

    it('内容相同 → 跳过：不落盘，回传 outcome/note 明细「已存在相同角色：{name}」', async () => {
      mockDialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/cards/a.json'] })
      mockResolveConflict.mockImplementation((incoming: Record<string, unknown>) => ({
        outcome: 'skippedIdentical',
        character: incoming,
        note: '已存在相同角色：艾莉娅',
      }))

      const result = (await handlers['character:importJson'](mockEvent)) as Record<string, unknown>

      expect(result).toEqual({ success: true, outcome: 'skippedIdentical', note: '已存在相同角色：艾莉娅' })
      expect(mockSaveCharacter).not.toHaveBeenCalled()
      expect(mockImportCardExtras).not.toHaveBeenCalled()
    })

    it('conflict 缺省按 copy（另存副本）判定并落盘副本', async () => {
      mockDialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/cards/a.json'] })
      mockResolveConflict.mockImplementation((incoming: Record<string, unknown>) => ({
        outcome: 'copied',
        character: { ...incoming, name: `${String(incoming.name)}（副本）` },
        note: '已另存副本：/cards/a.json（副本）',
      }))

      const result = (await handlers['character:importJson'](mockEvent)) as Record<string, unknown>

      expect(mockResolveConflict).toHaveBeenCalledWith(expect.anything(), expect.any(Array), 'copy')
      expect(mockSaveCharacter).toHaveBeenCalledWith(expect.objectContaining({ name: '/cards/a.json（副本）' }))
      expect(result).toMatchObject({ success: true, outcome: 'copied', note: '已另存副本：/cards/a.json（副本）' })
    })

    it('显式覆盖（conflict=overwrite）：保留原 id 落盘并清理旧媒体', async () => {
      mockDialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/cards/a.json'] })
      mockResolveConflict.mockImplementation(() => ({
        outcome: 'overwritten',
        character: { ...mockCharacter, description: '重制版设定' },
        note: '已覆盖同名角色：测试角色',
      }))

      const result = (await handlers['character:importJson'](mockEvent, 'overwrite')) as Record<string, unknown>

      expect(mockResolveConflict).toHaveBeenCalledWith(expect.anything(), expect.any(Array), 'overwrite')
      // 覆盖保留原卡 id（会话按 characterId 关联），且落盘前清理旧头像/封面媒体
      expect(mockRemoveCharacterMedia).toHaveBeenCalledWith('test-char-001')
      expect(mockSaveCharacter).toHaveBeenCalledWith(expect.objectContaining({ id: 'test-char-001', description: '重制版设定' }))
      expect(result).toMatchObject({
        success: true,
        outcome: 'overwritten',
        note: '已覆盖同名角色：测试角色',
        character: { id: 'test-char-001' },
      })
    })
  })

  describe('character:importBatch（UEX-P1-17 查重计数/批内去重）', () => {
    const mockEvent = { sender: {} }

    it('查重结果计入 skippedIdentical/copied/overwritten 计数，明细带 outcome 字段', async () => {
      mockDialog.showOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: ['a.png', 'b.png', 'c.png', 'd.png'],
      })
      mockResolveConflict.mockImplementation((incoming: { id: string; name: string; avatar?: string }) => {
        if (incoming.name === 'a.png') return { outcome: 'skippedIdentical', character: incoming, note: '已存在相同角色：a.png' }
        if (incoming.name === 'b.png') return { outcome: 'copied', character: { ...incoming, name: 'b.png（副本）' }, note: '已另存副本：b.png（副本）' }
        if (incoming.name === 'c.png') return { outcome: 'overwritten', character: { ...incoming, id: 'kept-id' }, note: '已覆盖同名角色：c.png' }
        return { outcome: 'imported', character: incoming, note: `已导入：${incoming.name}` }
      })

      const result = (await handlers['character:importBatch'](mockEvent)) as Record<string, unknown>

      expect(result.total).toBe(4)
      expect(result.successCount).toBe(3) // 落盘数（含副本/覆盖）；相同跳过单列
      expect(result.failCount).toBe(0)
      expect(result.skippedIdentical).toBe(1)
      expect(result.copied).toBe(1)
      expect(result.overwritten).toBe(1)
      expect(result.skippedCount).toBe(0) // 未处理不含内容相同自动跳过的
      expect(mockSaveCharacter).toHaveBeenCalledTimes(3)

      const entries = result.results as Array<Record<string, unknown>>
      expect(entries.find((r) => r.name === 'a.png')).toMatchObject({ outcome: 'skippedIdentical', note: '已存在相同角色：a.png', success: true })
      expect(entries.find((r) => r.outcome === 'copied')).toMatchObject({ name: 'b.png（副本）', note: '已另存副本：b.png（副本）' })
      // 覆盖：清理旧媒体并以原 id 落盘
      expect(mockRemoveCharacterMedia).toHaveBeenCalledWith('kept-id')
      expect(mockSaveCharacter).toHaveBeenCalledWith(expect.objectContaining({ id: 'kept-id' }))
    })

    it('批内去重：两张内容相同的卡只落盘一次，第二张计入 skippedIdentical', async () => {
      mockDialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['x.png', 'y.png'] })
      // 两个文件解析出内容完全相同的卡
      mockImportFromPng.mockImplementation(async () => ({ id: 'x-id', name: '同名角色', description: '同内容', avatar: '' }))
      // 迷你判定（模拟 charCard.resolveImportConflict 接线）：批内去重依赖调用方把已决策角色并入 existing
      mockResolveConflict.mockImplementation((
        incoming: { id: string; name: string; description?: string },
        existing: Array<{ id: string; name: string; description?: string }>,
        policy: string,
      ) => {
        const fp = `${incoming.name}|${incoming.description ?? ''}`
        const identical = existing.find((c) => `${c.name}|${c.description ?? ''}` === fp)
        if (identical) return { outcome: 'skippedIdentical', character: incoming, note: `已存在相同角色：${identical.name}` }
        const target = existing.find((c) => c.name === incoming.name)
        if (!target) return { outcome: 'imported', character: incoming, note: `已导入：${incoming.name}` }
        if (policy === 'overwrite') return { outcome: 'overwritten', character: { ...incoming, id: target.id }, note: `已覆盖同名角色：${target.name}` }
        const taken = new Set(existing.map((c) => c.name))
        let name = `${incoming.name}（副本）`
        for (let n = 2; taken.has(name); n++) name = `${incoming.name}（副本 ${n}）`
        return { outcome: 'copied', character: { ...incoming, name }, note: `已另存副本：${name}` }
      })

      const result = (await handlers['character:importBatch'](mockEvent)) as Record<string, unknown>

      expect(mockSaveCharacter).toHaveBeenCalledTimes(1)
      expect(result.successCount).toBe(1)
      expect(result.skippedIdentical).toBe(1)
      expect(result.skippedCount).toBe(0)
      expect((result.results as Array<Record<string, unknown>>).find((r) => r.outcome === 'skippedIdentical')?.note).toBe('已存在相同角色：同名角色')
    })

    it('批内同名不同内容 → 副本命名递增（同策略去重链）', async () => {
      mockDialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['p1.png', 'p2.png', 'p3.png'] })
      mockImportFromPng.mockImplementation(async (filePath: string) => ({
        id: `id-${filePath}`,
        name: '卡莲',
        description: `内容-${filePath}`,
        avatar: '',
      }))
      mockResolveConflict.mockImplementation((
        incoming: { id: string; name: string; description?: string },
        existing: Array<{ id: string; name: string; description?: string }>,
        policy: string,
      ) => {
        const fp = `${incoming.name}|${incoming.description ?? ''}`
        const identical = existing.find((c) => `${c.name}|${c.description ?? ''}` === fp)
        if (identical) return { outcome: 'skippedIdentical', character: incoming, note: `已存在相同角色：${identical.name}` }
        const target = existing.find((c) => c.name === incoming.name)
        if (!target) return { outcome: 'imported', character: incoming, note: `已导入：${incoming.name}` }
        if (policy === 'overwrite') return { outcome: 'overwritten', character: { ...incoming, id: target.id }, note: `已覆盖同名角色：${target.name}` }
        const taken = new Set(existing.map((c) => c.name))
        let name = `${incoming.name}（副本）`
        for (let n = 2; taken.has(name); n++) name = `${incoming.name}（副本 ${n}）`
        return { outcome: 'copied', character: { ...incoming, name }, note: `已另存副本：${name}` }
      })

      const result = (await handlers['character:importBatch'](mockEvent)) as Record<string, unknown>

      expect(result.copied).toBe(2)
      expect(result.successCount).toBe(3)
      const savedNames = mockSaveCharacter.mock.calls.map((c) => (c[0] as { name: string }).name)
      expect(savedNames).toEqual(['卡莲', '卡莲（副本）', '卡莲（副本 2）'])
    })
  })
})
