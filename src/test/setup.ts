import '@testing-library/jest-dom/vitest'
import { vi, afterEach } from 'vitest'
import { clearCollectedLogs } from '../lib/logger'
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
  } as any,
  app: {
    getVersion: vi.fn().mockResolvedValue('0.8.9'),
  } as any,
  announcement: {
    fetchList: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  } as any,
  log: {
    write: vi.fn().mockResolvedValue(undefined),
    getRecent: vi.fn().mockResolvedValue(''),
  } as any,
}

// 注入 mock 到 window.api（不覆盖 window 本身）
// 环境守卫：server 测试（node 环境）无 window，跳过 DOM 相关 mock
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'api', {
    value: mockApi,
    writable: true,
    configurable: true,
  })
}

// Mock matchMedia（仅 DOM 环境）
if (typeof window !== 'undefined' && !window.matchMedia) {
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

// ---- 全局错误捕获（测试环境终端输出）----
// 未捕获的错误会在此收集，afterEach 时检查并使测试失败
// （仅 DOM 环境注册，server 测试使用 node 环境）

const unhandledErrors: string[] = []

if (typeof window !== 'undefined') {
  window.addEventListener('error', (e: ErrorEvent) => {
    const msg = e.error instanceof Error
      ? `${e.error.message}\n${e.error.stack ?? ''}`
      : e.message
    console.error('\n━━━ 未捕获异常 ━━━')
    console.error(msg)
    console.error('━━━━━━━━━━━━━━━\n')
    unhandledErrors.push(msg)
  })

  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    const reason = e.reason instanceof Error
      ? `${e.reason.message}\n${e.reason.stack ?? ''}`
      : String(e.reason)
    console.error('\n━━━ 未处理 Promise rejection ━━━')
    console.error(reason)
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
    unhandledErrors.push(`[unhandled rejection] ${reason}`)
  })
}

afterEach(() => {
  clearCollectedLogs()
  if (unhandledErrors.length > 0) {
    const count = unhandledErrors.length
    const errors = unhandledErrors.join('\n  ')
    unhandledErrors.length = 0
    throw new Error(`测试期间发生 ${count} 个未捕获错误:\n  ${errors}`)
  }
})
