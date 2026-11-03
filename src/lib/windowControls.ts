/**
 * 自绘标题栏（无边框窗口）的渲染层访问入口（2026-10-21）。
 *
 * 主进程在 Windows 上用 `titleBarStyle: 'hidden'` 隐藏原生最小化/最大化/关闭按钮，
 * preload 暴露 `window.qingyuWindowControls`；浏览器预览或非桌面壳环境没有该对象，
 * `getWindowControls()` 返回 null，TitleBar 直接不渲染（也不会在普通浏览器里出现假按钮）。
 *
 * 注意：该类型与 `electron/preload.ts` 中的 `windowControlsApi` 保持一致
 * （有意不放进 shared 子模块的 ExposedAPI —— 那是跨端契约，窗口控制属 PC 桌面独有）。
 */
export interface WindowControlState {
  maximized: boolean
  fullScreen: boolean
}

export interface WindowControlsAPI {
  /** 运行平台（来自 preload 的 process.platform） */
  platform: string
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<void>
  close: () => Promise<void>
  isMaximized: () => Promise<boolean>
  /** 订阅最大化/全屏状态变化；返回取消订阅函数 */
  onStateChanged: (listener: (state: WindowControlState) => void) => () => void
}

declare global {
  interface Window {
    qingyuWindowControls?: WindowControlsAPI
  }
}

export function getWindowControls(): WindowControlsAPI | null {
  if (typeof window === 'undefined') return null
  return window.qingyuWindowControls ?? null
}
