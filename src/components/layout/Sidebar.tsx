import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useUIStore } from '../../store/useUIStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { cn } from '../../lib/utils'
import { logError } from '../../lib/logger'
import { flushSpatialBoard } from '../../lib/spatialFlush'
import { isConnectionConfigured } from '../../utils/defaults'
import {
  BarChart3,
  BookOpen,
  Ellipsis,
  HelpCircle,
  Megaphone,
  MessageSquare,
  MessagesSquare,
  Plug,
  Regex as RegexIcon,
  Settings,
  Sliders,
  UserCircle,
  Users,
  Wrench,
  Zap,
} from 'lucide-react'
import { PanelLeft, PanelLeftClose } from 'lucide'
import { MorphingIcon } from '../common/MorphingIcon'

/**
 * 侧栏信息架构（方案 C：常用常驻 + 更多收纳）
 *
 * - 会话 / 资料 / 服务 三段常驻，只保留日常真正会点的入口；
 * - 低频入口收进「更多」浮层（快捷回复 / 正则 / MCP / 用量 / 公告 / 帮助），
 *   侧栏不再被十几个同级项摊平，也不依赖分组折叠记忆；
 * - 设置固定在底部，与连接状态同处一行。
 */
interface SidebarItem {
  to: string
  label: string
  icon: typeof MessageSquare
}

const SESSION_ITEMS: SidebarItem[] = [
  { to: '/chat', label: '对话', icon: MessageSquare },
  { to: '/group', label: '群聊', icon: MessagesSquare },
]

const LIBRARY_ITEMS: SidebarItem[] = [
  { to: '/personas', label: '身份', icon: UserCircle },
  { to: '/characters', label: '角色卡', icon: Users },
  { to: '/lorebook', label: '世界书', icon: BookOpen },
  { to: '/presets', label: '预设', icon: Sliders },
]

const SERVICE_ITEMS: SidebarItem[] = [
  { to: '/api', label: '模型', icon: Plug },
]

const MORE_ITEMS: SidebarItem[] = [
  { to: '/quick-replies', label: '快捷回复', icon: Zap },
  { to: '/regex', label: '正则', icon: RegexIcon },
  { to: '/mcp', label: 'MCP', icon: Wrench },
  { to: '/usage', label: '用量', icon: BarChart3 },
]

/** 底部固定入口：展开态三个图标并排；收起态只保留设置，帮助 / 公告回落到「更多」 */
const SETTINGS_ITEM: SidebarItem = { to: '/settings', label: '设置', icon: Settings }
const HELP_ITEM: SidebarItem = { to: '/help', label: '帮助', icon: HelpCircle }
const ANNOUNCEMENTS_ITEM: SidebarItem = { to: '/announcements', label: '公告', icon: Megaphone }

// 展开态：34px 行高、9px 圆角，激活只用「白底 + 左侧 2px 强调条」两个信号
const ROW_ITEM = "relative flex w-full items-center gap-3 h-[38px] px-3 rounded-[10px] text-[13px] transition-[color,background-color] duration-150 after:content-[''] after:absolute after:left-0 after:top-2 after:bottom-2 after:w-[2px] after:rounded-full"
// 收起态：40px 图标行
const RAIL_ITEM = "relative flex h-10 w-full items-center justify-center rounded-xl transition-colors duration-150 after:content-[''] after:absolute after:left-0 after:top-2.5 after:bottom-2.5 after:w-[2px] after:rounded-full"
const ROW_ACTIVE = 'bg-tavern-bg-card text-tavern-text after:bg-tavern-accent'
const ROW_IDLE = 'text-tavern-text-soft hover:text-tavern-text hover:bg-tavern-bg-hover/60'
const RAIL_ACTIVE = 'bg-tavern-bg-card after:bg-tavern-accent'
const RAIL_IDLE = 'text-tavern-text-muted hover:text-tavern-text-soft hover:bg-tavern-bg-hover/70'

function SectionDivider() {
  return <div aria-hidden className="mx-1 my-2 h-px shrink-0 bg-tavern-border-soft" />
}

function SidebarLink({
  item,
  collapsed,
  onClick,
  trailing,
  className,
}: {
  item: SidebarItem
  collapsed: boolean
  onClick: (event: MouseEvent<HTMLAnchorElement>, to: string) => void
  trailing?: ReactNode
  className?: string
}) {
  return (
    <NavLink
      to={item.to}
      onClick={(event) => onClick(event, item.to)}
      aria-label={item.label}
      title={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        cn(
          collapsed ? RAIL_ITEM : ROW_ITEM,
          isActive ? (collapsed ? RAIL_ACTIVE : ROW_ACTIVE) : (collapsed ? RAIL_IDLE : ROW_IDLE),
          className,
        )
      }
    >
      {({ isActive }) => (
        <>
          <item.icon
            className={cn(
              'w-[18px] h-[18px] shrink-0 transition-colors',
              isActive ? 'text-tavern-accent' : 'text-tavern-text-muted',
            )}
            aria-hidden
          />
          {!collapsed && <span className={cn('truncate', isActive && 'font-medium')}>{item.label}</span>}
          {trailing}
        </>
      )}
    </NavLink>
  )
}

