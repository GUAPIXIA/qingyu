import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'
import type { ExposedAPI } from '../../shared/ipc-api'

// Mock window.api - 所有 IPC 方法 mock 为 vi.fn()
const mockApi: Partial<ExposedAPI> = {
  ai: {
    chat: vi.fn().mockResolvedValue(undefined),
    cancelChat: vi.fn().mockResolvedValue(undefined),
    testConnection: vi.fn().mockResolvedValue({ success: true }),
    listModels: vi.fn().mockResolvedValue({ success: true, models: [] }),
    onChunk: vi.fn().mockReturnValue(() => {}),
    onDone: vi.fn().mockReturnValue(() => {}),
    onError: vi.fn().mockReturnValue(() => {}),
    onUsage: vi.fn().mockReturnValue(() => {}),
    countTokens: vi.fn().mockResolvedValue(0),
    countMessagesTokens: vi.fn().mockResolvedValue([]),
  } as any,
  character: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  } as any,
  chat: {
    listSessions: vi.fn().mockResolvedValue([]),
    createSession: vi.fn().mockResolvedValue({ id: 'test-session', characterId: 'test-char', title: 'Test' }),
    listMessages: vi.fn().mockResolvedValue([]),
    saveMessage: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
  } as any,
  settings: {
    get: vi.fn().mockResolvedValue({}),
    save: vi.fn().mockResolvedValue(undefined),
    saveAPICredential: vi.fn().mockResolvedValue(undefined),
    getAPICredential: vi.fn().mockResolvedValue(null),
    exportBackup: vi.fn().mockResolvedValue(undefined),
    importBackup: vi.fn().mockResolvedValue(undefined),
  } as any,
  lorebook: {
    list: vi.fn().mockResolvedValue([]),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  } as any,
  preset: {
    list: vi.fn().mockResolvedValue([]),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  } as any,
  group: {
    list: vi.fn().mockResolvedValue([]),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    listSessions: vi.fn().mockResolvedValue([]),
    createSession: vi.fn().mockResolvedValue({ id: 'test' }),
    listMessages: vi.fn().mockResolvedValue([]),
    saveMessage: vi.fn().mockResolvedValue(undefined),
    editMessage: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    clearChat: vi.fn().mockResolvedValue(undefined),
  } as any,
  file: {
    selectImage: vi.fn().mockResolvedValue(null),
    readImageAsBase64: vi.fn().mockResolvedValue(''),
  } as any,
  font: {
    selectFont: vi.fn().mockResolvedValue(null),
    saveFont: vi.fn().mockResolvedValue({ id: 'test-font', name: 'TestFont', fileName: 'test-font.ttf', format: 'ttf', size: 1024, createdAt: 0 }),
    listFonts: vi.fn().mockResolvedValue([]),
    deleteFont: vi.fn().mockResolvedValue(undefined),
    getFontPath: vi.fn().mockResolvedValue('file:///test-font.ttf'),
  } as any,
  regex: {
    list: vi.fn().mockResolvedValue([]),
  } as any,
  persona: {
    list: vi.fn().mockResolvedValue([]),
  } as any,
  usage: {
    record: vi.fn().mockResolvedValue({}),
    calculateCost: vi.fn().mockResolvedValue(0),
  } as any,
  app: {
    getVersion: vi.fn().mockResolvedValue('0.8.9'),
  } as any,
  announcement: {
    fetchList: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  } as any,
}

// 注入 mock 到 window.api（不覆盖 window 本身）
Object.defineProperty(window, 'api', {
  value: mockApi,
  writable: true,
  configurable: true,
})

// Mock matchMedia
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    value: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
    writable: true,
    configurable: true,
  })
}

// Mock nanoid
vi.mock('nanoid', () => ({
  nanoid: vi.fn().mockReturnValue('mock-id'),
}))
