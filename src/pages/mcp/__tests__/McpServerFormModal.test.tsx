/**
 * McpServerFormModal 无障碍回归（P1-03：改用通用 Modal 后键盘/ARIA 可用）
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { McpServerFormModal } from '../McpServerFormModal'
import { EMPTY_FORM } from '../mcpTypes'

function renderModal(props: Partial<Parameters<typeof McpServerFormModal>[0]> = {}) {
  return render(
    <McpServerFormModal
      editingId={null}
      form={EMPTY_FORM}
      setForm={vi.fn()}
      onSave={vi.fn()}
      onClose={vi.fn()}
      {...props}
    />,
  )
}

describe('McpServerFormModal（P1-03 通用弹窗）', () => {
  it('以 dialog 语义渲染，标题随编辑状态变化且表单可被标签定位', () => {
    renderModal()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByText('添加 Server')).toBeInTheDocument()
    expect(screen.getByLabelText('名称')).toBeInTheDocument()
    expect(screen.getByLabelText('命令 (command)')).toBeInTheDocument()
  })

  it('编辑态标题为编辑 Server', () => {
    renderModal({ editingId: 'm1' })
    expect(screen.getByText('编辑 Server')).toBeInTheDocument()
  })

  it('Esc 关闭弹窗', () => {
    const onClose = vi.fn()
    renderModal({ onClose })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('名称为空时保存禁用；填写后点击保存回调', () => {
    const onSave = vi.fn()
    const { rerender } = renderModal({ onSave })
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()

    rerender(
      <McpServerFormModal
        editingId={null}
        form={{ ...EMPTY_FORM, name: 'filesystem' }}
        setForm={vi.fn()}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(onSave).toHaveBeenCalledTimes(1)
  })
})
