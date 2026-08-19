/**
 * usePairApproval hook 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const mockOnPairRequest = vi.fn()
const mockApprovePair = vi.fn(async () => ({ ok: true }))
const mockRejectPair = vi.fn(async () => ({}))

Object.defineProperty(window, 'api', {
  value: {
    bridge: {
      onPairRequest: mockOnPairRequest.mockReturnValue(vi.fn()),
      approvePair: mockApprovePair,
      rejectPair: mockRejectPair,
    },
  },
})

import { usePairApproval } from '../usePairApproval'

describe('usePairApproval', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockOnPairRequest.mockReturnValue(vi.fn())
  })

  it('无待审批请求时返回 null', () => {
    const { result } = renderHook(() => usePairApproval())
    expect(result.current).toBeNull()
  })

  it('注册 onPairRequest 监听器', () => {
    renderHook(() => usePairApproval())
    expect(mockOnPairRequest).toHaveBeenCalled()
  })

  it('收到请求时显示审批弹窗', () => {
    let callback: ((payload: { requestId: string; deviceName: string }) => void) | undefined
    mockOnPairRequest.mockImplementation((cb: (payload: { requestId: string; deviceName: string }) => void) => {
      callback = cb
      return vi.fn()
    })

    const { result } = renderHook(() => usePairApproval())

    // 模拟收到配对请求
    act(() => {
      callback?.({ requestId: 'req-001', deviceName: '测试手机' })
    })

    // 应返回 JSX 元素
    expect(result.current).not.toBeNull()
  })
})
