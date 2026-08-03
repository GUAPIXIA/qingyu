import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import { Dropdown } from '../Dropdown'

describe('Dropdown 通用下拉', () => {
  it('open 为 false 时不渲染面板', () => {
    render(
      <Dropdown open={false} onOpenChange={vi.fn()} trigger={<button>触发</button>}>
        <div>面板内容</div>
      </Dropdown>
    )
    expect(screen.getByText('触发')).toBeTruthy()
    expect(screen.queryByText('面板内容')).toBeNull()
  })

  it('open 为 true 时渲染触发器与面板', () => {
    render(
      <Dropdown open onOpenChange={vi.fn()} trigger={<button>触发</button>}>
        <div>面板内容</div>
      </Dropdown>
    )
    expect(screen.getByText('面板内容')).toBeTruthy()
  })

  it('点击触发器切换 open 状态', () => {
    const onOpenChange = vi.fn()
    render(
      <Dropdown open={false} onOpenChange={onOpenChange} trigger={<button>触发</button>}>
        内容
      </Dropdown>
    )
    fireEvent.click(screen.getByText('触发'))
    expect(onOpenChange).toHaveBeenCalledWith(true)
  })

  it('按 Escape 关闭', () => {
    const onOpenChange = vi.fn()
    render(
      <Dropdown open onOpenChange={onOpenChange} trigger={<button>触发</button>}>
        内容
      </Dropdown>
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('点击遮罩层关闭', () => {
    const onOpenChange = vi.fn()
    render(
      <Dropdown open onOpenChange={onOpenChange} trigger={<button>触发</button>}>
        内容
      </Dropdown>
    )
    const overlay = document.querySelector('.fixed.inset-0.z-20')
    fireEvent.click(overlay!)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('align=right 时面板应用 right-0', () => {
    render(
      <Dropdown open onOpenChange={vi.fn()} trigger={<button>触发</button>} align="right">
        内容
      </Dropdown>
    )
    const panel = document.querySelector('.absolute.top-full')
    expect(panel?.className).toContain('right-0')
  })

  it('align 默认 left', () => {
    render(
      <Dropdown open onOpenChange={vi.fn()} trigger={<button>触发</button>}>
        内容
      </Dropdown>
    )
    const panel = document.querySelector('.absolute.top-full')
    expect(panel?.className).toContain('left-0')
  })

  it('closeOnContentClick 为 false 时点击面板内容不关闭', () => {
    const onOpenChange = vi.fn()
    render(
      <Dropdown open onOpenChange={onOpenChange} trigger={<button>触发</button>}>
        <div>面板内容</div>
      </Dropdown>
    )
    // 面板内点击会 stopPropagation，不触发关闭
    fireEvent.click(screen.getByText('面板内容'))
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})
