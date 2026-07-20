import { useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useSettingsStore } from './store/useSettingsStore'
import { useCharacterStore } from './store/useCharacterStore'
import { MainLayout } from './components/layout/MainLayout'
import { ChatPage } from './pages/ChatPage'
import { CharactersPage } from './pages/CharactersPage'
import { SettingsPage } from './pages/SettingsPage'
import { LorebookPage } from './pages/LorebookPage'
import { PresetsPage } from './pages/PresetsPage'
import { GroupChatPage } from './pages/GroupChatPage'
import { ApiPage } from './pages/ApiPage'
import { HelpPage } from './pages/HelpPage'
import { RegexPage } from './pages/RegexPage'
import { PersonasPage } from './pages/PersonasPage'

export default function App() {
  const { settings, loadSettings } = useSettingsStore()
  const { loadCharacters } = useCharacterStore()

  // 初始化加载
  useEffect(() => {
    loadSettings()
    loadCharacters()
  }, [loadSettings, loadCharacters])

  // 应用主题
  useEffect(() => {
    const root = document.documentElement
    // 深色/浅色
    root.classList.remove('dark', 'light')
    if (settings.theme === 'system') {
      const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
      root.classList.add(dark ? 'dark' : 'light')
    } else {
      root.classList.add(settings.theme)
    }
    // 主题色
    root.classList.remove('theme-amber', 'theme-emerald', 'theme-ocean', 'theme-rose', 'theme-purple', 'theme-cyan')
    root.classList.add(`theme-${settings.themeColor}`)
    // 字体大小
    root.classList.remove('font-compact', 'font-comfortable', 'font-loose')
    if (settings.fontSize === 'custom') {
      root.style.setProperty('--font-size-base', `${settings.fontSizeCustom || 16}px`)
    } else {
      root.style.removeProperty('--font-size-base')
      root.classList.add(`font-${settings.fontSize}`)
    }
  }, [settings.theme, settings.themeColor, settings.fontSize, settings.fontSizeCustom])

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
        <Route path="help" element={<HelpPage />} />
      </Route>
    </Routes>
  )
}
