/**
 * SessionSwitcher 单元测试（UEX-P1-32 重命名语义 / UEX-P1-33 会话搜索与排序）
 */
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SessionSwitcher } from '../SessionSwitcher'

function makeSessions(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `s${i + 1}`,
    title: `会话${i + 1}`,
    messageCount: 0,
  }))
}

/** UEX-P1-33：故意乱序的会话（验证排序不改默认顺序、按名称重排） */
function makeSortSessions() {
  return [
    { id: 'a1', title: '晚风', messageCount: 0 },
    { id: 'a2', title: 'Apple', messageCount: 0 },
    { id: 'a3', title: '长安', messageCount: 0 },
    { id: 'a4', title: 'banana', messageCount: 0 },
    { id: 'a5', title: '晨雾', messageCount: 0 },
    { id: 'a6', title: '北京', messageCount: 0 },
  ]
}

/** 读取下拉中会话条目标题（按 DOM 顺序），去掉条数后缀 */
function readListedTitles(container: HTMLElement) {
  return Array.from(container.querySelectorAll('button.flex-1.text-left')).map((b) =>
    (b.textContent ?? '').replace(/\(.*\)$/, '').trim(),
  )
}

describe('SessionSwitcher', () => {
  it('UEX-P1-32：chat 分支重命名失焦 = 提交保存', () => {
    const onRename = vi.fn()
    render(
      <SessionSwitcher
        sessions={makeSessions(3)}
        currentSessionId="s1"
        onSwitch={vi.fn()}
        onRename={onRename}
        onDelete={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTitle('切换对话'))
    fireEvent.click(screen.getAllByTitle('重命名')[0])
    const input = screen.getByDisplayValue('会话1')
    fireEvent.change(input, { target: { value: '新标题' } })
    fireEvent.blur(input)

    expect(onRename).toHaveBeenCalledTimes(1)
    expect(onRename).toHaveBeenCalledWith('s1', '新标题')
  })

  it('UEX-P1-32：group 分支回车提交、Esc 取消（与 chat 分支语义一致）', () => {
    const onRename = vi.fn()
    const { unmount } = render(
      <SessionSwitcher
        variant="group"
        sessions={makeSessions(3)}
        currentSessionId="s1"
        onSwitch={vi.fn()}
        onRename={onRename}
        onDelete={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '会话1' }))
    fireEvent.click(screen.getAllByTitle('重命名')[1])
    const input = screen.getByDisplayValue('会话2')
    fireEvent.change(input, { target: { value: '改名' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    // Esc 取消：不提交，也不再显示输入框
    expect(onRename).not.toHaveBeenCalled()
    expect(screen.queryByDisplayValue('改名')).not.toBeInTheDocument()
    unmount()

    render(
      <SessionSwitcher
        variant="group"
        sessions={makeSessions(3)}
        currentSessionId="s1"
        onSwitch={vi.fn()}
        onRename={onRename}
        onDelete={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '会话1' }))
    fireEvent.click(screen.getAllByTitle('重命名')[1])
    const input2 = screen.getByDisplayValue('会话2')
    fireEvent.change(input2, { target: { value: '回车改名' } })
    fireEvent.keyDown(input2, { key: 'Enter' })

    expect(onRename).toHaveBeenCalledTimes(1)
    expect(onRename).toHaveBeenCalledWith('s2', '回车改名')
  })

  it('UEX-P1-33：会话超过 5 条显示搜索框并按标题过滤', () => {
    render(
      <SessionSwitcher
        sessions={makeSessions(6)}
        currentSessionId="s1"
        onSwitch={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTitle('切换对话'))
    const search = screen.getByPlaceholderText('搜索会话...')
    fireEvent.change(search, { target: { value: '会话3' } })

    expect(screen.getByText('会话3')).toBeInTheDocument()
    expect(screen.queryByText('会话5')).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'zzz' } })
    expect(screen.getByText('无匹配会话')).toBeInTheDocument()
    expect(screen.queryByText('会话3')).not.toBeInTheDocument()
  })

  it('UEX-P1-33：会话不超过 5 条不显示搜索框', () => {
    render(
      <SessionSwitcher
        sessions={makeSessions(5)}
        currentSessionId="s1"
        onSwitch={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTitle('切换对话'))
    expect(screen.queryByPlaceholderText('搜索会话...')).not.toBeInTheDocument()
  })

  it('UEX-P1-33：默认「最近使用」保持传入顺序（不重排）', () => {
    const sessions = makeSortSessions()
    const { container } = render(
      <SessionSwitcher
        sessions={sessions}
        currentSessionId="a1"
        onSwitch={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTitle('切换对话'))

    expect(readListedTitles(container)).toEqual(sessions.map((s) => s.title))
  })

  it('UEX-P1-33：切换「名称」按 localeCompare(zh) 排序，切回「最近使用」恢复', () => {
    const sessions = makeSortSessions()
    const nameOrder = sessions.map((s) => s.title).sort((a, b) => a.localeCompare(b, 'zh'))
    const { container } = render(
      <SessionSwitcher
        sessions={sessions}
        currentSessionId="a1"
        onSwitch={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTitle('切换对话'))
    fireEvent.click(screen.getByRole('button', { name: '名称' }))

    expect(readListedTitles(container)).toEqual(nameOrder)
    // 排序仅前端内存态：不改动传入列表顺序（不落盘）
    expect(sessions.map((s) => s.id)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6'])

    fireEvent.click(screen.getByRole('button', { name: '最近使用' }))
    expect(readListedTitles(container)).toEqual(sessions.map((s) => s.title))
  })

  it('UEX-P1-33：群聊 variant 同样接入排序切换', () => {
    const sessions = makeSortSessions()
    const nameOrder = sessions.map((s) => s.title).sort((a, b) => a.localeCompare(b, 'zh'))
    const { container } = render(
      <SessionSwitcher
        variant="group"
        sessions={sessions}
        currentSessionId="a1"
        onSwitch={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '晚风' }))
    fireEvent.click(screen.getByRole('button', { name: '名称' }))

    expect(readListedTitles(container)).toEqual(nameOrder)
  })
})
