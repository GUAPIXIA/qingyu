import '@testing-library/jest-dom/vitest'
import { vi, afterEach } from 'vitest'
import { act } from '@testing-library/react'
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
    onComplete: vi.fn().mockReturnValue(() => {}),
    onError: vi.fn().mockReturnValue(() => {}),
    onUsage: vi.fn().mockReturnValue(() => {}),
    countTokens: vi.fn().mockResolvedValue(0),
    countMessagesTokens: vi.fn().mockResolvedValue([]),
    compressLorebook: vi.fn().mockResolvedValue(''),
    localizeLorebookKeywords: vi.fn().mockResolvedValue({ suggestions: [] }),
    // W1：用量档案回读默认无样本（预算退回静态档案）；需要时由测试覆盖
    getGenerationUsageProfile: vi.fn().mockResolvedValue(null),
    getGenerationDiagnostics: vi.fn().mockResolvedValue({
      modelProfile: { outputLimit: 32768, contextLimit: 32768, reasoningMode: 'shared-unknown', source: 'fallback', confidence: 'low' },
      gateProbe: null, usageBuckets: [], lastRequest: null,
      observationStore: { loaded: true, keys: 0, scannedRecords: 0, skippedLines: 0 },
    }),
    resetGenerationGateProbe: vi.fn().mockResolvedValue(undefined),
  } as any,
  character: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    exportPng: vi.fn().mockResolvedValue(undefined),
    exportJson: vi.fn().mockResolvedValue(undefined),
    exportCover: vi.fn().mockResolvedValue({ ok: true }),
  } as any,
  chat: {
    listSessions: vi.fn().mockResolvedValue([]),
    createSession: vi.fn().mockResolvedValue({ id: 'test-session', characterId: 'test-char', title: 'Test' }),
    listMessages: vi.fn().mockResolvedValue([]),
    saveMessage: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    updateSession: vi.fn().mockResolvedValue(undefined),
    updateSessionIfMemoryVersion: vi.fn().mockResolvedValue({ applied: true, currentVersion: 1 }),
    renameSession: vi.fn().mockResolvedValue(undefined),
    toggleMemory: vi.fn().mockResolvedValue(undefined),
    setMemoryMode: vi.fn().mockResolvedValue(undefined),
    clearChat: vi.fn().mockResolvedValue(undefined),
    exportChat: vi.fn().mockResolvedValue(''),
    getStats: vi.fn().mockResolvedValue(null),
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
    updateSession: vi.fn().mockResolvedValue(undefined),
    updateSessionIfMemoryVersion: vi.fn().mockResolvedValue({ applied: true, currentVersion: 1 }),
  } as any,
  file: {
    selectImage: vi.fn().mockResolvedValue(null),
    readImageAsBase64: vi.fn().mockResolvedValue(''),
  } as any,
  imageGen: {
    generate: vi.fn().mockResolvedValue({ success: false, error: 'not mocked' }),
    testConnection: vi.fn().mockResolvedValue({ success: false, error: 'not mocked' }),
    listLocalComfyWorkflows: vi.fn().mockResolvedValue({ success: true, workflows: [] }),
    importLocalComfyWorkflow: vi.fn().mockResolvedValue({ success: false, canceled: true }),
    analyzeComfyWorkflow: vi.fn().mockResolvedValue({ success: false, error: 'not mocked' }),
    fetchObjectInfo: vi.fn().mockResolvedValue({ success: false, error: 'not mocked' }),
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
  quickReply: {
    listAll: vi.fn().mockResolvedValue([]),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  } as any,
  persona: {
    list: vi.fn().mockResolvedValue([]),
  } as any,
  usage: {
    record: vi.fn().mockResolvedValue({}),
  } as any,
  app: {
    getVersion: vi.fn().mockResolvedValue('0.8.9'),
    checkVersion: vi.fn().mockResolvedValue(null),
    openExternal: vi.fn().mockResolvedValue(undefined),
  } as any,
  localModel: {
    catalog: vi.fn().mockResolvedValue([]),
    installed: vi.fn().mockResolvedValue([]),
    tasks: vi.fn().mockResolvedValue([]),
    install: vi.fn().mockResolvedValue({ taskId: 'test-task' }),
    importPackage: vi.fn().mockResolvedValue(null),
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    test: vi.fn().mockResolvedValue({ ok: true, dimensions: 384 }),
    activate: vi.fn().mockResolvedValue({ ok: true }),
    rollback: vi.fn().mockResolvedValue({ ok: false }),
    uninstallImpact: vi.fn().mockResolvedValue({ active: false, modelBytes: 0, indexBytes: 0, lorebookCount: 0, entryCount: 0 }),
    uninstall: vi.fn().mockResolvedValue({ taskId: 'test-task' }),
    storageUsage: vi.fn().mockResolvedValue({ modelBytes: 0, indexBytes: 0, stagingBytes: 0, totalBytes: 0 }),
    cleanup: vi.fn().mockResolvedValue({ ok: true, freedBytes: 0 }),
    rebuildIndexes: vi.fn().mockResolvedValue({ taskId: 'index-task' }),
    onProgress: vi.fn().mockReturnValue(() => {}),
  } as any,
  announcement: {
    fetchList: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  } as any,
  updater: {
    check: vi.fn().mockResolvedValue({ status: 'none', message: '已是最新版本' }),
    download: vi.fn().mockResolvedValue({ status: 'error', message: '' }),
    install: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockResolvedValue({ status: 'idle', message: '' }),
    onEvent: vi.fn().mockReturnValue(() => {}),
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

// Mock nanoid：自增序列，避免固定值导致同测试内多条消息/会话 ID 冲突
// （冲突会触发生产代码的 ID 冲突告警，淹没真实告警；需要固定值时用例自行 mockReturnValueOnce）
vi.mock('nanoid', () => {
  let counter = 0
  return { nanoid: vi.fn(() => `mock-id-${++counter}`) }
})

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

afterEach(async () => {
  // 冲刷挂起的微任务（promise.then 中的 setState），避免测试结束后的 act 警告
  // 多轮冲刷：深层 promise 链（如发送消息的多次 await）可能跨多轮微任务
  for (let i = 0; i < 5; i++) {
    await act(async () => {})
  }
  clearCollectedLogs()
  if (unhandledErrors.length > 0) {
    const count = unhandledErrors.length
    const errors = unhandledErrors.join('\n  ')
    unhandledErrors.length = 0
    throw new Error(`测试期间发生 ${count} 个未捕获错误:\n  ${errors}`)
  }
})
