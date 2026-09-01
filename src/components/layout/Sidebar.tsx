import { useState, useEffect } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useUIStore } from '../../store/useUIStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { cn } from '../../lib/utils'
import { logError } from '../../lib/logger'
import { isConnectionConfigured } from '../../utils/defaults'
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
  Zap,
  UserCircle,
  BarChart3,
  Wrench,
  Megaphone,
  ChevronDown,
} from 'lucide-react'

// S2-A 导航分组：核心/资源/服务/系统，默认仅核心展开，保证 900×600 下核心入口无需滚动
const navGroups = [
  {
    id: 'core', label: '核心', defaultOpen: true, items: [
      { to: '/chat', label: '对话', icon: MessageSquare },
      { to: '/characters', label: '角色卡', icon: Users },
      { to: '/group', label: '群聊', icon: UsersRound },
    ]
  },
  {
    id: 'resource', label: '资源', defaultOpen: false, items: [
      { to: '/personas', label: '身份', icon: UserCircle },
      { to: '/lorebook', label: '世界书', icon: BookOpen },
      { to: '/presets', label: '预设', icon: Sliders },
      { to: '/regex', label: '正则', icon: RegexIcon },
      { to: '/quick-replies', label: '快捷回复', icon: Zap },
    ]
  },
  {
    id: 'service', label: '服务', defaultOpen: false, items: [
      { to: '/api', label: '模型', icon: Plug },
      { to: '/mcp', label: 'MCP', icon: Wrench },
    ]
  },
  {
    id: 'system', label: '系统', defaultOpen: false, items: [
      { to: '/usage', label: '用量', icon: BarChart3 },
      { to: '/settings', label: '设置', icon: Settings },
      { to: '/announcements', label: '公告', icon: Megaphone },
      { to: '/help', label: '帮助', icon: HelpCircle },
    ]
  },
]
const navItems = navGroups.flatMap(g => g.items)

