import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { getDefaultSettings } from '../../../../shared/defaults'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { WindowCaption } from '../WindowCaption'

type WindowState = { maximized: boolean; fullScreen: boolean }

function installWindowControls(platform: string, isMaximized = false) {
  const api = {
    platform,
    minimize: vi.fn().mockResolvedValue(undefined),
    toggleMaximize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    isMaximized: vi.fn().mockResolvedValue(isMaximized),
    onStateChanged: vi.fn().mockReturnValue(() => {}),
  }
  ;(window as unknown as { qingyuWindowControls?: typeof api }).qingyuWindowControls = api
  return api
}

describe('WindowCaption', () => {
  beforeEach(() => {
    delete (window as unknown as { qingyuWindowControls?: unknown }).qingyuWindowControls
    useSettingsStore.setState({
      settings: { ...getDefaultSettings(), theme: 'dark' },
      credentials: {},
      loaded: true,
      _saveTimer: null,
    })
  })

  afterEach(() => {
    delete (window as unknown as { qingyuWindowControls?: unknown }).qingyuWindowControls
  })

  it('没有窗口控制桥（浏览器/测试环境）时不渲染标题栏', () => {
    const { container } = render(<WindowCaption />)
    expect(container).toBeEmptyDOMElement()
  })

  it('非 Windows 平台不渲染（保留原生标题栏，避免双标题栏）', () => {
    installWindowControls('darwin')
    const { container } = render(<WindowCaption />)
    expect(container).toBeEmptyDOMElement()
  })

  it('Windows 下渲染标题栏，窗口按钮调用对应 IPC', () => {
    const api = installWindowControls('win32')
    render(<WindowCaption />)

    expect(screen.getByTestId('window-caption')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '最小化' }))
    fireEvent.click(screen.getByRole('button', { name: '最大化' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))

    expect(api.minimize).toHaveBeenCalledTimes(1)
    expect(api.toggleMaximize).toHaveBeenCalledTimes(1)
    expect(api.close).toHaveBeenCalledTimes(1)
    expect(api.isMaximized).toHaveBeenCalled()
  })

  it('最大化状态从 isMaximized 初始化，并随 window:state 广播切换「还原/最大化」', async () => {
    const api = installWindowControls('win32', true)
    let push: ((state: WindowState) => void) | null = null
    api.onStateChanged.mockImplementation((listener: (state: WindowState) => void) => {
      push = listener
      return () => {}
    })

    render(<WindowCaption />)
    await waitFor(() => expect(screen.getByRole('button', { name: '还原' })).toBeInTheDocument())

    act(() => push?.({ maximized: false, fullScreen: false }))
    await waitFor(() => expect(screen.getByRole('button', { name: '最大化' })).toBeInTheDocument())
  })

  it('全屏广播时隐藏标题栏', async () => {
    const api = installWindowControls('win32')
    let push: ((state: WindowState) => void) | null = null
    api.onStateChanged.mockImplementation((listener: (state: WindowState) => void) => {
      push = listener
      return () => {}
    })

    render(<WindowCaption />)
    expect(screen.getByTestId('window-caption')).toBeInTheDocument()

    act(() => push?.({ maximized: false, fullScreen: true }))
    await waitFor(() => expect(screen.queryByTestId('window-caption')).not.toBeInTheDocument())
  })

  it('主题按钮按解析后的主题切换，并写入设置 store', () => {
    installWindowControls('win32')
    render(<WindowCaption />)

    fireEvent.click(screen.getByRole('button', { name: '切换为浅色模式' }))
    expect(useSettingsStore.getState().settings.theme).toBe('light')

    fireEvent.click(screen.getByRole('button', { name: '切换为深色模式' }))
    expect(useSettingsStore.getState().settings.theme).toBe('dark')
  })
})
