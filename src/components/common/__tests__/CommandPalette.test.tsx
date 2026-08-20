import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandPalette } from '../CommandPalette'

describe('CommandPalette', () => {
  const scrollIntoView = vi.fn()

  beforeEach(() => {
    scrollIntoView.mockClear()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })
  })

  it('展示全部操作、斜杠指令和页面命令', () => {
    render(<MemoryRouter><CommandPalette open onClose={vi.fn()} /></MemoryRouter>)

    expect(screen.getAllByRole('option')).toHaveLength(33)
    expect(screen.getByRole('option', { name: /新建对话/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /\/clear/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /\/imagine/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /\/summary/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /前往：设置/ })).toBeTruthy()
  })

  it('方向键移动选择时把高亮命令滚入可视区', () => {
    render(<MemoryRouter><CommandPalette open onClose={vi.fn()} /></MemoryRouter>)
    scrollIntoView.mockClear()

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowUp' })

    expect(screen.getByRole('combobox').getAttribute('aria-activedescendant')).toBe('command-page-settings')
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })
})
