import { lazy, Suspense, useEffect, useState, type ComponentType } from 'react'
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { useSettingsStore } from './store/useSettingsStore'
import { useCharacterStore } from './store/useCharacterStore'
import { useChatStore } from './store/useChatStore'
import { useGroupChatStore } from './store/useGroupChatStore'
import { useSessionSync } from './hooks/useSessionSync'
import { usePairApproval } from './hooks/usePairApproval'
import { BUILTIN_FONTS } from './utils/defaults'
import { logError } from './lib/logger'
import { ErrorBoundary } from './components/common/ErrorBoundary'
import { MainLayout } from './components/layout/MainLayout'
import { ChatPage } from './pages/ChatPage'
import { CommandPalette } from './components/common/CommandPalette'
// 优化：非首屏页面路由懒加载（拆包，减小初始 bundle；
// ChatPage 为默认路由保持静态导入）
function lazyPage(importer: () => Promise<Record<string, unknown>>, name: string) {
  return lazy(async () => ({ default: (await importer())[name] as ComponentType }))
}
const CharactersPage = lazyPage(() => import('./pages/CharactersPage'), 'CharactersPage')
const CharacterCreatePage = lazyPage(() => import('./pages/CharacterCreatePage'), 'CharacterCreatePage')
const SettingsPage = lazyPage(() => import('./pages/SettingsPage'), 'SettingsPage')
const LorebookPage = lazyPage(() => import('./pages/LorebookPage'), 'LorebookPage')
const GroupChatPage = lazyPage(() => import('./pages/GroupChatPage'), 'GroupChatPage')
const ApiPage = lazyPage(() => import('./pages/ApiPage'), 'ApiPage')
const HelpPage = lazyPage(() => import('./pages/HelpPage'), 'HelpPage')
const RegexPage = lazyPage(() => import('./pages/RegexPage'), 'RegexPage')
const QuickRepliesPage = lazyPage(() => import('./pages/QuickRepliesPage'), 'QuickRepliesPage')
const PersonasPage = lazyPage(() => import('./pages/PersonasPage'), 'PersonasPage')
const PresetsPage = lazyPage(() => import('./pages/PresetsPage'), 'PresetsPage')
const UsagePage = lazyPage(() => import('./pages/UsagePage'), 'UsagePage')
const McpPage = lazyPage(() => import('./pages/McpPage'), 'McpPage')
const AnnouncementsPage = lazyPage(() => import('./pages/AnnouncementsPage'), 'AnnouncementsPage')

