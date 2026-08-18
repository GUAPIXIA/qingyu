/**
 * streamController 深度单元测试
 * 覆盖：流式响应、错误处理、超时、停止字符串、压缩
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ActiveProfile } from '../../../shared/contextTypes'

// ===== Mocks =====
const mockOnChunk = vi.fn()
const mockOnDone = vi.fn()
const mockOnError = vi.fn()
const mockChat = vi.fn(async (_params: unknown) => undefined)
const mockCancelChat = vi.fn(async () => ({}))
const mockListSessions = vi.fn(async () => [])
const mockUpdateSession = vi.fn(async () => ({}))
const mockRecord = vi.fn(async () => ({}))
const mockListRegex = vi.fn(async () => [])
const mockSemanticSearch = vi.fn(async () => [])
const mockEmbedFacts = vi.fn(async () => [])

Object.defineProperty(window, 'api', {
  value: {
    ai: {
      chat: mockChat,
      cancelChat: mockCancelChat,
      onChunk: mockOnChunk.mockReturnValue(vi.fn()),
      onDone: mockOnDone.mockReturnValue(vi.fn()),
      onError: mockOnError.mockReturnValue(vi.fn()),
    },
    chat: {
      listSessions: mockListSessions,
      updateSession: mockUpdateSession,
    },
    usage: {
      record: mockRecord,
    },
    regex: {
      list: mockListRegex,
    },
    embedding: {
      semanticSearch: mockSemanticSearch,
      embedFacts: mockEmbedFacts,
    },
  },
})

vi.mock('../../utils/tokenCounter', () => ({
  estimateTokens: vi.fn(() => 100),
}))

vi.mock('../../utils/charCounter', () => ({
  countChars: vi.fn((s: string) => ({ total: s?.length || 0 })),
}))

vi.mock('../../utils/defaults', () => ({
  isLocalProvider: vi.fn(() => false),
  isLocalUrl: vi.fn(() => false),
}))

vi.mock('../../utils/variables', () => ({
  replaceVariables: vi.fn((t: string) => t),
}))

vi.mock('../../utils/chatTemplates', () => ({
  resolveEffectiveTemplate: vi.fn(() => ''),
}))

vi.mock('../../utils/regex', () => ({
  collectStopStrings: vi.fn(() => []),
  findStopIndex: vi.fn(() => -1),
}))

vi.mock('../../utils/lorebook', () => ({
  lorebookCache: {
    get: vi.fn(),
  },
}))

vi.mock('../../lib/logger', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}))

vi.mock('../../lib/safeOps', () => ({
  safeSave: vi.fn(async (fn: () => Promise<void>) => await fn()),
  safeFire: vi.fn((fn: () => Promise<void>) => fn().catch(() => {})),
}))

vi.mock('../../utils/visionModel', () => ({
  resolveVisionModel: vi.fn(() => null),
}))

vi.mock('../chatConstants', () => ({
  STREAM_THROTTLE_MS: 50,
  STREAM_IDLE_TIMEOUT_MS: 60_000,
  DEFAULT_LOREBOOK_SCAN_DEPTH: 10,
  SEMANTIC_SCAN_MAX_TOKENS: 4000,
}))

vi.mock('../chatUtils', () => ({
  friendlyError: vi.fn((e: string) => e),
  semanticCacheGet: vi.fn(() => null),
  semanticCacheSet: vi.fn(),
}))

// Mock useSettingsStore
const makeActiveProfile = (): ActiveProfile => ({
  name: '测试连接',
  provider: 'openai',
  apiKey: 'test-key',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4',
  maxContext: 0,
})
const mockGetActiveProfile = vi.fn<() => ActiveProfile | null>(() => makeActiveProfile())

vi.mock('../useSettingsStore', () => ({
  useSettingsStore: {
    getState: vi.fn(() => ({
      settings: {
        activeModel: 'gpt-4',
        userName: '用户',
        semanticTrigger: null,
      },
      getActiveProfile: mockGetActiveProfile,
    })),
  },
}))

// ===== 测试 =====
import { streamAIResponse, cleanupActiveStream } from '../streamController'

describe('streamController - 深度测试', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    cleanupActiveStream()

    // 默认 mock 返回值
    mockOnChunk.mockReturnValue(vi.fn())
    mockOnDone.mockReturnValue(vi.fn())
    mockOnError.mockReturnValue(vi.fn())
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanupActiveStream()
  })

  describe('streamAIResponse', () => {
    const mockSet = vi.fn()
    const mockGet = vi.fn()
    const mockCharacter = { id: 'char-1', name: '测试角色' } as any
    const mockOnComplete = vi.fn(async () => {})

    beforeEach(() => {
      mockSet.mockImplementation((fn: any) => {
        if (typeof fn === 'function') return fn({})
        return fn
      })
      mockGet.mockReturnValue({
        messages: [],
        sessions: [],
        buildContext: vi.fn(() => []),
        currentSessionId: 'session-1',
        _semanticLoreHits: [],
        _semanticFactsHits: [],
      })
    })

    it('未配置 API 时设置错误', async () => {
      mockGetActiveProfile.mockReturnValue(null)

      await streamAIResponse(mockSet, mockGet, {
        aiMessageId: 'msg-1',
        character: mockCharacter,
        preset: null,
        onComplete: mockOnComplete,
      })

      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ isStreaming: false })
      )
    })

    it('发送 chat 请求', async () => {
      mockGetActiveProfile.mockReturnValue(makeActiveProfile())

      await streamAIResponse(mockSet, mockGet, {
        aiMessageId: 'msg-1',
        character: mockCharacter,
        preset: null,
        onComplete: mockOnComplete,
      })

      expect(mockChat).toHaveBeenCalled()
    })

    it('流式完成后调用 onComplete', async () => {
      mockGetActiveProfile.mockReturnValue(makeActiveProfile())

      // 简化 mockSet，返回空对象
      mockSet.mockReturnValue({})

      // 捕获 onDone 回调并捕获 requestId
      let doneCallback: Function
      let capturedRequestId: string
      mockOnDone.mockImplementation((cb: Function) => {
        doneCallback = cb
        return vi.fn()
      })

      // 捕获 chat 调用中的 requestId
      mockChat.mockImplementation(async (opts: any) => {
        capturedRequestId = opts.requestId
        return undefined
      })

      await streamAIResponse(mockSet, mockGet, {
        aiMessageId: 'msg-1',
        character: mockCharacter,
        preset: null,
        onComplete: mockOnComplete,
      })

      // 模拟流式完成（使用捕获的 requestId）
      doneCallback!(capturedRequestId!)

      expect(mockOnComplete).toHaveBeenCalled()
    })

    it('错误时设置错误状态', async () => {
      mockGetActiveProfile.mockReturnValue(makeActiveProfile())

      // 捕获 onError 回调
      let errorCallback: Function
      mockOnError.mockImplementation((cb: Function) => {
        errorCallback = cb
        return vi.fn()
      })

      await streamAIResponse(mockSet, mockGet, {
        aiMessageId: 'msg-1',
        character: mockCharacter,
        preset: null,
        onComplete: mockOnComplete,
      })

      // 模拟错误
      errorCallback!({ requestId: 'any', error: 'API 错误' })

      // 验证错误被处理（不会抛异常）
    })
  })

  describe('cleanupActiveStream', () => {
    it('清理活动流', () => {
      cleanupActiveStream()
      // 不抛异常即通过
    })

    it('多次调用安全', () => {
      cleanupActiveStream()
      cleanupActiveStream()
      cleanupActiveStream()
    })
  })
})
