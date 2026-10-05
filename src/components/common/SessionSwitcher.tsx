import { useRef, useState } from 'react'
import { Dropdown } from './Dropdown'
import { ConfirmDialog } from './ConfirmDialog'
import { cn } from '../../lib/utils'
import { Layers, ChevronDown, Edit2, Trash2, Plus, Search, UserCircle } from 'lucide-react'

interface SessionSwitcherProps {
  /** 兼容单聊 SessionPreview[] 与群聊 GroupSession[]（均含 id/title/messageCount） */
  sessions: Array<{ id: string; title: string; messageCount: number; personaId?: string | null }>
  currentSessionId: string | null
  onSwitch: (sessionId: string) => void
  onRename: (sessionId: string, newTitle: string) => void | Promise<void>
  onDelete: (sessionId: string) => void | Promise<void>
  onCreate?: () => void
  /** 显示 persona 头像 */
  showPersona?: boolean
  getPersona?: (id?: string) => { avatar?: string } | undefined
  variant?: 'chat' | 'group'
  /** 额外内容渲染在下拉触发器旁边（如 ChatPage 的 "新建" 和 "记忆" 按钮） */
  extra?: React.ReactNode
}

/**
 * 通用会话切换器组件。
 * 封装了会话下拉菜单、重命名、删除确认等交互逻辑。
 */
