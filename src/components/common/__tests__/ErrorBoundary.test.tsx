import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import { ErrorBoundary } from '../ErrorBoundary'

function Bomb(): never {
  throw new Error('渲染爆炸')
}

/**
 * setup.ts 注册了 window error 监听器并在 afterEach 时将未捕获错误判为失败。
 * 错误边界捕获的错误会经 jsdom 冒泡到 window error 事件，因此在本套件中
 * 用捕获阶段的拦截器阻止其到达全局监听器（仅本套件生效）。
 */
let stopErrorCapture: ((e: Event) => void) | null = null

beforeEach(() => {
  stopErrorCapture = (e: Event) => e.stopImmediatePropagation()
  window.addEventListener('error', stopErrorCapture, true)
})

afterEach(() => {
  if (stopErrorCapture) {
    window.removeEventListener('error', stopErrorCapture, true)
    stopErrorCapture = null
  }
})

describe('ErrorBoundary 错误边界', () => {
  it('正常渲染子组件', () => {
    render(
      <ErrorBoundary>
        <div>正常内容</div>
      </ErrorBoundary>
    )
    expect(screen.getByText('正常内容')).toBeTruthy()
  })

  it('子组件抛错时显示错误 UI', () => {
    // 抑制 React 错误边界日志输出
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>
    )
    expect(screen.getByText('页面渲染异常')).toBeTruthy()
    expect(screen.getByText('渲染爆炸')).toBeTruthy()
    spy.mockRestore()
  })

  it('提供 fallback 时使用 fallback', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ErrorBoundary fallback={<div>自定义降级</div>}>
        <Bomb />
      </ErrorBoundary>
    )
    expect(screen.getByText('自定义降级')).toBeTruthy()
    expect(screen.queryByText('页面渲染异常')).toBeNull()
    spy.mockRestore()
  })

  it('点击重试按钮后恢复正常渲染', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { rerender } = render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>
    )
    expect(screen.getByText('页面渲染异常')).toBeTruthy()

    // 重试后子组件不再抛错
    rerender(
      <ErrorBoundary>
        <div>恢复后的内容</div>
      </ErrorBoundary>
    )
    // 点击重试重置状态
    fireEvent.click(screen.getByText('重试'))
    expect(screen.getByText('恢复后的内容')).toBeTruthy()
    spy.mockRestore()
  })
})