/** 底部图标按钮：展开态的 设置 / 帮助 / 公告 并排，无文字标签 */
function FooterIconLink({
  item,
  onClick,
  trailing,
}: {
  item: SidebarItem
  onClick: (event: MouseEvent<HTMLAnchorElement>, to: string) => void
  trailing?: ReactNode
}) {
  return (
    <NavLink
      to={item.to}
      onClick={(event) => onClick(event, item.to)}
      aria-label={item.label}
      title={item.label}
      className={({ isActive }) =>
        cn(
          'relative grid h-7 w-7 place-items-center rounded-md transition-colors',
          isActive
            ? 'bg-tavern-accent-soft text-tavern-accent'
            : 'text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover',
        )
      }
    >
      <item.icon className="w-[18px] h-[18px]" aria-hidden />
      {trailing}
    </NavLink>
  )
}

export function Sidebar() {
  const { sidebarCollapsed, toggleSidebar } = useUIStore()
  const settings = useSettingsStore((s) => s.settings)
  const getActiveProfile = useSettingsStore((s) => s.getActiveProfile)
  const { pathname } = useLocation()
  const navigate = useNavigate()

  const activeProfile = getActiveProfile()
  const isConnected = isConnectionConfigured(activeProfile)
  const modelLabel = isConnected && activeProfile
    ? settings.activeModel || activeProfile.model || '未选模型'
    : '未连接'

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

  // 侧栏不展示版本号；仅在有新版本时给「设置」入口加提示点（更新入口仍在设置页）
  const hasUpdate = serverVersion !== null && appVersion !== '' && isNewerVersion(appVersion, serverVersion)

  // 获取本地版本 + 在线版本检查
  useEffect(() => {
    window.api.app.getVersion().then(v => setAppVersion(v)).catch((e) => logError('Sidebar:getVersion', e))
    window.api.app.checkVersion().then(info => {
      if (info?.version) {
        setServerVersion(info.version)
      }
    }).catch((e) => logError('Sidebar:checkVersion', e))
  }, [])

  const handleNavigation = (event: MouseEvent<HTMLAnchorElement>, to: string) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || pathname === to) return
    const pending = flushSpatialBoard()
    if (!pending) return
    event.preventDefault()
    void pending.then(() => navigate(to)).catch(() => {})
  }

  // 「更多」浮层：锚定触发按钮右侧底部对齐；导航滚动/窗口尺寸变化/切页时收起
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  const morePanelRef = useRef<HTMLDivElement>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [moreAnchor, setMoreAnchor] = useState<{ left: number; bottom: number } | null>(null)

  const closeMore = useCallback(() => setMoreOpen(false), [])

  const toggleMore = useCallback(() => {
    if (moreOpen) {
      setMoreOpen(false)
      return
    }
    const rect = moreButtonRef.current?.getBoundingClientRect()
    if (!rect) return
    const panelWidth = 176 // w-44
    const left = Math.max(8, Math.min(rect.right + 8, window.innerWidth - panelWidth - 8))
    setMoreAnchor({ left, bottom: Math.max(8, window.innerHeight - rect.bottom) })
    setMoreOpen(true)
  }, [moreOpen])

  useEffect(() => {
    if (!moreOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMore()
    }
    const onResize = () => closeMore()
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onResize)
    const frame = requestAnimationFrame(() => {
      morePanelRef.current?.querySelector<HTMLAnchorElement>('a')?.focus()
    })
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onResize)
      cancelAnimationFrame(frame)
    }
  }, [moreOpen, closeMore])

  // 切页 / 收起侧栏时浮层不再有意义（首次挂载不触发，避免无谓状态写入）
  const firstRenderRef = useRef(true)
  useEffect(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false
      return
    }
    closeMore()
  }, [pathname, sidebarCollapsed, closeMore])

  const updateDot = hasUpdate && (
    <span
      className={cn(
        'absolute h-1.5 w-1.5 shrink-0 rounded-full bg-tavern-danger',
        sidebarCollapsed ? 'right-2 top-2' : 'right-0.5 top-0.5',
      )}
      title={`公告版本 v${serverVersion} 可用，可前往设置更新`}
    >
      <span className="sr-only">有新版本可用</span>
    </span>
  )

  // 帮助 / 公告在展开态常驻底部；收起态没有底部图标行，回落到「更多」浮层
  const moreItems = sidebarCollapsed ? [...MORE_ITEMS, HELP_ITEM, ANNOUNCEMENTS_ITEM] : MORE_ITEMS

  const moreButton = (
    <button
      ref={moreButtonRef}
      type="button"
      onClick={toggleMore}
      aria-haspopup="dialog"
      aria-expanded={moreOpen}
      aria-label="更多"
      title={sidebarCollapsed ? '更多' : undefined}
      className={cn(
        sidebarCollapsed ? RAIL_ITEM : ROW_ITEM,
        moreOpen
          ? 'bg-tavern-bg-hover text-tavern-text'
          : (sidebarCollapsed ? RAIL_IDLE : ROW_IDLE),
      )}
    >
      <Ellipsis className="w-[18px] h-[18px] shrink-0 text-tavern-text-muted" aria-hidden />
      {!sidebarCollapsed && <span className="truncate">更多</span>}
    </button>
  )

  const morePanel = moreOpen && moreAnchor && createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={closeMore} aria-hidden />
      <div
        ref={morePanelRef}
        role="dialog"
        aria-label="更多入口"
        style={{ left: moreAnchor.left, bottom: moreAnchor.bottom }}
        className="fixed z-50 w-44 rounded-xl border border-tavern-border bg-tavern-bg-card p-1.5 shadow-xl"
      >
        {moreItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={(event) => {
              closeMore()
              handleNavigation(event, item.to)
            }}
            aria-label={item.label}
            className={({ isActive }) =>
              cn(
                'flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[12.5px] transition-colors',
                isActive
                  ? 'bg-tavern-bg-hover text-tavern-text'
                  : 'text-tavern-text-soft hover:bg-tavern-bg-hover hover:text-tavern-text',
              )
            }
          >
            <item.icon className="h-4 w-4 shrink-0 text-tavern-text-muted" aria-hidden />
            <span className="truncate">{item.label}</span>
          </NavLink>
        ))}
      </div>
    </>,
    document.body,
  )

  return (
    <aside
      className={cn(
        'flex flex-col bg-tavern-bg-soft/95 border-r border-tavern-border-soft transition-[width] duration-200 ease-out',
        sidebarCollapsed ? 'w-16' : 'w-40'
      )}
    >
      {/* 导航：常驻段之间用发丝线分隔，不再有分组标题与折叠箭头 */}
      <nav
        aria-label="主导航"
        onScroll={closeMore}
        className={cn(
          'flex-1 min-h-0 overflow-y-auto pt-5 pb-2.5',
          sidebarCollapsed ? 'px-2' : 'pl-4 pr-2.5',
        )}
      >
        <div className="flex flex-col gap-0.5">
          {SESSION_ITEMS.map((item) => (
            <SidebarLink key={item.to} item={item} collapsed={sidebarCollapsed} onClick={handleNavigation} />
          ))}
          <SectionDivider />
          {LIBRARY_ITEMS.map((item) => (
            <SidebarLink key={item.to} item={item} collapsed={sidebarCollapsed} onClick={handleNavigation} />
          ))}
          <SectionDivider />
          {SERVICE_ITEMS.map((item) => (
            <SidebarLink key={item.to} item={item} collapsed={sidebarCollapsed} onClick={handleNavigation} />
          ))}
          {moreButton}
        </div>
      </nav>

      {/* 底部：设置与收起同一行，连接状态（模型名）单独一行 */}
      <div className={cn('shrink-0 border-t border-tavern-border-soft p-2', !sidebarCollapsed && 'pl-4 pr-2.5')}>
        {sidebarCollapsed ? (
          <>
            <SidebarLink item={SETTINGS_ITEM} collapsed onClick={handleNavigation} trailing={updateDot} />
            <div className="mt-1 flex flex-col items-center gap-1">
              <button
                onClick={toggleSidebar}
                className="grid h-8 w-8 place-items-center rounded-md text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover transition-colors"
                title="展开侧栏"
                aria-label="展开侧栏"
              >
                <MorphingIcon icon={PanelLeft} className="w-4 h-4" />
              </button>
              <span
                className={cn('h-2 w-2 shrink-0 rounded-full', isConnected ? 'bg-tavern-success' : 'bg-tavern-danger')}
                title={modelLabel}
              />
            </div>
          </>
        ) : (
          <>
            {/* 设置 / 帮助 / 公告：三个图标并排；收起按钮靠右 */}
            <div className="flex items-center justify-between">
              <FooterIconLink item={SETTINGS_ITEM} onClick={handleNavigation} trailing={updateDot} />
              <FooterIconLink item={HELP_ITEM} onClick={handleNavigation} />
              <FooterIconLink item={ANNOUNCEMENTS_ITEM} onClick={handleNavigation} />
              <button
                onClick={toggleSidebar}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover transition-colors"
                title="收起侧栏"
                aria-label="收起侧栏"
              >
                <MorphingIcon icon={PanelLeftClose} className="w-4 h-4" />
              </button>
            </div>
            <div className="mt-1 flex items-center gap-1.5 pl-1">
              <span
                className={cn('h-1.5 w-1.5 shrink-0 rounded-full', isConnected ? 'bg-tavern-success animate-pulse-soft' : 'bg-tavern-danger')}
              />
              <span className="truncate text-[11.5px] text-tavern-text-muted" title={modelLabel}>
                {modelLabel}
              </span>
            </div>
          </>
        )}
      </div>

      {morePanel}
    </aside>
  )
}



