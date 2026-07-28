import { useEffect } from 'react'
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { useSettingsStore } from './store/useSettingsStore'
import { useCharacterStore } from './store/useCharacterStore'
import { logError } from './lib/logger'
import { MainLayout } from './components/layout/MainLayout'
import { ChatPage } from './pages/ChatPage'
import { CharactersPage } from './pages/CharactersPage'
import { SettingsPage } from './pages/SettingsPage'
import { LorebookPage } from './pages/LorebookPage'
import { GroupChatPage } from './pages/GroupChatPage'
import { ApiPage } from './pages/ApiPage'
import { HelpPage } from './pages/HelpPage'
import { RegexPage } from './pages/RegexPage'
import { PersonasPage } from './pages/PersonasPage'
import { PresetsPage } from './pages/PresetsPage'
import { UsagePage } from './pages/UsagePage'
import { McpPage } from './pages/McpPage'
import { AnnouncementsPage } from './pages/AnnouncementsPage'

export default function App() {
  const navigate = useNavigate()
  const { settings, loadSettings } = useSettingsStore()
  const { loadCharacters } = useCharacterStore()

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
        // 触发新建对话事件
        window.dispatchEvent(new CustomEvent('shortcut:new-chat'))
      }
      // Ctrl+E: 导出对话
      if (e.ctrlKey && e.key === 'e') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('shortcut:export-chat'))
      }
      // Ctrl+/: 打开命令面板
      if (e.ctrlKey && e.key === '/') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('shortcut:command-palette'))
      }
      // Ctrl+Shift+C: 复制最后一条 AI 回复
      if (e.ctrlKey && e.shiftKey && e.key === 'C') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('shortcut:copy-last-ai'))
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [navigate])

  return (
    <Routes>
      <Route path="/" element={<MainLayout />}>
        <Route index element={<Navigate to="/chat" replace />} />
        <Route path="chat" element={<ChatPage />} />
        <Route path="api" element={<ApiPage />} />
        <Route path="characters" element={<CharactersPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="lorebook" element={<LorebookPage />} />
        <Route path="presets" element={<PresetsPage />} />
        <Route path="group" element={<GroupChatPage />} />
        <Route path="regex" element={<RegexPage />} />
        <Route path="personas" element={<PersonasPage />} />
        <Route path="usage" element={<UsagePage />} />
        <Route path="mcp" element={<McpPage />} />
        <Route path="announcements" element={<AnnouncementsPage />} />
        <Route path="help" element={<HelpPage />} />
      </Route>
    </Routes>
  )
}
