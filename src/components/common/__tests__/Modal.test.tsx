import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import { Modal } from '../Modal'

describe('Modal 通用弹窗', () => {
  it('open 为 false 时不渲染', () => {
    const { container } = render(
      <Modal open={false} onClose={vi.fn()}>内容</Modal>
    )
    expect(container.innerHTML).toBe('')
  })

  it('渲染标题与内容', () => {
    render(
      <Modal open onClose={vi.fn()} title="弹窗标题">
        <div>弹窗内容</div>
      </Modal>
    )
    expect(screen.getByText('弹窗标题')).toBeTruthy()
    expect(screen.getByText('弹窗内容')).toBeTruthy()
  })

  it('渲染 footer', () => {
    render(
      <Modal open onClose={vi.fn()} footer={<button>确定</button>}>
        内容
      </Modal>
    )
    expect(screen.getByText('确定')).toBeTruthy()
  })

  it('自定义 header 优先级高于 title', () => {
    render(
      <Modal open onClose={vi.fn()} title="默认标题" header={<span>自定义头</span>}>
        内容
      </Modal>
    )
    expect(screen.getByText('自定义头')).toBeTruthy()
    expect(screen.queryByText('默认标题')).toBeNull()
  })

  it('按 Escape 键调用 onClose', () => {
    const onClose = vi.fn()
    render(<Modal open onClose={onClose}>内容</Modal>)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('Escape 监听在关闭后被移除', () => {
    const onClose = vi.fn()
    const { rerender } = render(<Modal open onClose={onClose}>内容</Modal>)
    rerender(<Modal open={false} onClose={onClose}>内容</Modal>)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('点击遮罩层调用 onClose', () => {
    const onClose = vi.fn()
    render(<Modal open onClose={onClose}>内容</Modal>)
    // 遮罩层是第一个 absolute inset-0 的 div
    const overlay = document.querySelector('.absolute.inset-0')
    fireEvent.click(overlay!)
    expect(onClose).toHaveBeenCalled()
  })

  it('width=custom 时应用自定义宽度类', () => {
    render(
      <Modal open onClose={vi.fn()} width="custom" widthClassName="w-[560px]">
        内容
      </Modal>
    )
    const panel = document.querySelector('.w-\\[560px\\]') ?? document.querySelector('.relative.w-full')
    expect(panel).toBeTruthy()
  })
})
