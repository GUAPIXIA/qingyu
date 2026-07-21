import { useState, useEffect } from 'react'
import { NavLink } from 'react-router-dom'
import { useUIStore } from '../../store/useUIStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { cn } from '../../lib/utils'
import {
  MessageSquare,
  Users,
  Settings,
  Plug,
  BookOpen,
  Sliders,
  UsersRound,
  HelpCircle,
  PanelLeftClose,
  PanelLeft,
  Regex as RegexIcon,
  UserCircle,
  BarChart3,
  Wrench,
  Megaphone,
  ExternalLink,
} from 'lucide-react'
import { PROVIDER_INFO } from '../../utils/defaults'

const navItems = [
  { to: '/chat', label: '对话', icon: MessageSquare },
  { to: '/characters', label: '角色卡', icon: Users },
  { to: '/personas', label: '身份', icon: UserCircle },
  { to: '/group', label: '群聊', icon: UsersRound },
  { to: '/lorebook', label: '世界书', icon: BookOpen },
  { to: '/presets', label: '预设', icon: Sliders },
  { to: '/regex', label: '正则', icon: RegexIcon },
  { to: '/api', label: 'API', icon: Plug },
  { to: '/usage', label: '用量', icon: BarChart3 },
  { to: '/mcp', label: 'MCP', icon: Wrench },
  { to: '/settings', label: '设置', icon: Settings },
  { to: '/announcements', label: '公告', icon: Megaphone },
  { to: '/help', label: '帮助', icon: HelpCircle },
]

export function Sidebar() {
  const { sidebarCollapsed, toggleSidebar } = useUIStore()
  const { settings, getActiveProfile } = useSettingsStore()

  const activeProfile = getActiveProfile()
  const isConnected = activeProfile !== null && (activeProfile.provider === 'ollama' || !!activeProfile.apiKey)

  const [appVersion, setAppVersion] = useState('')
  const [serverVersion, setServerVersion] = useState<string | null>(null)
  const [downloadUrl, setDownloadUrl] = useState('')
  const GITHUB_URL = 'https://github.com/GUAPIXIA/qingyu'

  /** 简单 semver 比较：返回 true 表示 remote > local */
  function isNewerVersion(local: string, remote: string): boolean {
    const toNums = (v: string) => v.replace(/^v/, '').split('.').map(Number)
    const l = toNums(local)
    const r = toNums(remote)
    for (let i = 0; i < 3; i++) {
      if ((r[i] || 0) > (l[i] || 0)) return true
      if ((r[i] || 0) < (l[i] || 0)) return false
    }
    return false
  }

  // 服务器版本与本地不同时才显示
  const showServerVersion = serverVersion !== null && serverVersion !== appVersion
  const hasUpdate = serverVersion !== null && appVersion && isNewerVersion(appVersion, serverVersion)

  // 获取本地版本 + 在线版本检查
  useEffect(() => {
    window.api.app.getVersion().then(v => setAppVersion(v)).catch(() => {})
    window.api.app.checkVersion().then(info => {
      if (info?.version) {
        setServerVersion(info.version)
        setDownloadUrl(info.downloadUrl || GITHUB_URL + '/releases')
      }
    }).catch(() => {})
  }, [])

  const handleOpenDownload = () => {
    const url = downloadUrl || GITHUB_URL + '/releases'
    window.api.app.openExternal(url).catch(() => {})
  }

  const handleOpenGithub = () => {
    window.api.app.openExternal(GITHUB_URL).catch(() => {})
  }

  return (
    <aside
      className={cn(
        'flex flex-col bg-tavern-bg-soft border-r border-tavern-border-soft transition-all duration-300',
        sidebarCollapsed ? 'w-16' : 'w-56'
      )}
    >
      {/* 应用品牌 + 版本号 */}
      <div
        className={cn(
          'h-14 border-b border-tavern-border-soft flex items-center overflow-hidden shrink-0',
          sidebarCollapsed ? 'justify-center px-1' : 'px-4'
        )}
      >
        {sidebarCollapsed ? (
          <span className="text-lg font-medium text-black">轻</span>
        ) : (
          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xl leading-tight font-medium text-black">轻语</span>
              <span className="text-[10px] leading-none text-black/30">B站:超级本大王</span>
            </div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <button
                onClick={hasUpdate ? handleOpenDownload : undefined}
                className={cn(
                  'flex items-center gap-1 text-[10px] leading-none transition-colors',
                  hasUpdate
                    ? 'text-tavern-accent hover:opacity-80 cursor-pointer'
                    : 'text-black/60'
                )}
                title={hasUpdate ? `新版本 v${serverVersion} 可用，点击下载` : undefined}
              >
                v{appVersion || '...'}
                {hasUpdate && (
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                )}
              </button>
              {showServerVersion && (
                <span className="text-[10px] text-black/40 leading-none">
                  → v{serverVersion}
                </span>
              )}
              <button
                onClick={handleOpenGithub}
                className="flex items-center gap-0.5 text-[10px] text-black/40 hover:text-tavern-accent transition-colors leading-none"
                title="前往 GitHub 主页"
              >
                <ExternalLink className="w-2.5 h-2.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 导航 */}
      <nav className="flex-1 py-3 px-2 space-y-1">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                sidebarCollapsed && 'justify-center',
                isActive
                  ? 'bg-tavern-accent-soft text-tavern-accent'
                  : 'text-tavern-text-soft hover:text-tavern-text hover:bg-tavern-bg-hover'
              )
            }
            title={sidebarCollapsed ? item.label : undefined}
          >
            <item.icon className="w-5 h-5 shrink-0" />
            {!sidebarCollapsed && <span>{item.label}</span>}
          </NavLink>
        ))}
      </nav>

      {/* 底部状态 */}
      <div className="p-2 border-t border-tavern-border-soft">
        {!sidebarCollapsed && (
          <div className="px-3 py-2 rounded-lg bg-tavern-bg-card mb-2">
            <div className="flex items-center gap-2 text-xs">
              <span
                className={cn(
                  'w-2 h-2 rounded-full',
                  isConnected ? 'bg-tavern-success animate-pulse-soft' : 'bg-tavern-danger'
                )}
              />
              <span className="text-tavern-text-soft truncate">
                {isConnected && activeProfile
                  ? activeProfile.model || '未选模型'
                  : '未连接'}
              </span>
            </div>
            <div className="text-xs text-tavern-text-muted mt-1 truncate">
              {isConnected && activeProfile ? activeProfile.name || activeProfile.model || '—' : '—'}
            </div>
          </div>
        )}
        <button
          onClick={toggleSidebar}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover transition-colors"
          title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
        >
          {sidebarCollapsed ? (
            <PanelLeft className="w-4 h-4" />
          ) : (
            <>
              <PanelLeftClose className="w-4 h-4" />
              <span className="text-xs">收起</span>
            </>
          )}
        </button>
      </div>
    </aside>
  )
}
