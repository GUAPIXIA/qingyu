import { describe, it, expect, beforeEach } from 'vitest'
import { render, fireEvent, waitFor, act } from '@testing-library/react'
import { ConfirmHost } from '../ConfirmHost'
import { confirm, useConfirmStore } from '../../../store/useConfirmStore'

describe('ConfirmHost（UEX-P1-04 全局确认通道）', () => {
  beforeEach(() => {
    useConfirmStore.setState({ pending: null })
  })

  it('点击确认时 confirm() resolve true 并关闭', async () => {
    const { getByText, queryByText } = render(<ConfirmHost />)
    let confirmed: boolean | null = null
    await act(async () => {
      void confirm({ title: '清空对话', message: '将清空本会话对话与长记忆，不可撤销。' }).then((ok) => { confirmed = ok })
    })

    // 请求进入 pending 并渲染 ConfirmDialog
    expect(useConfirmStore.getState().pending).not.toBeNull()
    expect(getByText('清空对话')).toBeTruthy()
    expect(getByText(/不可撤销/)).toBeTruthy()

    await act(async () => { fireEvent.click(getByText('确认')) })
    await waitFor(() => expect(confirmed).toBe(true))
    expect(useConfirmStore.getState().pending).toBeNull()
    expect(queryByText('清空对话')).toBeNull()
  })

  it('点击取消时 confirm() resolve false', async () => {
    const { getByText } = render(<ConfirmHost />)
    let confirmed: boolean | null = null
    await act(async () => {
      void confirm({ title: '清空对话', message: '不可撤销' }).then((ok) => { confirmed = ok })
    })

    await act(async () => { fireEvent.click(getByText('取消')) })
    await waitFor(() => expect(confirmed).toBe(false))
    expect(useConfirmStore.getState().pending).toBeNull()
  })

  it('新请求顶替旧请求时旧 Promise 结清为 false（不悬挂）', async () => {
    render(<ConfirmHost />)
    let first: boolean | null = null
    let second: boolean | null = null
    await act(async () => {
      void confirm({ title: '旧请求', message: 'a' }).then((ok) => { first = ok })
      void confirm({ title: '新请求', message: 'b' }).then((ok) => { second = ok })
    })

    await waitFor(() => expect(first).toBe(false))
    expect(second).toBeNull()
    expect(useConfirmStore.getState().pending?.options.title).toBe('新请求')
  })
})
