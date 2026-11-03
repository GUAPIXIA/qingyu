import { useEffect, useState } from 'react'
import { Copy, Minus, Moon, Square, Sun, X } from 'lucide-react'
import { getWindowControls } from '../../lib/windowControls'
import { useSettingsStore } from '../../store/useSettingsStore'

/**
 * 无边框窗口的自绘顶部标题栏（30px）。
 *
 * 主进程在 Windows 上以 `titleBarStyle: 'hidden'` 隐藏原生标题栏与窗口按钮，
 * 改由本组件绘制：左侧仅品牌图标，右侧「主题切换 + 最小化 + 最大化/还原 + 关闭」。
 * 浏览器 / 测试 / 非 Windows 环境没有窗口桥（或平台不匹配），组件直接不渲染，
 * 不会出现"假窗口按钮"。
 *
 * 注意：
 * - 拖动区由 CSS `.app-caption` 的 `-webkit-app-region: drag` 提供，按钮容器为 no-drag；
 * - 主题切换落到 useSettingsStore（'system' 模式按系统解析结果换算）；
 * - 全屏时隐藏标题栏，保持沉浸内容。
 */
export function WindowCaption() {
  const [api] = useState(() => getWindowControls())
  const [maximized, setMaximized] = useState(false)
  const [fullScreen, setFullScreen] = useState(false)
  const theme = useSettingsStore((s) => s.settings.theme)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const [systemDark, setSystemDark] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true,
  )

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setSystemDark(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  // 初始状态 + 后续广播：最大化/还原图标与全屏隐藏都靠这里
  useEffect(() => {
    if (!api) return
    let alive = true
    api.isMaximized()
      .then((value) => {
        if (alive) setMaximized(value)
      })
      .catch(() => {})
    const unsubscribe = api.onStateChanged((state) => {
      if (!alive) return
      setMaximized(state.maximized)
      setFullScreen(state.fullScreen)
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [api])

  if (!api || api.platform !== 'win32' || fullScreen) return null

  const isDark = theme === 'system' ? systemDark : theme === 'dark'
  const themeLabel = isDark ? '切换为浅色模式' : '切换为深色模式'

  return (
    <div className="app-caption" data-testid="window-caption" aria-label="窗口标题栏">
      <div className="app-caption__brand" aria-label="轻语">
        <span className="app-caption__mark" aria-hidden="true">
          {/* 品牌图标：与 work/frameless-window-preview.html 的 i-brand 一致 */}
          <svg viewBox="0 0 24 24">
            <path d="M19.5 13.5a7.5 7.5 0 0 1-10.9 6.7L4 22l1.8-4.6A7.5 7.5 0 1 1 19.5 13.5z" />
            <path d="M9 10.5c1.8-2.2 4.2-2.2 6 0M9 14.5c1.8 1.2 4.2 1.2 6 0" />
          </svg>
        </span>
      </div>

      <div className="app-caption__controls">
        <button
          type="button"
          className="app-caption__button"
          aria-label={themeLabel}
          title={themeLabel}
          onClick={() => updateSettings({ theme: isDark ? 'light' : 'dark' })}
        >
          {isDark ? <Sun /> : <Moon />}
        </button>
        <button
          type="button"
          className="app-caption__button"
          aria-label="最小化"
          title="最小化"
          onClick={() => void api.minimize()}
        >
          <Minus />
        </button>
        <button
          type="button"
          className="app-caption__button"
          aria-label={maximized ? '还原' : '最大化'}
          title={maximized ? '还原' : '最大化'}
          onClick={() => void api.toggleMaximize()}
        >
          {maximized ? <Copy /> : <Square />}
        </button>
        <button
          type="button"
          className="app-caption__button app-caption__button--close"
          aria-label="关闭"
          title="关闭"
          onClick={() => void api.close()}
        >
          <X />
        </button>
      </div>
    </div>
  )
}
