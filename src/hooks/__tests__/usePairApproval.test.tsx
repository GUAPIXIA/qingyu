/**
 * usePairApproval hook 单元测试
 * UEX-P1-21：新增配对审批过期倒计时用例（倒计时展示 / 到期自动关闭且不提交 /
 * 剩余 <60s 警示 / 过期后拒绝提交）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, render, act, screen, fireEvent } from '@testing-library/react'

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
import { useToastStore } from '../../store/useToastStore'

/** UEX-P1-21：onPairRequest 载荷（expiresAt 为可选增量） */
interface PairPayload {
  requestId: string
  deviceName: string
  expiresAt?: number
}

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

// ===================== UEX-P1-21：配对审批过期倒计时 =====================

describe('usePairApproval 过期倒计时（UEX-P1-21）', () => {
  /** 固定基准时间（假时钟起点） */
  const BASE = new Date('2026-06-01T12:00:00').getTime()
  let callback: ((payload: PairPayload) => void) | undefined

  /** 宿主组件：让弹窗随 hook 状态实时重渲染，便于交互断言 */
  function PairHost() {
    return <>{usePairApproval()}</>
  }

  /** 模拟主进程下发一条配对请求 */
  function receive(expiresAt: number): void {
    act(() => {
      callback?.({ requestId: 'req-001', deviceName: '测试手机', expiresAt })
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    // 显式假化计时器与 Date：倒计时走秒与到期判定都以假时钟为准
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(BASE)
    useToastStore.getState().dismissAll()
    callback = undefined
    mockOnPairRequest.mockReturnValue(vi.fn())
    mockOnPairRequest.mockImplementation((cb: (payload: PairPayload) => void) => {
      callback = cb
      return vi.fn()
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('倒计时展示「剩余 mm:ss」并每秒更新', () => {
    render(<PairHost />)
    receive(BASE + 55_000)
    expect(screen.getByText('剩余 00:55')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(screen.getByText('剩余 00:54')).toBeInTheDocument()
  })

  it('到期自动关闭弹窗并提示「配对请求已过期」，且不提交审批', () => {
    render(<PairHost />)
    receive(BASE + 3_000)
    expect(screen.getByText('允许设备接入？')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(3_000)
    })

    // 弹窗自动关闭（不静默消失：附轻提示），且全程未提交审批
    expect(screen.queryByText('允许设备接入？')).toBeNull()
    expect(mockApprovePair).not.toHaveBeenCalled()
    expect(mockRejectPair).not.toHaveBeenCalled()
    const toasts = useToastStore.getState().toasts
    expect(toasts.some((t) => t.title === '配对请求已过期' && t.variant === 'warning')).toBe(true)
  })

  it('剩余 <60s 转 danger 色警示，≥60s 保持常规文案色', () => {
    render(<PairHost />)
    receive(BASE + 120_000)
    const normal = screen.getByText('剩余 02:00')
    expect(normal).not.toHaveClass('text-tavern-danger')

    act(() => {
      vi.advanceTimersByTime(61_000)
    })
    const warn = screen.getByText('剩余 00:59')
    expect(warn).toHaveClass('text-tavern-danger')
  })

  it('过期后拒绝提交：提交前校验拦截（允许/拒绝均不再发起）', () => {
    render(<PairHost />)

    // 1) 过期后点「允许接入」被拦截（仅拨快系统时间，模拟到期瞬间的竞态）
    receive(BASE + 5_000)
    vi.setSystemTime(BASE + 6_000)
    fireEvent.click(screen.getByRole('button', { name: '允许接入' }))
    expect(mockApprovePair).not.toHaveBeenCalled()
    expect(screen.queryByText('允许设备接入？')).toBeNull()
    expect(
      useToastStore.getState().toasts.some((t) => t.title === '配对请求已过期' && t.variant === 'error'),
    ).toBe(true)

    // 2) 过期后点「拒绝」同样被拦截
    receive(BASE + 8_000)
    vi.setSystemTime(BASE + 9_000)
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    expect(mockRejectPair).not.toHaveBeenCalled()
    expect(screen.queryByText('允许设备接入？')).toBeNull()
  })
})
