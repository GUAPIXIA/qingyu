/**
 * quickReply IPC 处理器单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockReadJsonAsync = vi.fn()
const mockWriteJson = vi.fn()

vi.mock('../../services/storage', () => ({
  DIRS: { config: () => '/mock/config' },
  readJson: mockReadJsonAsync,
  readJsonAsync: mockReadJsonAsync,
  writeJson: mockWriteJson,
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
      const store = { global: [{ id: 'qr1', text: '测试' }], byCharacter: {} }
      await handlers['quickReply:saveAll'](null, store)
      expect(mockWriteJson).toHaveBeenCalled()
    })
  })
})
