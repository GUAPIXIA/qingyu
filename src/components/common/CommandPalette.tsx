import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  BookOpen,
  Bot,
  Copy,
  Cpu,
  Download,
  Info,
  MessageCircle,
  MessageSquare,
  MessageSquarePlus,
  Plug,
  Plus,
  Regex,
  Search,
  Settings,
  SlidersHorizontal,
  Square,
  Terminal,
  User,
  Users,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { useChatStore } from '../../store/useChatStore'
import { useGroupChatStore } from '../../store/useGroupChatStore'
import { cn } from '../../lib/utils'
import { listCommands } from '../../commands/registry'
import { registerBuiltinCommands } from '../../commands/builtin'

interface Command {
  /** 唯一 id，同时作为过滤匹配的补充文本 */
  id: string
  label: string
  desc?: string
  icon: LucideIcon
  action: () => void
  /** 分组标题（用于分隔线显示） */
  group?: string
}

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
}

/**
 * 全局命令面板（Ctrl+/ 唤起）。
 * 支持文本过滤、↑↓ 选择、Enter 执行、Esc/遮罩点击关闭。
 */
export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const selectedRef = useRef<HTMLButtonElement>(null)

  // 打开时重置状态并聚焦输入框
  useEffect(() => {
    if (open) {
      setQuery('')
      setSelectedIdx(0)
      // 等待面板挂载后聚焦
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // 延迟派发事件：等待目标页面挂载并注册监听（如 ChatPage 的 new-chat 监听）
  const dispatchAfterNavigate = (path: string, eventName: string) => {
    navigate(path)
    setTimeout(() => window.dispatchEvent(new CustomEvent(eventName)), 60)
  }

  // 命令面板与聊天输入框共用同一份斜杠命令注册表，避免两套清单漂移。
  registerBuiltinCommands()
  const slashCommands: Command[] = listCommands().map((cmd) => ({
    id: `slash-${cmd.name}`,
    label: `/${cmd.name}`,
    desc: `${cmd.description} · ${cmd.usage}`,
    icon: Terminal,
    group: '指令',
    action: () => {
      navigate('/chat')
      setTimeout(() => window.dispatchEvent(new CustomEvent('shortcut:insert-command', {
        detail: { value: cmd.usage },
      })), 60)
    },
  }))

  // 命令列表（直接构建，每次渲染闭包新鲜，无需 useMemo）
  const commands: Command[] = [
      {
        id: 'new-chat',
        label: '新建对话',
        desc: '为当前角色创建新会话',
        icon: MessageSquarePlus,
        group: '操作',
        action: () => dispatchAfterNavigate('/chat', 'shortcut:new-chat'),
      },
      {
        id: 'export-chat',
        label: '导出当前对话',
        desc: '导出为文件保存',
        icon: Download,
        group: '操作',
        action: () => dispatchAfterNavigate('/chat', 'shortcut:export-chat'),
      },
      {
        id: 'copy-last-ai',
        label: '复制最后一条 AI 回复',
        icon: Copy,
        group: '操作',
        action: () => dispatchAfterNavigate('/chat', 'shortcut:copy-last-ai'),
      },
      {
        id: 'stop-streaming',
        label: '停止生成',
        icon: Square,
        group: '操作',
        action: () => {
          useChatStore.getState().stopStreaming()
          useGroupChatStore.getState().stopStreaming()
        },
      },
      ...slashCommands,
      { id: 'page-chat', label: '前往：聊天', icon: MessageSquare, group: '页面', action: () => navigate('/chat') },
      { id: 'page-group', label: '前往：群聊', icon: Users, group: '页面', action: () => navigate('/group') },
      { id: 'page-characters', label: '前往：角色', icon: Bot, group: '页面', action: () => navigate('/characters') },
      { id: 'page-character-create', label: '前往：制作角色卡', icon: Plus, group: '页面', action: () => navigate('/character-create') },
      { id: 'page-lorebook', label: '前往：世界书', icon: BookOpen, group: '页面', action: () => navigate('/lorebook') },
      { id: 'page-presets', label: '前往：预设', icon: SlidersHorizontal, group: '页面', action: () => navigate('/presets') },
      { id: 'page-regex', label: '前往：正则', icon: Regex, group: '页面', action: () => navigate('/regex') },
      { id: 'page-quick-replies', label: '前往：快捷回复', icon: Zap, group: '页面', action: () => navigate('/quick-replies') },
      { id: 'page-personas', label: '前往：人设', icon: User, group: '页面', action: () => navigate('/personas') },
      { id: 'page-api', label: '前往：API 设置', icon: Plug, group: '页面', action: () => navigate('/api') },
      { id: 'page-mcp', label: '前往：MCP 工具', icon: Cpu, group: '页面', action: () => navigate('/mcp') },
      { id: 'page-usage', label: '前往：用量统计', icon: Info, group: '页面', action: () => navigate('/usage') },
      { id: 'page-announcements', label: '前往：公告', icon: MessageCircle, group: '页面', action: () => navigate('/announcements') },
      { id: 'page-help', label: '前往：帮助', icon: Info, group: '页面', action: () => navigate('/help') },
      { id: 'page-settings', label: '前往：设置', icon: Settings, group: '页面', action: () => navigate('/settings') },
  ]

  // 过滤：匹配 label / desc / id
  const q = query.trim().toLowerCase()
  const filtered = q
    ? commands.filter((c) => `${c.label} ${c.desc ?? ''} ${c.id}`.toLowerCase().includes(q))
    : commands

  // 过滤结果变化时重置选中项
  useEffect(() => {
    setSelectedIdx(0)
  }, [query])

  // 键盘选择可能越过当前滚动窗口；始终让高亮命令保持可见。
  useEffect(() => {
    if (!open || filtered.length === 0) return
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [open, selectedIdx, filtered.length])

  const execute = (cmd: Command) => {
    onClose()
    cmd.action()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx((prev) => (prev + 1) % Math.max(filtered.length, 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx((prev) => (prev - 1 + Math.max(filtered.length, 1)) % Math.max(filtered.length, 1))
      return
    }
    if (e.key === 'Enter' && filtered.length > 0) {
      e.preventDefault()
      execute(filtered[Math.min(selectedIdx, filtered.length - 1)])
    }
  }

  if (!open) return null

  // 按分组渲染（操作 / 页面）
  const groups = ['操作', '指令', '页面'] as const

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh] px-4 animate-fade-in">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-tavern-bg-card border border-tavern-border rounded-2xl shadow-2xl overflow-hidden">
        {/* 搜索框 */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-tavern-border-soft">
          <Search className="w-4 h-4 text-tavern-text-muted shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            role="combobox"
            aria-expanded={open}
            aria-controls="command-palette-list"
            aria-activedescendant={filtered[selectedIdx] ? `command-${filtered[selectedIdx].id}` : undefined}
            placeholder="搜索命令或输入页面名称…"
            className="flex-1 bg-transparent outline-none text-sm text-tavern-text placeholder:text-tavern-text-muted"
          />
          <kbd className="px-1.5 py-0.5 rounded text-[10px] bg-tavern-bg-hover text-tavern-text-muted border border-tavern-border-soft shrink-0">Esc</kbd>
        </div>
        {/* 命令列表 */}
        <div id="command-palette-list" role="listbox" className="max-h-[45vh] overflow-y-auto py-1.5">
          {filtered.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-tavern-text-muted">没有匹配的命令</div>
          )}
          {groups.map((group) => {
            const items = filtered.filter((c) => c.group === group)
            if (items.length === 0) return null
            return (
              <div key={group}>
                <div className="px-4 pt-2 pb-1 text-[11px] font-medium text-tavern-text-muted">{group}</div>
                {items.map((cmd) => {
                  const idx = filtered.indexOf(cmd)
                  const selected = idx === selectedIdx
                  const Icon = cmd.icon
                  return (
                    <button
                      key={cmd.id}
                      id={`command-${cmd.id}`}
                      ref={selected ? selectedRef : undefined}
                      role="option"
                      aria-selected={selected}
                      onClick={() => execute(cmd)}
                      onMouseEnter={() => setSelectedIdx(idx)}
                      className={cn(
                        'w-full flex items-center gap-3 px-4 py-2 text-left text-sm transition-colors',
                        selected ? 'bg-tavern-bg-hover text-tavern-text' : 'text-tavern-text-muted hover:text-tavern-text',
                      )}
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      <span className="flex-1 truncate">{cmd.label}</span>
                      {cmd.desc && <span className="text-xs text-tavern-text-muted truncate">{cmd.desc}</span>}
                      {selected && <kbd className="px-1.5 py-0.5 rounded text-[10px] bg-tavern-bg-hover text-tavern-text-muted border border-tavern-border-soft shrink-0">↵</kbd>}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
