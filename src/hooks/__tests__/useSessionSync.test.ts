/**
 * useSessionSync hook 单元测试
 *
 * 覆盖阶段 0c 会话同步 + F3 外部写入（角色/设置）推送。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const mockOnUpdated = vi.fn()
const mockOnCharactersChanged = vi.fn()
const mockOnSettingsChanged = vi.fn()
const mockUnbind = vi.fn()
const mockLoadCharacters = vi.fn(async () => {})
const mockLoadSettings = vi.fn(async () => {})
let settingsState: { settings: { activeCharacterId: string }; _dirty: boolean; loadSettings: typeof mockLoadSettings }

vi.mock('../../store/useSettingsStore', () => ({
  useSettingsStore: {
    getState: vi.fn(() => settingsState),
  },
}))

vi.mock('../../store/useCharacterStore', () => ({
  useCharacterStore: {
    getState: vi.fn(() => ({
      characters: [{ id: 'char-001', name: '测试角色' }],
      loadCharacters: mockLoadCharacters,
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
      onCharactersChanged: mockOnCharactersChanged.mockReturnValue(mockUnbind),
      onSettingsChanged: mockOnSettingsChanged.mockReturnValue(mockUnbind),
    },
  },
})

import { useSessionSync } from '../useSessionSync'

describe('useSessionSync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    settingsState = { settings: { activeCharacterId: 'char-001' }, _dirty: false, loadSettings: mockLoadSettings }
    mockOnUpdated.mockReturnValue(mockUnbind)
    mockOnCharactersChanged.mockReturnValue(mockUnbind)
    mockOnSettingsChanged.mockReturnValue(mockUnbind)
  })

  it('注册 session:updated 监听器', () => {
    renderHook(() => useSessionSync())
    expect(mockOnUpdated).toHaveBeenCalled()
  })

  it('卸载时取消监听', () => {
    const { unmount } = renderHook(() => useSessionSync())
    unmount()
    expect(mockUnbind).toHaveBeenCalledTimes(3)
  })

  it('收到事件时刷新会话列表', () => {
    let callback: ((payload: { sessionId: string; change: string }) => void) | undefined
    mockOnUpdated.mockImplementation((cb: (payload: { sessionId: string; change: string }) => void) => {
      callback = cb
      return mockUnbind
    })

    renderHook(() => useSessionSync())
    callback?.({ sessionId: 'session-001', change: 'message' })

    expect(mockLoadSessions).toHaveBeenCalledWith('char-001')
  })

  it('当前会话且非流式时刷新消息', () => {
    let callback: ((payload: { sessionId: string; change: string }) => void) | undefined
    mockOnUpdated.mockImplementation((cb: (payload: { sessionId: string; change: string }) => void) => {
      callback = cb
      return mockUnbind
    })

    renderHook(() => useSessionSync())
    callback?.({ sessionId: 'session-001', change: 'message' })

    expect(mockLoadMessages).toHaveBeenCalled()
  })

  // F3：外部 IPC 写入角色 → 界面重新拉取角色列表（无需重启）
  it('收到角色变更广播时重新加载角色列表', () => {
    let callback: (() => void) | undefined
    mockOnCharactersChanged.mockImplementation((cb: () => void) => {
      callback = cb
      return mockUnbind
    })

    renderHook(() => useSessionSync())
    callback?.()

    expect(mockLoadCharacters).toHaveBeenCalledTimes(1)
  })

  // F3 + F1：外部写入设置 → 本地无未保存改动时重载
  it('收到设置变更广播且本地无改动时重新加载设置', () => {
    let callback: (() => void) | undefined
    mockOnSettingsChanged.mockImplementation((cb: () => void) => {
      callback = cb
      return mockUnbind
    })

    renderHook(() => useSessionSync())
    callback?.()

    expect(mockLoadSettings).toHaveBeenCalledTimes(1)
  })

  it('本地有未保存改动时不重载设置（避免覆盖用户编辑）', () => {
    let callback: (() => void) | undefined
    mockOnSettingsChanged.mockImplementation((cb: () => void) => {
      callback = cb
      return mockUnbind
    })
    settingsState._dirty = true

    renderHook(() => useSessionSync())
    callback?.()

    expect(mockLoadSettings).not.toHaveBeenCalled()
  })
})
