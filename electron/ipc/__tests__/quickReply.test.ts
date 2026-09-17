/**
 * quickReply IPC 处理器单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface DomainCommitCall {
  domain: string
  entityType: string
  puts: { entityId: string; payload: Record<string, unknown> }[]
  deletes: { entityId: string }[]
  files: { path: string; content: string | null }[]
}

const mockReadJsonAsync = vi.fn()
const mockWriteJson = vi.fn()
const mockCommitThroughDomain = vi.fn()

vi.mock('../../services/storage', () => ({
  DIRS: { config: () => '/mock/config' },
  readJson: mockReadJsonAsync,
  readJsonAsync: mockReadJsonAsync,
  writeJson: mockWriteJson,
  serializeJson: (data: unknown) => JSON.stringify(data, null, 2),
}))

// 阶段 2 S2-04：quickReplies.json 写入必须经事务入口（不再直接 writeJson）
vi.mock('../../domain/syncDomainService', () => ({
  commitThroughDomain: mockCommitThroughDomain,
  writeThroughDomain: vi.fn(),
  deleteThroughDomain: vi.fn(),
}))

vi.mock('../../services/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

describe('quickReply IPC', () => {
  let handlers: Record<string, (...args: unknown[]) => unknown>
  const mockDialog = { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() }

  beforeEach(async () => {
    vi.clearAllMocks()
    mockReadJsonAsync.mockResolvedValue({ global: [], byCharacter: {} })
    handlers = {}
    const mockIpcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers[channel] = handler
      }),
    }
    const mod = await import('../quickReply')
    mod.registerQuickReplyIPC(mockIpcMain as any, mockDialog as any)
  })

  describe('quickReply:listAll', () => {
    it('返回快捷回复存储', async () => {
      const result = await handlers['quickReply:listAll']()
      expect(result).toHaveProperty('global')
      expect(result).toHaveProperty('byCharacter')
    })
  })

  describe('quickReply:saveAll', () => {
    it('保存快捷回复存储', async () => {
      const store = { global: [{ id: 'qr1', label: '测试', content: 'hi' }], byCharacter: {} }
      await handlers['quickReply:saveAll'](null, store)
      expect(mockCommitThroughDomain).toHaveBeenCalledTimes(1)
      const input = mockCommitThroughDomain.mock.calls[0][0] as DomainCommitCall
      expect(input.domain).toBe('quick_reply_set')
      expect(input.entityType).toBe('quick_reply_set')
      // 整库单实体与 S2-05 扫描器一致；payload 为真实内容（不再是条数骨架）
      expect(input.puts).toHaveLength(1)
      expect(input.puts[0].entityId).toBe('quick-replies-root')
      expect(input.puts[0].payload).toMatchObject({
        global: [expect.objectContaining({ id: 'qr1', label: '测试' })],
        byCharacter: {},
      })
      expect(input.deletes).toEqual([])
      // 落盘字节与原 writeJson(JSON.stringify(data, null, 2)) 一致
      const written = JSON.parse(input.files[0].content as string) as { global: { id: string }[] }
      expect(written.global[0].id).toBe('qr1')
    })
  })

  describe('quickReply:clearCharacter', () => {
    it('删除角色级快捷回复时落 tombstone', async () => {
      mockReadJsonAsync.mockReturnValue({
        global: [],
        byCharacter: { c1: [{ id: 'qr1', label: '测试', content: 'hi' }] },
      })
      await handlers['quickReply:clearCharacter'](null, 'c1')
      expect(mockCommitThroughDomain).toHaveBeenCalledTimes(1)
      const input = mockCommitThroughDomain.mock.calls[0][0] as DomainCommitCall
      expect(input.deletes).toEqual([{ entityId: 'qr-char-c1' }])
    })
  })
})
