import { useState } from 'react'
import { Dropdown } from './Dropdown'
import { ConfirmDialog } from './ConfirmDialog'
import { cn } from '../../lib/utils'
import { Layers, ChevronDown, Edit2, Trash2, Plus, UserCircle } from 'lucide-react'

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

  const currentSession = sessions.find(s => s.id === currentSessionId)
  const isChat = variant === 'chat'

  const handleRenameConfirm = async () => {
    if (editingId && editTitle.trim()) {
      await onRename(editingId, editTitle.trim())
    }
    setEditingId(null)
  }

  const handleDeleteConfirm = async () => {
    if (deletingId) {
      await onDelete(deletingId)
    }
    setDeletingId(null)
  }

  if (sessions.length === 0) return null

  return (
    <div className="flex items-center gap-1">
      {isChat && <span className="text-tavern-border-soft select-none">|</span>}

      <Dropdown
        open={showMenu}
        onOpenChange={setShowMenu}
        panelClassName={cn('w-56', isChat && 'max-h-72 overflow-y-auto')}
        trigger={
          isChat ? (
            <button
              className="flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-tavern-bg-hover transition-colors text-sm text-tavern-text-soft"
              title="切换对话"
            >
              <Layers className="w-3.5 h-3.5 text-tavern-text-muted" />
              <span className="max-w-[100px] truncate">
                {currentSession?.title ?? '对话'}
              </span>
              <ChevronDown className="w-3 h-3 text-tavern-text-muted" />
            </button>
          ) : (
            <button className="flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-tavern-bg-hover text-tavern-text-muted hover:text-tavern-text transition-colors">
              {currentSession?.title ?? '会话'}
              <ChevronDown className="w-3 h-3" />
            </button>
          )
        }
      >
        {sessions.map((s) => {
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
                      if (e.key === 'Enter') handleRenameConfirm()
                      else if (e.key === 'Escape') setEditingId(null)
                    }}
                    autoFocus
                    onBlur={() => setEditingId(null)}
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
                      className="flex-1 text-left text-sm text-tavern-text truncate"
                      onClick={() => { onSwitch(s.id); setShowMenu(false) }}
                    >
                      {s.title}
                      <span className="text-xs text-tavern-text-muted ml-2">
                        ({s.messageCount}条)
                      </span>
                    </button>
                    <button
                      className="p-0.5 rounded text-tavern-text-muted hover:text-tavern-text"
                      onClick={(e) => { e.stopPropagation(); setEditingId(s.id); setEditTitle(s.title) }}
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
                    if (e.key === 'Enter') handleRenameConfirm()
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  onBlur={handleRenameConfirm}
                  className="flex-1 bg-tavern-bg border border-tavern-border rounded px-1.5 py-0.5 text-xs text-tavern-text outline-none focus:border-tavern-accent"
                  autoFocus
                />
              ) : (
                <button
                  onClick={() => { onSwitch(s.id); setShowMenu(false) }}
                  className={cn(
                    'flex-1 text-left text-xs truncate px-1',
                    s.id === currentSessionId ? 'text-tavern-accent font-medium' : 'text-tavern-text'
                  )}
                >
                  {s.title}
                  <span className="text-[10px] text-tavern-text-muted ml-1">({s.messageCount ?? 0})</span>
                </button>
              )}
              <button
                onClick={() => { setEditingId(s.id); setEditTitle(s.title) }}
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
