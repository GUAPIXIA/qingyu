import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { nanoid } from 'nanoid'
import { useCharacterStore } from '../store/useCharacterStore'
import { EmptyState } from '../components/common/EmptyState'
import { ConfirmDialog } from '../components/common/ConfirmDialog'
import { cn } from '../lib/utils'
import type { GroupChat } from '../../shared/types'
import {
  Plus,
  Trash2,
  Users,
  ArrowUp,
  ArrowDown,
  X,
  MessageSquare,
  UserPlus,
  Settings2,
  Zap,
  ZapOff,
} from 'lucide-react'

const STORAGE_KEY = 'group-chats'
const ACTIVE_KEY = 'active-group-chat'

function loadGroupChats(): GroupChat[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed as GroupChat[]
    return []
  } catch {
    return []
  }
}

function saveGroupChats(list: GroupChat[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
}

function Avatar({ name, avatar, size = 32 }: { name: string; avatar?: string; size?: number }) {
  const [imgError, setImgError] = useState(false)
  const initial = name.charAt(0).toUpperCase() || '?'
  if (avatar && !imgError) {
    return (
      <img
        src={avatar}
        alt={name}
        className="rounded-full object-cover shrink-0"
        style={{ width: size, height: size }}
        onError={() => setImgError(true)}
      />
    )
  }
  return (
    <div
      className="rounded-full bg-tavern-bg-hover flex items-center justify-center text-tavern-accent font-medium shrink-0"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {initial}
    </div>
  )
}

export function GroupChatPage() {
  const navigate = useNavigate()
  const { characters, selectCharacter } = useCharacterStore()
  const [groupChats, setGroupChats] = useState<GroupChat[]>(() => loadGroupChats())
  const [selectedId, setSelectedId] = useState<string | null>(
    () => loadGroupChats()[0]?.id ?? null
  )
  const [deleteId, setDeleteId] = useState<string | null>(null)

  useEffect(() => {
    saveGroupChats(groupChats)
  }, [groupChats])

  const selected = groupChats.find((g) => g.id === selectedId) ?? null

  const updateGroup = (updated: GroupChat) => {
    setGroupChats((list) => list.map((g) => (g.id === updated.id ? updated : g)))
  }

  const handleCreate = () => {
    const newGroup: GroupChat = {
      id: nanoid(),
      name: '新群聊',
      memberIds: [],
      currentSpeakerIndex: 0,
      autoMode: false,
      createdAt: Date.now(),
    }
    setGroupChats((list) => [newGroup, ...list])
    setSelectedId(newGroup.id)
  }

  const handleDelete = () => {
    if (!deleteId) return
    setGroupChats((list) => list.filter((g) => g.id !== deleteId))
    if (selectedId === deleteId) setSelectedId(null)
    setDeleteId(null)
  }

  const addMember = (charId: string) => {
    if (!selected || selected.memberIds.includes(charId)) return
    updateGroup({ ...selected, memberIds: [...selected.memberIds, charId] })
  }

  const removeMember = (charId: string) => {
    if (!selected) return
    const memberIds = selected.memberIds.filter((id) => id !== charId)
    const currentSpeakerIndex = Math.min(
      selected.currentSpeakerIndex,
      Math.max(0, memberIds.length - 1)
    )
    updateGroup({ ...selected, memberIds, currentSpeakerIndex })
  }

  const moveMember = (index: number, direction: -1 | 1) => {
    if (!selected) return
    const newIndex = index + direction
    if (newIndex < 0 || newIndex >= selected.memberIds.length) return
    const memberIds = [...selected.memberIds]
    ;[memberIds[index], memberIds[newIndex]] = [memberIds[newIndex], memberIds[index]]
    updateGroup({ ...selected, memberIds })
  }

  const toggleAutoMode = () => {
    if (!selected) return
    updateGroup({ ...selected, autoMode: !selected.autoMode })
  }

  const setName = (name: string) => {
    if (!selected) return
    updateGroup({ ...selected, name })
  }

  const setCurrentSpeaker = (index: number) => {
    if (!selected) return
    updateGroup({ ...selected, currentSpeakerIndex: index })
  }

  const startChat = () => {
    if (!selected || selected.memberIds.length === 0) return
    const speakerId =
      selected.memberIds[selected.currentSpeakerIndex] ?? selected.memberIds[0]
    selectCharacter(speakerId)
    localStorage.setItem(ACTIVE_KEY, selected.id)
    navigate('/chat')
  }

  const memberCharacters = selected
    ? selected.memberIds
        .map((id) => characters.find((c) => c.id === id))
        .filter((c): c is NonNullable<typeof c> => !!c)
    : []
  const availableCharacters = characters.filter(
    (c) => !selected || !selected.memberIds.includes(c.id)
  )

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 顶栏 */}
      <header className="flex items-center justify-between px-4 h-14 border-b border-tavern-border-soft bg-tavern-bg-soft shrink-0">
        <h1 className="font-display text-lg font-bold">群聊</h1>
        <button onClick={handleCreate} className="btn-primary">
          <Plus className="w-4 h-4" />
          创建群聊
        </button>
      </header>

      {groupChats.length === 0 ? (
        <div className="flex-1 overflow-y-auto p-4">
          <EmptyState
            className="h-full"
            icon={<Users className="w-8 h-8" />}
            title="还没有群聊"
            description="创建一个群聊，将多个角色组合在一起进行接力对话"
            action={
              <button className="btn-primary" onClick={handleCreate}>
                <Plus className="w-4 h-4" />
                创建群聊
              </button>
            }
          />
        </div>
      ) : (
        <div className="flex-1 flex overflow-hidden">
          {/* 左侧：群聊列表 */}
          <aside className="w-1/3 min-w-[240px] max-w-[400px] border-r border-tavern-border-soft overflow-y-auto p-3 space-y-2">
            {groupChats.map((g) => {
              const count = g.memberIds.length
              const isActive = g.id === selectedId
              return (
                <div
                  key={g.id}
                  onClick={() => setSelectedId(g.id)}
                  className={cn(
                    'card p-3 cursor-pointer transition-colors',
                    isActive && 'border-tavern-accent'
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-tavern-text truncate">{g.name}</div>
                      <div className="text-xs text-tavern-text-muted mt-0.5 flex items-center gap-1">
                        <Users className="w-3 h-3" />
                        {count} 个成员
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setGroupChats((list) =>
                          list.map((x) =>
                            x.id === g.id ? { ...x, autoMode: !x.autoMode } : x
                          )
                        )
                      }}
                      className={cn(
                        'btn-ghost px-2 py-1 text-xs',
                        g.autoMode ? 'text-tavern-accent' : 'text-tavern-text-muted'
                      )}
                      title={g.autoMode ? '自动接力已开启' : '自动接力已关闭'}
                    >
                      {g.autoMode ? (
                        <Zap className="w-3.5 h-3.5" />
                      ) : (
                        <ZapOff className="w-3.5 h-3.5" />
                      )}
                      {g.autoMode ? '自动' : '手动'}
                    </button>
                  </div>
                </div>
              )
            })}
          </aside>

          {/* 右侧：详情 */}
          <section className="flex-1 overflow-y-auto p-4">
            {!selected ? (
              <EmptyState
                className="h-full"
                icon={<MessageSquare className="w-8 h-8" />}
                title="选择一个群聊"
                description="从左侧选择一个群聊进行编辑，或创建新的群聊"
              />
            ) : (
              <div className="max-w-3xl mx-auto space-y-4">
                {/* 名称编辑 + 自动模式 + 删除 */}
                <div className="card p-4">
                  <label className="label">群聊名称</label>
                  <input
                    type="text"
                    value={selected.name}
                    onChange={(e) => setName(e.target.value)}
                    className="input"
                    placeholder="输入群聊名称"
                  />
                  <div className="flex items-center justify-between mt-3">
                    <button
                      onClick={toggleAutoMode}
                      className={cn(
                        'btn-secondary',
                        selected.autoMode && 'text-tavern-accent'
                      )}
                    >
                      {selected.autoMode ? (
                        <Zap className="w-4 h-4" />
                      ) : (
                        <ZapOff className="w-4 h-4" />
                      )}
                      自动接力：{selected.autoMode ? '开启' : '关闭'}
                    </button>
                    <button onClick={() => setDeleteId(selected.id)} className="btn-danger">
                      <Trash2 className="w-4 h-4" />
                      删除群聊
                    </button>
                  </div>
                </div>

                {/* 成员列表 */}
                <div className="card p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="font-medium flex items-center gap-2">
                      <Users className="w-4 h-4" />
                      成员列表
                      <span className="text-xs text-tavern-text-muted">
                        （{memberCharacters.length}）
                      </span>
                    </h2>
                  </div>

                  {memberCharacters.length === 0 ? (
                    <p className="text-sm text-tavern-text-muted py-4 text-center">
                      还没有成员，从下方添加角色加入群聊
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {memberCharacters.map((c, idx) => {
                        const isSpeaker = idx === selected.currentSpeakerIndex
                        return (
                          <li
                            key={c.id}
                            className={cn(
                              'flex items-center gap-3 p-2 rounded-lg border',
                              isSpeaker
                                ? 'border-tavern-accent bg-tavern-accent-soft'
                                : 'border-tavern-border-soft'
                            )}
                          >
                            <span className="text-xs text-tavern-text-muted w-5 text-center">
                              {idx + 1}
                            </span>
                            <Avatar name={c.name} avatar={c.avatar} />
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium truncate">{c.name}</div>
                              {isSpeaker && (
                                <div className="text-xs text-tavern-accent">当前发言者</div>
                              )}
                            </div>
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => moveMember(idx, -1)}
                                disabled={idx === 0}
                                className="btn-ghost p-1.5 disabled:opacity-30 disabled:cursor-not-allowed"
                                title="上移"
                              >
                                <ArrowUp className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => moveMember(idx, 1)}
                                disabled={idx === memberCharacters.length - 1}
                                className="btn-ghost p-1.5 disabled:opacity-30 disabled:cursor-not-allowed"
                                title="下移"
                              >
                                <ArrowDown className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => removeMember(c.id)}
                                className="btn-ghost p-1.5 text-tavern-text-muted hover:text-tavern-danger"
                                title="移除"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  )}

                  {/* 添加成员 */}
                  <div className="mt-4 pt-4 border-t border-tavern-border-soft">
                    <div className="label flex items-center gap-1">
                      <UserPlus className="w-3.5 h-3.5" />
                      添加成员
                    </div>
                    {availableCharacters.length === 0 ? (
                      <p className="text-xs text-tavern-text-muted">
                        {characters.length === 0
                          ? '还没有可用角色，请先到角色管理创建角色'
                          : '所有角色已加入群聊'}
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {availableCharacters.map((c) => (
                          <button
                            key={c.id}
                            onClick={() => addMember(c.id)}
                            className="btn-secondary px-2 py-1.5 text-xs"
                          >
                            <Avatar name={c.name} avatar={c.avatar} size={18} />
                            {c.name}
                            <Plus className="w-3 h-3" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* 发言顺序 + 开始对话 */}
                <div className="card p-4">
                  <h2 className="font-medium flex items-center gap-2 mb-2">
                    <Settings2 className="w-4 h-4" />
                    发言顺序
                  </h2>
                  <p className="text-xs text-tavern-text-muted mb-3">
                    角色按列表顺序依次发言。可使用上下箭头调整顺序，点击成员设为当前发言者。
                  </p>
                  {memberCharacters.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-4">
                      {memberCharacters.map((c, idx) => (
                        <button
                          key={c.id}
                          onClick={() => setCurrentSpeaker(idx)}
                          className={cn(
                            'btn-secondary px-2 py-1 text-xs',
                            idx === selected.currentSpeakerIndex &&
                              'text-tavern-accent border-tavern-accent'
                          )}
                        >
                          {idx + 1}. {c.name}
                        </button>
                      ))}
                    </div>
                  )}
                  <button
                    onClick={startChat}
                    disabled={memberCharacters.length === 0}
                    className="btn-primary w-full disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <MessageSquare className="w-4 h-4" />
                    开始群聊对话
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        onConfirm={handleDelete}
        title="删除群聊"
        message="确定要删除这个群聊吗？此操作不可撤销。"
        confirmText="删除"
        danger
      />
    </div>
  )
}
