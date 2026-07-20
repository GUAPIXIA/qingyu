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
  Beer,
  Regex as RegexIcon,
  UserCircle,
  BarChart3,
  Wrench,
} from 'lucide-react'
import { PROVIDER_INFO } from '../../utils/defaults'

const navItems = [
  { to: '/chat', label: '对话', icon: MessageSquare },
  { to: '/characters', label: '角色', icon: Users },
  { to: '/personas', label: '身份', icon: UserCircle },
  { to: '/group', label: '群聊', icon: UsersRound },
  { to: '/lorebook', label: '世界书', icon: BookOpen },
  { to: '/presets', label: '预设', icon: Sliders },
  { to: '/regex', label: '正则', icon: RegexIcon },
  { to: '/api', label: 'API', icon: Plug },
  { to: '/usage', label: '用量', icon: BarChart3 },
  { to: '/mcp', label: 'MCP', icon: Wrench },
  { to: '/settings', label: '设置', icon: Settings },
  { to: '/help', label: '帮助', icon: HelpCircle },
]

export function Sidebar() {
  const { sidebarCollapsed, toggleSidebar } = useUIStore()
  const { settings, getActiveProfile } = useSettingsStore()

  const activeProfile = getActiveProfile()
  const isConnected = activeProfile !== null && (activeProfile.provider === 'ollama' || !!activeProfile.apiKey)

  return (
    <aside
      className={cn(
        'flex flex-col bg-tavern-bg-soft border-r border-tavern-border-soft transition-all duration-300',
        sidebarCollapsed ? 'w-16' : 'w-56'
      )}
    >
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-4 h-14 border-b border-tavern-border-soft">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-tavern-accent-soft shrink-0">
          <Beer className="w-5 h-5 text-tavern-accent" />
        </div>
        {!sidebarCollapsed && (
          <div className="flex flex-col">
            <span className="font-display text-sm font-bold text-tavern-text">轻 Tavern</span>
            <span className="text-xs text-tavern-text-muted">AI 角色扮演</span>
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
