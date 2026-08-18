/**
 * useSessionSync hook 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const mockOnUpdated = vi.fn()
const mockUnbind = vi.fn()

vi.mock('../../store/useSettingsStore', () => ({
  useSettingsStore: {
    getState: vi.fn(() => ({
      settings: { activeCharacterId: 'char-001' },
    })),
  },
}))

vi.mock('../../store/useCharacterStore', () => ({
  useCharacterStore: {
    getState: vi.fn(() => ({
      characters: [{ id: 'char-001', name: '测试角色' }],
    })),
  },
}))

const mockLoadSessions = vi.fn(async () => {})
const mockLoadMessages = vi.fn(async () => {})

vi.mock('../../store/useChatStore', () => ({
  useChatStore: {
    getState: vi.fn(() => ({
      currentSessionId: 'session-001',
      isStreaming: false,
      loadSessions: mockLoadSessions,
      loadMessages: mockLoadMessages,
    })),
  },
}))

vi.mock('../../lib/logger', () => ({
  logError: vi.fn(),
}))

// 模拟 window.api
Object.defineProperty(window, 'api', {
  value: {
    sessionSync: {
      onUpdated: mockOnUpdated.mockReturnValue(mockUnbind),
    },
  },
})

import { useSessionSync } from '../useSessionSync'

describe('useSessionSync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockOnUpdated.mockReturnValue(mockUnbind)
  })

  it('注册 session:updated 监听器', () => {
    renderHook(() => useSessionSync())
    expect(mockOnUpdated).toHaveBeenCalled()
  })

  it('卸载时取消监听', () => {
    const { unmount } = renderHook(() => useSessionSync())
    unmount()
    expect(mockUnbind).toHaveBeenCalled()
  })

  it('收到事件时刷新会话列表', () => {
    // 捕获回调
    let callback: Function
    mockOnUpdated.mockImplementation((cb: Function) => {
      callback = cb
      return mockUnbind
    })

    renderHook(() => useSessionSync())

    // 模拟收到事件
    callback!({ sessionId: 'session-001', change: 'message' })

    expect(mockLoadSessions).toHaveBeenCalledWith('char-001')
  })

  it('当前会话且非流式时刷新消息', () => {
    let callback: Function
    mockOnUpdated.mockImplementation((cb: Function) => {
      callback = cb
      return mockUnbind
    })

    renderHook(() => useSessionSync())

    // 模拟当前会话的事件
    callback!({ sessionId: 'session-001', change: 'message' })

    expect(mockLoadMessages).toHaveBeenCalled()
  })
})
