import type { BrowserWindow, IpcMain } from 'electron'

/**
 * 自定义标题栏（无边框窗口）的窗口控制 IPC（2026-10-21）。
 *
 * 背景：`main.ts` 在 Windows 上以 `titleBarStyle: 'hidden'` 创建主窗口，
 * 原生最小化/最大化/关闭按钮被隐藏，改由渲染层 `TitleBar` 自绘按钮，
 * 因此需要这里的最小 IPC 通道把操作转发给 BrowserWindow。
 *
 * 通道刻意不放进 shared 子模块的 ipc-channels/ipc-api：
 * 那是跨端契约（独立仓），而窗口控制是 PC 桌面独有能力，
 * 渲染层通过 preload 暴露的 `window.qingyuWindowControls` 访问。
 */
export const WINDOW_CONTROL_CHANNELS = {
  minimize: 'window:minimize',
  toggleMaximize: 'window:toggle-maximize',
  close: 'window:close',
  isMaximized: 'window:is-maximized',
  /** 主进程 → 渲染进程：窗口最大化/全屏状态广播 */
  state: 'window:state',
} as const

export interface WindowControlState {
  maximized: boolean
  fullScreen: boolean
}

export function registerWindowControlsIPC(ipcMain: IpcMain, getWindow: () => BrowserWindow | null): void {
  const win = () => {
    const target = getWindow()
    return target && !target.isDestroyed() ? target : null
  }

  ipcMain.handle(WINDOW_CONTROL_CHANNELS.minimize, () => {
    win()?.minimize()
  })

  ipcMain.handle(WINDOW_CONTROL_CHANNELS.toggleMaximize, () => {
    const target = win()
    if (!target) return
    if (target.isMaximized()) target.unmaximize()
    else target.maximize()
  })

  ipcMain.handle(WINDOW_CONTROL_CHANNELS.close, () => {
    win()?.close()
  })

  ipcMain.handle(WINDOW_CONTROL_CHANNELS.isMaximized, () => {
    const target = win()
    if (!target) return false
    return target.isMaximized()
  })
}

/**
 * 把窗口的最大化/全屏状态广播给渲染进程（标题栏据此切换「最大化/还原」图标）。
 * 在窗口创建后立即调用；`did-finish-load` 时补发一次初始状态，避免首屏图标闪烁。
 */
export function attachWindowStateBroadcast(win: BrowserWindow): void {
  const send = () => {
    if (win.isDestroyed()) return
    const state: WindowControlState = { maximized: win.isMaximized(), fullScreen: win.isFullScreen() }
    win.webContents.send(WINDOW_CONTROL_CHANNELS.state, state)
  }
  win.on('maximize', send)
  win.on('unmaximize', send)
  win.on('enter-full-screen', send)
  win.on('leave-full-screen', send)
  win.webContents.on('did-finish-load', send)
}