export function Sidebar() {
  const { sidebarCollapsed, toggleSidebar } = useUIStore()
  const settings = useSettingsStore((s) => s.settings)
  const getActiveProfile = useSettingsStore((s) => s.getActiveProfile)
  const { pathname } = useLocation()
  const navigate = useNavigate()
  // S2-A：分组折叠状态（localStorage 持久化）
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem('sidebar-groups-collapsed')
      if (raw) return JSON.parse(raw) as Record<string, boolean>
    } catch { /* ignore */ }
    const init: Record<string, boolean> = {}
    for (const g of navGroups) init[g.id] = !g.defaultOpen
    return init
  })
  const toggleGroup = (id: string) => {
    setCollapsedGroups(prev => {
      const next = { ...prev, [id]: !prev[id] }
      try { localStorage.setItem('sidebar-groups-collapsed', JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }

  // 路由切换时展开当前页面所在分组，避免当前项被折叠隐藏。
  useEffect(() => {
    const activeGroup = navGroups.find((group) => group.items.some((item) => pathname.startsWith(item.to)))
    if (!activeGroup) return
    setCollapsedGroups((prev) => {
      if (!prev[activeGroup.id]) return prev
      const next = { ...prev, [activeGroup.id]: false }
      try { localStorage.setItem('sidebar-groups-collapsed', JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }, [pathname])

  const activeProfile = getActiveProfile()
  const isConnected = isConnectionConfigured(activeProfile)

  const [appVersion, setAppVersion] = useState('')
  const [serverVersion, setServerVersion] = useState<string | null>(null)

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
    window.api.app.getVersion().then(v => setAppVersion(v)).catch((e) => logError('Sidebar:getVersion', e))
    window.api.app.checkVersion().then(info => {
      if (info?.version) {
        setServerVersion(info.version)
      }
    }).catch((e) => logError('Sidebar:checkVersion', e))
  }, [])

  const handleOpenUpdater = () => navigate('/settings#settings-updater')

  return (
    <aside
      className={cn(
        'flex flex-col bg-tavern-bg-soft/95 border-r border-tavern-border-soft transition-all duration-300',
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
          <span className="text-lg font-medium text-tavern-text">轻</span>
        ) : (
          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xl leading-tight font-medium text-tavern-text">轻语</span>
              <span className="text-[10px] leading-none text-tavern-text-muted/50">B站:超级本大王</span>
            </div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <button
                onClick={handleOpenUpdater}
                className={cn(
                  'flex items-center gap-1 text-[10px] leading-none transition-colors',
                  hasUpdate
                    ? 'text-tavern-accent hover:opacity-80 cursor-pointer'
                    : 'text-tavern-text-muted hover:text-tavern-accent'
                )}
                title={hasUpdate ? `公告版本 v${serverVersion} 可用，前往软件更新` : '前往软件更新'}
              >
                v{appVersion || '...'}
                {hasUpdate && (
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                )}
              </button>
              {showServerVersion && (
                <span className="text-[10px] text-tavern-text-muted/60 leading-none">
                  → v{serverVersion}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 导航 - S2-A 分组 */}
      <nav className="flex-1 overflow-y-auto py-2.5 px-2.5 space-y-1.5">
        {sidebarCollapsed ? (
          // 收起态：平铺图标，无分组
          <div className="space-y-0.5">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                aria-label={item.label}
                className={({ isActive }) =>
                  cn(
                    "relative flex items-center justify-center h-10 rounded-xl transition-all duration-150 after:content-['']",
                    isActive
                      ? 'bg-tavern-bg-card text-tavern-accent shadow-sm ring-1 ring-tavern-border-soft after:absolute after:left-0 after:top-2.5 after:bottom-2.5 after:w-0.5 after:rounded-full after:bg-tavern-accent'
                      : 'text-tavern-text-muted hover:text-tavern-text-soft hover:bg-tavern-bg-hover/70'
                  )
                }
                title={item.label}
              >
                {({ isActive }) => (
                  <span className={cn(
                    'grid h-8 w-8 place-items-center rounded-lg transition-colors',
                    isActive && 'bg-tavern-accent-soft',
                  )}>
                    <item.icon className="w-[18px] h-[18px] shrink-0" aria-hidden />
                  </span>
                )}
              </NavLink>
            ))}
          </div>
        ) : (
          navGroups.map(group => {
            const collapsed = collapsedGroups[group.id] ?? !group.defaultOpen
            return (
              <div key={group.id} className="space-y-0.5">
                <button
                  onClick={() => toggleGroup(group.id)}
                  aria-expanded={!collapsed}
                  aria-label={group.label}
                  className="group w-full h-7 flex items-center justify-between px-2.5 rounded-md text-[10px] font-medium tracking-[0.16em] text-tavern-text-muted/65 hover:text-tavern-text-muted hover:bg-tavern-bg-hover/50 transition-colors"
                >
                  <span>{group.label}</span>
                  <ChevronDown className={cn('w-3 h-3 opacity-70 transition-transform duration-200', !collapsed && 'rotate-180')} aria-hidden />
                </button>
                {!collapsed && (
                  <div className="space-y-0.5 pb-1 animate-fade-in">
                    {group.items.map((item) => (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        aria-label={item.label}
                        className={({ isActive }) =>
                          cn(
                            "group relative flex items-center gap-2.5 h-10 px-2.5 rounded-xl text-sm transition-all duration-150 after:content-['']",
                            isActive
                              ? 'bg-tavern-bg-card/80 text-tavern-text shadow-sm ring-1 ring-tavern-border-soft after:absolute after:left-0 after:top-2.5 after:bottom-2.5 after:w-0.5 after:rounded-full after:bg-tavern-accent'
                              : 'text-tavern-text-soft hover:text-tavern-text hover:bg-tavern-bg-hover/60'
                          )
                        }
                      >
                        {({ isActive }) => (
                          <>
                            <span className={cn(
                              'grid h-7 w-7 place-items-center rounded-lg text-tavern-text-muted transition-colors',
                              isActive
                                ? 'bg-tavern-accent-soft text-tavern-accent'
                                : 'group-hover:text-tavern-text-soft',
                            )}>
                              <item.icon className="w-[18px] h-[18px] shrink-0" aria-hidden />
                            </span>
                            <span className={cn('truncate', isActive ? 'font-medium' : 'font-normal')}>{item.label}</span>
                          </>
                        )}
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            )
          })
        )}
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
                  ? settings.activeModel || activeProfile.model || '未选模型'
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