export function SessionSwitcher({
  sessions,
  currentSessionId,
  onSwitch,
  onRename,
  onDelete,
  onCreate,
  showPersona = false,
  getPersona,
  variant = 'chat',
  extra,
}: SessionSwitcherProps) {
  const [showMenu, setShowMenu] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  // UEX-P1-33：会话列表轻量搜索（仅会话多时显示）
  const [search, setSearch] = useState('')
  // UEX-P1-33：会话列表轻量排序切换（最近使用 / 名称），仅前端内存态、不落盘
  const [sortBy, setSortBy] = useState<'recent' | 'name'>('recent')
  // UEX-P1-32：重命名结束标记，防止「回车 + 失焦」重复提交或 Esc 后误提交
  const renameDoneRef = useRef(false)

  const currentSession = sessions.find(s => s.id === currentSessionId)
  const isChat = variant === 'chat'

  // UEX-P1-33：按会话标题前端过滤 + 排序（默认「最近使用」保持现有顺序；「名称」localeCompare('zh')）
  const searchKeyword = search.trim().toLowerCase()
  const filteredSessions = searchKeyword
    ? sessions.filter(s => s.title.toLowerCase().includes(searchKeyword))
    : sessions
  const visibleSessions = sortBy === 'name'
    ? [...filteredSessions].sort((a, b) => a.title.localeCompare(b.title, 'zh'))
    : filteredSessions

  const beginRename = (s: { id: string; title: string }) => {
    renameDoneRef.current = false
    setEditingId(s.id)
    setEditTitle(s.title)
  }

  // UEX-P1-32：失焦 = 提交保存（chat/group 统一），Esc = 取消
  const handleRenameConfirm = async () => {
    if (renameDoneRef.current || !editingId) return
    renameDoneRef.current = true
    const id = editingId
    const title = editTitle.trim()
    setEditingId(null)
    if (title) {
      await onRename(id, title)
    }
  }

  const handleRenameCancel = () => {
    renameDoneRef.current = true
    setEditingId(null)
  }

  const handleDeleteConfirm = async () => {
    if (deletingId) {
      await onDelete(deletingId)
    }
    setDeletingId(null)
  }

  if (sessions.length === 0) {
    return (
      <div className="text-xs text-tavern-text-muted px-2">
        暂无会话
        {onCreate && (
          <button type="button" className="ml-2 text-tavern-accent hover:underline" onClick={onCreate}>
            新建
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1">
      {isChat && <span className="mx-1 h-4 w-px bg-tavern-border" aria-hidden="true" />}

      <Dropdown
        open={showMenu}
        onOpenChange={(open) => {
          setShowMenu(open)
          // UEX-P1-33：关闭下拉时清空搜索词，避免下次打开残留过滤条件
          if (!open) setSearch('')
        }}
        panelClassName={cn('w-56', isChat && 'max-h-72 overflow-y-auto')}
        panelRole="menu"
        panelAriaLabel="会话列表"
        trigger={
          isChat ? (
            <button
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-sm font-medium text-tavern-text-soft transition-colors hover:bg-tavern-bg-hover hover:text-tavern-text"
              title="切换对话"
            >
              <Layers className="h-3.5 w-3.5 text-tavern-text-soft" />
              <span className="session-switcher__label max-w-[100px] truncate">
                {currentSession?.title ?? '对话'}
              </span>
              <ChevronDown className="h-3 w-3 text-tavern-text-soft" />
            </button>
          ) : (
            <button className="flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-tavern-bg-hover text-tavern-text-muted hover:text-tavern-text transition-colors">
              {currentSession?.title ?? '会话'}
              <ChevronDown className="w-3 h-3" />
            </button>
          )
        }
      >
        {/* UEX-P1-33：会话多于 5 条时提供轻量搜索框（按标题前端过滤）+ 排序切换 */}
        {sessions.length > 5 && (
          <div className="px-2 pt-1 pb-1.5 space-y-1">
            <div className="flex items-center gap-1.5 rounded-lg bg-tavern-bg px-2 py-1 border border-tavern-border-soft">
              <Search className="w-3 h-3 text-tavern-text-muted shrink-0" aria-hidden />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索会话..."
                aria-label="搜索会话"
                className="flex-1 bg-transparent outline-none text-xs placeholder:text-tavern-text-muted"
              />
            </div>
            {/* UEX-P1-33：轻量排序切换（最近使用 / 名称），仅前端内存态、不落盘；默认最近使用 = 现有顺序 */}
            <div
              role="group"
              aria-label="会话排序"
              className="flex items-center gap-1 rounded-lg bg-tavern-bg px-1.5 py-1 border border-tavern-border-soft"
            >
              <span className="text-[10px] text-tavern-text-muted shrink-0">排序</span>
              {([
                { value: 'recent' as const, label: '最近使用' },
                { value: 'name' as const, label: '名称' },
              ]).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={sortBy === option.value}
                  onClick={() => setSortBy(option.value)}
                  className={cn(
                    'rounded-md px-1.5 py-0.5 text-[10px] transition-colors',
                    sortBy === option.value
                      ? 'bg-tavern-accent-soft text-tavern-accent font-semibold'
                      : 'text-tavern-text-muted hover:bg-tavern-bg-hover hover:text-tavern-text'
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {visibleSessions.length === 0 && (
          <div className="px-3 py-3 text-xs text-tavern-text-muted">无匹配会话</div>
        )}
        {visibleSessions.map((s) => {
          if (isChat) {
            // Chat 风格：带 persona 头像
            return (
              <div
                key={s.id}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 hover:bg-tavern-bg-hover transition-colors',
                  s.id === currentSessionId && 'bg-tavern-accent-soft'
                )}
              >
                {editingId === s.id ? (
                  <input
                    className="input text-xs flex-1 py-1 px-2"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onKeyDown={(e) => {
                      // UEX-P1-32：回车 = 提交保存，Esc = 取消，失焦 = 提交保存（与 group 分支一致）
                      if (e.key === 'Enter') void handleRenameConfirm()
                      else if (e.key === 'Escape') { e.stopPropagation(); handleRenameCancel() }
                    }}
                    autoFocus
                    onBlur={() => void handleRenameConfirm()}
                  />
                ) : (
                  <>
                    {showPersona && (
                      <div className="w-5 h-5 rounded-full overflow-hidden bg-tavern-bg-hover flex items-center justify-center shrink-0">
                        {getPersona?.(s.personaId ?? undefined)?.avatar ? (
                          <img src={getPersona(s.personaId ?? undefined)!.avatar} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <UserCircle className="w-4 h-4 text-tavern-text-muted" />
                        )}
                      </div>
                    )}
                    <button
                      role="menuitem"
                      aria-label={s.title}
                      aria-current={s.id === currentSessionId ? 'true' : undefined}
                      className="flex-1 text-left text-sm text-tavern-text truncate"
                      onClick={() => { onSwitch(s.id); setShowMenu(false) }}
                    >
                      {s.title}
                      <span className="text-xs text-tavern-text-muted ml-2" aria-hidden="true">
                        ({s.messageCount}条)
                      </span>
                    </button>
                    <button
                      className="p-0.5 rounded text-tavern-text-muted hover:text-tavern-text"
                      onClick={(e) => { e.stopPropagation(); beginRename(s) }}
                      title="重命名"
                    >
                      <Edit2 className="w-3 h-3" />
                    </button>
                    {sessions.length > 1 && (
                      <button
                        className="p-0.5 rounded text-tavern-text-muted hover:text-tavern-danger"
                        onClick={(e) => { e.stopPropagation(); setDeletingId(s.id) }}
                        title="删除"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </>
                )}
              </div>
            )
          }

          // Group 风格：更紧凑
          return (
            <div key={s.id} className="group flex items-center gap-1 px-2 py-1.5 hover:bg-tavern-bg-hover">
              {editingId === s.id ? (
                <input
                  value={editTitle}
                  onChange={e => setEditTitle(e.target.value)}
                  onKeyDown={e => {
                    // UEX-P1-32：回车 = 提交保存，Esc = 取消，失焦 = 提交保存（与 chat 分支一致）
                    if (e.key === 'Enter') void handleRenameConfirm()
                    else if (e.key === 'Escape') { e.stopPropagation(); handleRenameCancel() }
                  }}
                  onBlur={() => void handleRenameConfirm()}
                  className="flex-1 bg-tavern-bg border border-tavern-border rounded px-1.5 py-0.5 text-xs text-tavern-text outline-none focus:border-tavern-accent"
                  autoFocus
                />
              ) : (
                <button
                  role="menuitem"
                  aria-label={s.title}
                  aria-current={s.id === currentSessionId ? 'true' : undefined}
                  onClick={() => { onSwitch(s.id); setShowMenu(false) }}
                  className={cn(
                    'flex-1 text-left text-xs truncate px-1',
                    s.id === currentSessionId ? 'text-tavern-accent font-medium' : 'text-tavern-text'
                  )}
                >
                  {s.title}
                  <span className="text-[10px] text-tavern-text-muted ml-1" aria-hidden="true">({s.messageCount ?? 0})</span>
                </button>
              )}
              <button
                onClick={() => beginRename(s)}
                className="opacity-0 group-hover:opacity-100 p-0.5 text-tavern-text-muted hover:text-tavern-text"
                title="重命名"
              >
                <Edit2 className="w-3 h-3" />
              </button>
              {sessions.length > 1 && (
                <button
                  onClick={() => setDeletingId(s.id)}
                  className="opacity-0 group-hover:opacity-100 p-0.5 text-tavern-text-muted hover:text-tavern-danger"
                  title="删除"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              )}
            </div>
          )
        })}

        {/* 新建会话按钮（Group 风格放在下拉内，Chat 风格通过 extra 传入） */}
        {!isChat && onCreate && (
          <div className="border-t border-tavern-border-soft pt-1 mt-1">
            <button
              onClick={() => { onCreate(); setShowMenu(false) }}
              className="w-full text-left px-3 py-1.5 text-xs text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover"
            >
              <Plus className="w-3 h-3 inline mr-1" />新建会话
            </button>
          </div>
        )}
      </Dropdown>

      {/* 额外内容（如 ChatPage 的新建按钮和记忆按钮） */}
      {extra}

      {/* 删除确认弹窗 */}
      <ConfirmDialog
        open={!!deletingId}
        onClose={() => setDeletingId(null)}
        onConfirm={handleDeleteConfirm}
        title="删除会话"
        message="确定要删除这个会话吗？所有对话记录都将被删除。此操作不可撤销。"
        confirmText="删除"
        danger
      />
    </div>
  )
}