export default function App() {
  const navigate = useNavigate()
  const { settings, loadSettings } = useSettingsStore()
  const { loadCharacters } = useCharacterStore()
  const [paletteOpen, setPaletteOpen] = useState(false)

  // 阶段 0c：会话变更事件总线订阅（PC 双窗口同步；桥接层 WS 转推在阶段一接线）
  useSessionSync()
  // 阶段一：配对审批弹窗（PC 端人工确认，方案 §5.1）——返回值必须渲染，否则弹窗不显示
  const pairApproval = usePairApproval()

  // 初始化加载
  useEffect(() => {
    loadSettings()
    loadCharacters()
  }, [loadSettings, loadCharacters])

  // 应用退出前立即刷新待保存的设置（绕过 300ms 防抖）
  useEffect(() => {
    const handleBeforeUnload = () => {
      useSettingsStore.getState().flushSettings()
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [])

  // L-03 修复：应用主题 + 监听系统主题变化
  useEffect(() => {
    const root = document.documentElement
    const mq = window.matchMedia('(prefers-color-scheme: dark)')

    const applyTheme = () => {
      root.classList.remove('dark', 'light')
      if (settings.theme === 'system') {
        root.classList.add(mq.matches ? 'dark' : 'light')
      } else {
        root.classList.add(settings.theme)
      }
    }

    applyTheme()

    // system 模式下监听系统主题变化
    if (settings.theme === 'system') {
      const handler = () => applyTheme()
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    }
  }, [settings.theme])

  // 主题色 + 字体大小（独立 effect，避免频繁切换时重新注册 listener）
  useEffect(() => {
    const root = document.documentElement
    root.classList.remove('theme-amber', 'theme-emerald', 'theme-ocean', 'theme-rose', 'theme-purple', 'theme-cyan')
    root.classList.add(`theme-${settings.themeColor}`)
    root.classList.remove('font-compact', 'font-comfortable', 'font-loose')
    if (settings.fontSize === 'custom') {
      root.style.setProperty('--font-size-base', `${settings.fontSizeCustom || 16}px`)
      root.style.fontSize = `${settings.fontSizeCustom || 16}px`
    } else {
      root.style.removeProperty('--font-size-base')
      root.style.fontSize = ''
      root.classList.add(`font-${settings.fontSize}`)
    }
  }, [settings.themeColor, settings.fontSize, settings.fontSizeCustom])

  // 字体族应用 + 自定义字体 @font-face 注入（font-display: swap 避免加载卡顿）
  useEffect(() => {
    const applyFont = async () => {
      const fontFamily = settings.fontFamily ?? 'system'
      const customFontId = settings.customFontId ?? null

      let styleEl = document.getElementById('custom-fonts') as HTMLStyleElement | null

      // 内置字体
      const builtin = BUILTIN_FONTS.find(f => f.value === fontFamily)
      if (builtin) {
        document.body.style.fontFamily = builtin.family
        // 清理自定义字体样式
        if (styleEl) {
          styleEl.textContent = ''
        }
        return
      }

      // 自定义字体
      if (customFontId) {
        try {
          const fontPath = await window.api.font.getFontPath(customFontId)
          if (!fontPath) {
            // 字体文件不存在，回退系统默认
            document.body.style.fontFamily = BUILTIN_FONTS[0].family
            return
          }
          // 注入 @font-face（font-display: swap：加载前用系统字体，加载后切换）
          if (!styleEl) {
            styleEl = document.createElement('style')
            styleEl.id = 'custom-fonts'
            document.head.appendChild(styleEl)
          }
          styleEl.textContent = `@font-face { font-family: "${fontFamily}"; src: url("${fontPath}"); font-display: swap; }`
          document.body.style.fontFamily = `"${fontFamily}", sans-serif`
        } catch (e) {
          logError('App:applyCustomFont', e)
          document.body.style.fontFamily = BUILTIN_FONTS[0].family
        }
      } else {
        document.body.style.fontFamily = BUILTIN_FONTS[0].family
      }
    }
    applyFont()
  }, [settings.fontFamily, settings.customFontId])

  // 全局错误兜底：捕获未处理的 Promise rejection 和渲染进程异常
  useEffect(() => {
    const handleUnhandledRejection = (e: PromiseRejectionEvent) => {
      logError('App:unhandledRejection', e.reason)
      e.preventDefault()
    }
    const handleError = (e: ErrorEvent) => {
      logError('App:uncaughtError', e.error ?? e.message)
      e.preventDefault()
    }
    window.addEventListener('unhandledrejection', handleUnhandledRejection)
    window.addEventListener('error', handleError)
    return () => {
      window.removeEventListener('unhandledrejection', handleUnhandledRejection)
      window.removeEventListener('error', handleError)
    }
  }, [])

  // 全局键盘快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+N: 新建对话
      if (e.ctrlKey && e.key === 'n') {
        e.preventDefault()
        navigate('/chat')
        // 延迟派发：跨页面时等待 ChatPage 挂载并注册监听器
        setTimeout(() => window.dispatchEvent(new CustomEvent('shortcut:new-chat')), 60)
      }
      // Ctrl+E: 导出对话
      if (e.ctrlKey && e.key === 'e') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('shortcut:export-chat'))
      }
      // Ctrl+/: 打开命令面板
      if (e.ctrlKey && e.key === '/') {
        e.preventDefault()
        setPaletteOpen(true)
      }
      // Ctrl+Shift+C: 复制最后一条 AI 回复
      if (e.ctrlKey && e.shiftKey && e.key === 'C') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('shortcut:copy-last-ai'))
      }
      // Esc: 停止生成（存在弹层遮罩时交给弹层处理——优先关闭弹窗）
      if (e.key === 'Escape' && !document.querySelector('.fixed.inset-0')) {
        if (useChatStore.getState().isStreaming) {
          useChatStore.getState().stopStreaming()
        }
        if (useGroupChatStore.getState().isStreaming) {
          useGroupChatStore.getState().stopStreaming()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [navigate])

  return (
    <>
      {pairApproval}
      <Routes>
      <Route path="/" element={<MainLayout />}>
        <Route index element={<Navigate to="/chat" replace />} />
        <Route path="chat" element={<ChatPage />} />
        <Route path="api" element={<ErrorBoundary><Suspense fallback={null}><ApiPage /></Suspense></ErrorBoundary>} />
        <Route path="characters" element={<ErrorBoundary><Suspense fallback={null}><CharactersPage /></Suspense></ErrorBoundary>} />
        <Route path="character-create" element={<ErrorBoundary><Suspense fallback={null}><CharacterCreatePage /></Suspense></ErrorBoundary>} />
        <Route path="settings" element={<ErrorBoundary><Suspense fallback={null}><SettingsPage /></Suspense></ErrorBoundary>} />
        <Route path="lorebook" element={<ErrorBoundary><Suspense fallback={null}><LorebookPage /></Suspense></ErrorBoundary>} />
        <Route path="presets" element={<ErrorBoundary><Suspense fallback={null}><PresetsPage /></Suspense></ErrorBoundary>} />
        <Route path="group" element={<ErrorBoundary><Suspense fallback={null}><GroupChatPage /></Suspense></ErrorBoundary>} />
        <Route path="regex" element={<ErrorBoundary><Suspense fallback={null}><RegexPage /></Suspense></ErrorBoundary>} />
        <Route path="quick-replies" element={<ErrorBoundary><Suspense fallback={null}><QuickRepliesPage /></Suspense></ErrorBoundary>} />
        <Route path="personas" element={<ErrorBoundary><Suspense fallback={null}><PersonasPage /></Suspense></ErrorBoundary>} />
        <Route path="usage" element={<ErrorBoundary><Suspense fallback={null}><UsagePage /></Suspense></ErrorBoundary>} />
        <Route path="mcp" element={<ErrorBoundary><Suspense fallback={null}><McpPage /></Suspense></ErrorBoundary>} />
        <Route path="announcements" element={<ErrorBoundary><Suspense fallback={null}><AnnouncementsPage /></Suspense></ErrorBoundary>} />
        <Route path="help" element={<ErrorBoundary><Suspense fallback={null}><HelpPage /></Suspense></ErrorBoundary>} />
      </Route>
      </Routes>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </>
  )
}
