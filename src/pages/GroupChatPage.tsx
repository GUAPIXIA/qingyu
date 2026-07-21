import { useEffect, useState, useRef, useMemo } from 'react'
import type React from 'react'
import { nanoid } from 'nanoid'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { useCharacterStore } from '../store/useCharacterStore'
import { useGroupChatStore } from '../store/useGroupChatStore'
import { GroupChatMessage } from '../components/chat/GroupChatMessage'
import { GroupChatInput } from '../components/chat/GroupChatInput'
import { GroupMemberBar } from '../components/chat/GroupMemberBar'
import { EmptyState } from '../components/common/EmptyState'
import { ConfirmDialog } from '../components/common/ConfirmDialog'
import { cn } from '../lib/utils'
import type { GroupChat, Lorebook, Preset } from '../../shared/types'
import {
  Plus,
  Trash2,
  Users,
  ArrowUp,
  ArrowDown,
  X,
  MessageSquare,
  Settings2,
  Zap,
  ZapOff,
  Edit2,
  Check,
  AtSign,
  Repeat,
  ChevronDown,
  Download,
  BookOpen,
  FileText,
  Eye,
  Palette,
} from 'lucide-react'

export function GroupChatPage() {
  const { characters, selectCharacter } = useCharacterStore()
  const {
    groupChats, currentGroup, sessions, currentSessionId,
    messages,
    isStreaming, currentStreamingCharId, streamingContent,
    loadGroups, selectGroup, saveGroup, deleteGroup,
    createSession, switchSession, deleteSession, renameSession,
    clearChat, deleteMessage, editMessage, regenerateMessage, translateMessage,
  } = useGroupChatStore()

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [showSessionMenu, setShowSessionMenu] = useState(false)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [sessionEditTitle, setSessionEditTitle] = useState('')
  const [lorebooks, setLorebooks] = useState<Lorebook[]>([])
  const [presets, setPresets] = useState<Preset[]>([])
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const [showContextViewer, setShowContextViewer] = useState(false)
  const [contextContent, setContextContent] = useState<{ role: string; content: string }[]>([])
  const [showGreetingPicker, setShowGreetingPicker] = useState(false)

  // 初始加载
  useEffect(() => {
    loadGroups()
  }, [])

  // 如果当前群聊有成员且无消息，自动弹出开场白选择器
  useEffect(() => {
    if (currentGroup && messages.length === 0 && !isStreaming && currentGroup.memberIds.length > 0) {
      const hasGreetings = currentGroup.memberIds.some(id => {
        const char = characters.find(c => c.id === id)
        return (char?.groupOnlyGreetings && char.groupOnlyGreetings.length > 0) || char?.firstMessage
      })
      if (hasGreetings) {
        setShowGreetingPicker(true)
      }
    }
  }, [currentGroup?.id, currentSessionId, messages.length])

  const handleSelect = (group: GroupChat) => {
    setSelectedId(group.id)
    selectGroup(group.id)
  }

  const handleCreate = async () => {
    const newGroup: GroupChat = {
      id: nanoid(),
      name: '新群聊',
      memberIds: [],
      currentSpeakerIndex: 0,
      autoMode: false,
      chatMode: 'polling',
      maxRounds: 1,
      speakerInterval: 2000,
      lorebookIds: [],
      presetId: null,
      systemPrompt: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await saveGroup(newGroup)
    setSelectedId(newGroup.id)
    selectGroup(newGroup.id)
  }

  const handleDelete = async () => {
    if (!deletingId) return
    await deleteGroup(deletingId)
    setShowDeleteConfirm(false)
    setDeletingId(null)
    setSelectedId(null)
  }

  const confirmDelete = (id: string) => {
    setDeletingId(id)
    setShowDeleteConfirm(true)
  }

  const handleRename = async () => {
    if (!currentGroup || !nameDraft.trim()) return
    await saveGroup({ ...currentGroup, name: nameDraft.trim() })
    setEditingName(false)
  }

  const startEditName = () => {
    if (!currentGroup) return
    setNameDraft(currentGroup.name)
    setEditingName(true)
  }

  const handleAddMember = async (charId: string) => {
    if (!currentGroup) return
    if (currentGroup.memberIds.includes(charId)) return
    await saveGroup({
      ...currentGroup,
      memberIds: [...currentGroup.memberIds, charId],
    })
  }

  const handleRemoveMember = async (charId: string) => {
    if (!currentGroup) return
    await saveGroup({
      ...currentGroup,
      memberIds: currentGroup.memberIds.filter(id => id !== charId),
      currentSpeakerIndex: Math.min(currentGroup.currentSpeakerIndex, currentGroup.memberIds.length - 2),
    })
  }

  const handleMoveMember = async (index: number, dir: number) => {
    if (!currentGroup) return
    const newIds = [...currentGroup.memberIds]
    const target = index + dir
    if (target < 0 || target >= newIds.length) return
    ;[newIds[index], newIds[target]] = [newIds[target], newIds[index]]
    await saveGroup({ ...currentGroup, memberIds: newIds })
  }

  // 会话操作
  const handleSessionRename = async () => {
    if (!currentGroup || !editingSessionId || !sessionEditTitle.trim()) return
    await renameSession(currentGroup.id, editingSessionId, sessionEditTitle.trim())
    setEditingSessionId(null)
  }

  const handleSessionDelete = async (sessionId: string) => {
    if (!currentGroup) return
    await deleteSession(currentGroup.id, sessionId)
  }

  // 世界书/预设
  const openSettings = async () => {
    setShowSettings(true)
    try {
      const [lbs, prs] = await Promise.all([
        window.api.lorebook.list(),
        window.api.preset.list(),
      ])
      setLorebooks(lbs)
      setPresets(prs)
    } catch { /* ignore */ }
  }

  const toggleLorebook = async (id: string) => {
    if (!currentGroup) return
    const ids = currentGroup.lorebookIds.includes(id)
      ? currentGroup.lorebookIds.filter(lid => lid !== id)
      : [...currentGroup.lorebookIds, id]
    await saveGroup({ ...currentGroup, lorebookIds: ids })
  }

  // 导出
  const handleExport = async () => {
    if (!currentGroup || !currentSessionId) return
    try {
      const content = await window.api.group.exportChat(currentGroup.id, currentSessionId, 'md')
      const blob = new Blob([content], { type: 'text/markdown' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${currentGroup.name}-群聊.md`
      a.click()
      URL.revokeObjectURL(url)
    } catch { /* ignore */ }
  }

  const availableChars = characters.filter(c => !currentGroup?.memberIds.includes(c.id))

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* ============ 左栏：群聊列表 ============ */}
      <aside className="w-64 border-r border-tavern-border-soft bg-tavern-bg-soft flex flex-col shrink-0">
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-tavern-border-soft">
          <span className="text-xs font-medium text-tavern-text-muted">群聊列表</span>
          <button
            onClick={handleCreate}
            className="btn-ghost p-1 rounded-lg hover:bg-tavern-accent-soft hover:text-tavern-accent"
            title="新建群聊"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-1">
          {groupChats.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-tavern-text-muted">
              暂无群聊，点击 + 创建
            </div>
          ) : (
            groupChats.map(g => (
              <div
                key={g.id}
                onClick={() => handleSelect(g)}
                role="button"
                tabIndex={0}
                onKeyDown={e => e.key === 'Enter' && handleSelect(g)}
                className={cn(
                  'w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-tavern-bg-hover transition-colors group cursor-pointer',
                  selectedId === g.id && 'bg-tavern-accent-soft border-r-2'
                )}
                style={selectedId === g.id && g.themeColor ? { borderRightColor: g.themeColor } : undefined}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-tavern-text truncate flex items-center gap-1.5">
                    {g.themeColor && (
                      <span
                        className="w-2 h-2 rounded-full shrink-0 inline-block"
                        style={{ backgroundColor: g.themeColor }}
                      />
                    )}
                    {g.name}
                  </div>
                  <div className="text-[10px] text-tavern-text-muted">
                    {g.memberIds.length} 位成员
                    {g.autoMode && ' · 自动'}
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); confirmDelete(g.id) }}
                  className="p-1 rounded hover:bg-tavern-danger/20 text-tavern-text-muted hover:text-tavern-danger transition-all"
                  title="删除群聊"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* ============ 右栏：群聊对话或配置 ============ */}
      <main
        className="flex-1 flex flex-col overflow-hidden bg-tavern-bg relative"
        style={currentGroup?.themeColor ? { '--gc-theme': currentGroup.themeColor } as React.CSSProperties : undefined}
      >
        {/* 聊天背景 */}
        {currentGroup?.chatBackgroundParams && (
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              opacity: currentGroup.chatBackgroundParams.opacity ?? 0,
              filter: `blur(${currentGroup.chatBackgroundParams.blur ?? 0}px)`,
              background: currentGroup.chatBackgroundParams.type === 'gradient'
                ? (currentGroup.chatBackgroundParams.gradient || undefined)
                : currentGroup.chatBackground
                  ? `url(${currentGroup.chatBackground}) center/cover no-repeat`
                  : undefined,
            }}
          />
        )}
        {!currentGroup ? (
          <div className="flex-1 flex items-center justify-center">
            <EmptyState
              icon={<Users className="w-8 h-8" />}
              title="选择一个群聊"
              description="从左侧选择已有群聊，或创建新的群聊"
              action={
                <button onClick={handleCreate} className="btn-primary">
                  <Plus className="w-4 h-4" />
                  新建群聊
                </button>
              }
            />
          </div>
        ) : (
          <>
            {/* ---- 顶栏 ---- */}
            <header
              className="flex items-center justify-between px-4 h-12 border-b border-tavern-border-soft bg-tavern-bg-soft shrink-0"
              style={currentGroup?.themeColor ? { borderBottomColor: currentGroup.themeColor, borderBottomWidth: '2px' } : undefined}
            >
              <div className="flex items-center gap-2 min-w-0">
                {editingName ? (
                  <div className="flex items-center gap-1">
                    <input
                      value={nameDraft}
                      onChange={e => setNameDraft(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleRename()}
                      className="w-32 bg-tavern-bg border border-tavern-border rounded px-2 py-0.5 text-sm text-tavern-text outline-none focus:border-tavern-accent"
                      autoFocus
                      onBlur={handleRename}
                    />
                    <button onClick={handleRename} className="p-1 text-tavern-accent">
                      <Check className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : (
                  <>
                    <h2 className="font-display text-sm font-bold text-tavern-text truncate">{currentGroup.name}</h2>
                    <button onClick={startEditName} className="p-1 text-tavern-text-muted hover:text-tavern-text">
                      <Edit2 className="w-3 h-3" />
                    </button>
                  </>
                )}

                {/* ---- 会话管理下拉 ---- */}
                {sessions.length > 0 && (
                  <div className="relative">
                    <button
                      onClick={() => setShowSessionMenu(!showSessionMenu)}
                      className="flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-tavern-bg-hover text-tavern-text-muted hover:text-tavern-text transition-colors"
                    >
                      {sessions.find(s => s.id === currentSessionId)?.title ?? '会话'}
                      <ChevronDown className="w-3 h-3" />
                    </button>

                    {showSessionMenu && (
                      <>
                        <div className="fixed inset-0 z-20" onClick={() => setShowSessionMenu(false)} />
                        <div className="absolute top-full left-0 mt-1 w-56 bg-tavern-bg-card border border-tavern-border rounded-xl shadow-xl z-40 py-1 overflow-hidden">
                          {sessions.map(s => (
                            <div key={s.id} className="group flex items-center gap-1 px-2 py-1.5 hover:bg-tavern-bg-hover">
                              {editingSessionId === s.id ? (
                                <input
                                  value={sessionEditTitle}
                                  onChange={e => setSessionEditTitle(e.target.value)}
                                  onKeyDown={e => {
                                    if (e.key === 'Enter') handleSessionRename()
                                    if (e.key === 'Escape') setEditingSessionId(null)
                                  }}
                                  onBlur={handleSessionRename}
                                  className="flex-1 bg-tavern-bg border border-tavern-border rounded px-1.5 py-0.5 text-xs text-tavern-text outline-none focus:border-tavern-accent"
                                  autoFocus
                                />
                              ) : (
                                <button
                                  onClick={() => { switchSession(currentGroup.id, s.id); setShowSessionMenu(false) }}
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
                                onClick={() => {
                                  setEditingSessionId(s.id)
                                  setSessionEditTitle(s.title)
                                }}
                                className="opacity-0 group-hover:opacity-100 p-0.5 text-tavern-text-muted hover:text-tavern-text"
                                title="重命名"
                              >
                                <Edit2 className="w-3 h-3" />
                              </button>
                              {sessions.length > 1 && (
                                <button
                                  onClick={() => handleSessionDelete(s.id)}
                                  className="opacity-0 group-hover:opacity-100 p-0.5 text-tavern-text-muted hover:text-tavern-danger"
                                  title="删除"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              )}
                            </div>
                          ))}
                          <div className="border-t border-tavern-border-soft pt-1 mt-1">
                            <button
                              onClick={() => { createSession(currentGroup.id); setShowSessionMenu(false) }}
                              className="w-full text-left px-3 py-1.5 text-xs text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover"
                            >
                              <Plus className="w-3 h-3 inline mr-1" />新建会话
                            </button>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-1">
                {/* Token 总量 */}
                {(() => {
                  const totalTokens = messages.reduce((sum, m) => sum + (m.tokenUsage?.totalTokens ?? 0), 0)
                  if (totalTokens > 0) {
                    return (
                      <span className="text-[10px] text-tavern-text-muted px-1.5 py-0.5 rounded bg-tavern-bg-hover">
                        {(totalTokens / 1000).toFixed(1)}k tokens
                      </span>
                    )
                  }
                  return null
                })()}
                <button
                  onClick={() => {
                    const ctx = useGroupChatStore.getState().buildGroupContext()
                    setContextContent(ctx)
                    setShowContextViewer(true)
                  }}
                  className="btn-ghost p-1.5 text-xs text-tavern-text-muted hover:text-tavern-text"
                  title="查看上下文"
                >
                  <Eye className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => clearChat(currentGroup.id)}
                  className="btn-ghost p-1.5 text-xs text-tavern-text-muted hover:text-tavern-danger"
                  title="清空聊天"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => openSettings()}
                  className="btn-ghost p-1.5 text-xs text-tavern-text-muted hover:text-tavern-text"
                  title="群聊设置"
                >
                  <Settings2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </header>

            {/* ---- 消息区域 ---- */}
            <div className="flex-1 overflow-hidden">
              {messages.length === 0 && !isStreaming ? (
                <div className="flex items-center justify-center h-full text-xs text-tavern-text-muted">
                  <div className="text-center">
                    <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    <p>选择成员并开始群聊对话</p>
                  </div>
                </div>
              ) : (
                <Virtuoso
                  ref={virtuosoRef}
                  data={messages}
                  className="h-full"
                  followOutput="smooth"
                  itemContent={(index, m) => {
                    const memberIdx = currentGroup.memberIds.indexOf(m.characterId)
                    const isAiMsg = m.characterId !== '__user__'
                    return (
                      <GroupChatMessage
                        key={m.id}
                        message={m}
                        memberIndex={memberIdx}
                        onDelete={
                          !currentSessionId ? undefined : () => deleteMessage(currentGroup.id, currentSessionId!, m.id)
                        }
                        onEdit={
                          !currentSessionId ? undefined : (content: string) => editMessage(currentGroup.id, currentSessionId!, m.id, content)
                        }
                        onRegenerate={
                          isAiMsg && !isStreaming ? () => regenerateMessage(m.id) : undefined
                        }
                        onTranslate={
                          !isStreaming ? () => translateMessage(m.id) : undefined
                        }
                      />
                    )
                  }}
                  components={{
                    Footer: () => (
                      <>
                        {isStreaming && streamingContent && currentStreamingCharId && (
                          <GroupChatMessage
                            message={{
                              id: '__streaming__',
                              groupId: currentGroup.id,
                              characterId: currentStreamingCharId,
                              content: streamingContent,
                              images: [],
                              timestamp: Date.now(),
                              round: messages.length > 0 ? messages[messages.length - 1].round : 1,
                            }}
                            memberIndex={currentGroup.memberIds.indexOf(currentStreamingCharId)}
                          />
                        )}
                        {isStreaming && !streamingContent && (
                          <div className="flex items-center gap-2 px-4 py-3">
                            <div className="w-8 h-8 rounded-full bg-tavern-bg-hover animate-pulse" />
                            <div className="flex gap-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-tavern-accent animate-bounce" style={{ animationDelay: '0ms' }} />
                              <span className="w-1.5 h-1.5 rounded-full bg-tavern-accent animate-bounce" style={{ animationDelay: '150ms' }} />
                              <span className="w-1.5 h-1.5 rounded-full bg-tavern-accent animate-bounce" style={{ animationDelay: '300ms' }} />
                            </div>
                          </div>
                        )}
                        <div className="h-4" />
                      </>
                    ),
                  }}
                />
              )}
            </div>

            {/* ---- 输入区 ---- */}
            <GroupChatInput group={currentGroup} />

            {/* ---- 成员栏 ---- */}
            <GroupMemberBar
              memberIds={currentGroup.memberIds}
              currentSpeakerIndex={currentGroup.currentSpeakerIndex}
              themeColor={currentGroup.themeColor}
              onSpeakerClick={(charId) => {
                selectCharacter(charId)
              }}
            />
          </>
        )}
      </main>

      {/* ============ 群聊设置弹窗 ============ */}
      {showSettings && currentGroup && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowSettings(false)} />
          <div className="fixed right-0 top-0 bottom-0 w-80 z-50 bg-tavern-bg-card border-l border-tavern-border shadow-2xl overflow-y-auto">
            <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 bg-tavern-bg-card/90 backdrop-blur border-b border-tavern-border-soft">
              <h3 className="text-sm font-semibold text-tavern-text">群聊设置</h3>
              <button className="btn-ghost p-1.5" onClick={() => setShowSettings(false)}>
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-5">
              {/* 成员管理 */}
              <div>
                <label className="label">成员管理</label>
                <div className="space-y-1 mt-1">
                  {currentGroup.memberIds.map((id, idx) => {
                    const char = characters.find(c => c.id === id)
                    if (!char) return null
                    return (
                      <div key={id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-tavern-bg-soft text-sm">
                        <span className="w-5 text-xs text-tavern-text-muted text-center">{idx + 1}</span>
                        {char.avatar ? (
                          <img src={char.avatar} className="w-6 h-6 rounded-full object-cover" alt="" />
                        ) : (
                          <div className="w-6 h-6 rounded-full bg-tavern-bg-hover flex items-center justify-center text-[10px] font-bold">
                            {char.translatedContent?.name?.[0] ?? char.name[0]}
                          </div>
                        )}
                        <span className="flex-1 text-sm truncate">{char.translatedContent?.name ?? char.name}</span>
                        {idx === currentGroup.currentSpeakerIndex && (
                          <span className="text-[10px] text-tavern-accent">当前</span>
                        )}
                        <button onClick={() => handleMoveMember(idx, -1)} disabled={idx === 0} className="p-0.5 text-tavern-text-muted hover:text-tavern-text disabled:opacity-30">
                          <ArrowUp className="w-3 h-3" />
                        </button>
                        <button onClick={() => handleMoveMember(idx, 1)} disabled={idx === currentGroup.memberIds.length - 1} className="p-0.5 text-tavern-text-muted hover:text-tavern-text disabled:opacity-30">
                          <ArrowDown className="w-3 h-3" />
                        </button>
                        <button onClick={() => handleRemoveMember(id)} className="p-0.5 text-tavern-text-muted hover:text-tavern-danger">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )
                  })}
                </div>

                {availableChars.length > 0 && (
                  <div className="mt-2">
                    <select
                      onChange={e => { if (e.target.value) handleAddMember(e.target.value); e.target.value = '' }}
                      className="w-full bg-tavern-bg border border-tavern-border-soft rounded-lg px-2.5 py-1.5 text-xs text-tavern-text outline-none focus:border-tavern-accent"
                      defaultValue=""
                    >
                      <option value="" disabled>+ 添加成员...</option>
                      {availableChars.map(c => (
                        <option key={c.id} value={c.id}>{c.translatedContent?.name ?? c.name}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {/* 世界书 */}
              {lorebooks.length > 0 && (
                <div>
                  <label className="label">
                    <span className="inline-flex items-center gap-1.5">
                      <BookOpen className="w-3.5 h-3.5" />世界书
                    </span>
                  </label>
                  <div className="space-y-0.5 mt-1 max-h-40 overflow-y-auto">
                    {lorebooks.map(lb => (
                      <label
                        key={lb.id}
                        className={cn(
                          'flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs cursor-pointer transition-colors',
                          currentGroup.lorebookIds.includes(lb.id)
                            ? 'bg-tavern-accent-soft/50 text-tavern-accent'
                            : 'hover:bg-tavern-bg-hover text-tavern-text-muted'
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={currentGroup.lorebookIds.includes(lb.id)}
                          onChange={() => toggleLorebook(lb.id)}
                          className="w-3.5 h-3.5 accent-tavern-accent rounded"
                        />
                        <span className="truncate">{lb.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* 预设 */}
              {presets.length > 0 && (
                <div>
                  <label className="label">
                    <span className="inline-flex items-center gap-1.5">
                      <FileText className="w-3.5 h-3.5" />预设
                    </span>
                  </label>
                  <select
                    value={currentGroup.presetId ?? ''}
                    onChange={e => saveGroup({ ...currentGroup, presetId: e.target.value || null })}
                    className="w-full mt-1 bg-tavern-bg border border-tavern-border-soft rounded-lg px-2.5 py-1.5 text-xs text-tavern-text outline-none focus:border-tavern-accent"
                  >
                    <option value="">无预设</option>
                    {presets.map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* 对话模式 */}
              <div>
                <label className="label">对话模式</label>
                <div className="grid grid-cols-3 gap-1.5 mt-1">
                  {([
                    { key: 'mention' as const, label: '@点名', icon: AtSign },
                    { key: 'polling' as const, label: '轮询', icon: Repeat },
                    { key: 'free' as const, label: '自由', icon: Zap },
                  ]).map(m => {
                    const Icon = m.icon
                    return (
                      <button
                        key={m.key}
                        onClick={() => saveGroup({ ...currentGroup, chatMode: m.key })}
                        className={cn(
                          'flex flex-col items-center gap-0.5 px-2 py-2 rounded-lg border text-xs transition-colors',
                          currentGroup.chatMode === m.key
                            ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent'
                            : 'border-tavern-border-soft text-tavern-text-muted hover:border-tavern-border'
                        )}
                      >
                        <Icon className="w-3.5 h-3.5" />
                        {m.label}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* polling 模式配置 */}
              {currentGroup.chatMode === 'polling' && (
                <>
                  <div className="flex items-center justify-between">
                    <label className="label">自动接力</label>
                    <button
                      onClick={() => saveGroup({ ...currentGroup, autoMode: !currentGroup.autoMode })}
                      className={cn(
                        'px-3 py-1 rounded-lg text-xs font-medium transition-colors',
                        currentGroup.autoMode
                          ? 'bg-tavern-success/20 text-tavern-success'
                          : 'bg-tavern-bg-hover text-tavern-text-muted'
                      )}
                    >
                      {currentGroup.autoMode ? <Zap className="w-3.5 h-3.5 inline mr-0.5" /> : <ZapOff className="w-3.5 h-3.5 inline mr-0.5" />}
                      {currentGroup.autoMode ? '开启' : '关闭'}
                    </button>
                  </div>

                  <div>
                    <label className="label">
                      最大轮数 <span className="text-xs text-tavern-text-muted ml-1">{currentGroup.maxRounds}</span>
                    </label>
                    <input
                      type="range"
                      min="1"
                      max="5"
                      step="1"
                      value={currentGroup.maxRounds}
                      onChange={e => saveGroup({ ...currentGroup, maxRounds: Number(e.target.value) })}
                      className="w-full accent-tavern-accent"
                    />
                  </div>

                  <div>
                    <label className="label">
                      发言间隔 <span className="text-xs text-tavern-text-muted ml-1">{currentGroup.speakerInterval}ms</span>
                    </label>
                    <input
                      type="range"
                      min="500"
                      max="5000"
                      step="500"
                      value={currentGroup.speakerInterval}
                      onChange={e => saveGroup({ ...currentGroup, speakerInterval: Number(e.target.value) })}
                      className="w-full accent-tavern-accent"
                    />
                  </div>
                </>
              )}

              {/* 自定义 System Prompt */}
              <div>
                <label className="label">自定义 System Prompt</label>
                <textarea
                  value={currentGroup.systemPrompt}
                  onChange={e => {
                    const updated = { ...currentGroup, systemPrompt: e.target.value }
                    useGroupChatStore.setState({ currentGroup: updated })
                  }}
                  onBlur={(e) => saveGroup({ ...currentGroup, systemPrompt: e.target.value })}
                  rows={4}
                  placeholder="可选：为群聊添加上下文提示..."
                  className="w-full bg-tavern-bg border border-tavern-border-soft rounded-lg px-2.5 py-1.5 text-xs text-tavern-text outline-none focus:border-tavern-accent resize-none placeholder:text-tavern-text-muted/50"
                />
              </div>

              {/* 导出 */}
              <div>
                <button onClick={handleExport} className="w-full btn-secondary text-sm flex items-center justify-center gap-1.5">
                  <Download className="w-3.5 h-3.5" />
                  导出对话
                </button>
              </div>

              {/* 背景设置 */}
              <div>
                <label className="label">聊天背景</label>
                <div className="space-y-2 mt-1">
                  {/* 不透明度 */}
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-tavern-text-muted w-10">不透明度</span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="5"
                      value={Math.round((currentGroup.chatBackgroundParams?.opacity ?? 0.3) * 100)}
                      onChange={e => saveGroup({
                        ...currentGroup,
                        chatBackgroundParams: {
                          ...currentGroup.chatBackgroundParams,
                          opacity: Number(e.target.value) / 100,
                          type: currentGroup.chatBackgroundParams?.type ?? 'gradient',
                          blur: currentGroup.chatBackgroundParams?.blur ?? 0,
                        },
                      })}
                      className="flex-1 accent-tavern-accent"
                    />
                    <span className="text-[10px] text-tavern-text-muted w-8 text-right">
                      {Math.round((currentGroup.chatBackgroundParams?.opacity ?? 0.3) * 100)}%
                    </span>
                  </div>

                  {/* 模糊度 */}
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-tavern-text-muted w-10">模糊</span>
                    <input
                      type="range"
                      min="0"
                      max="20"
                      step="1"
                      value={currentGroup.chatBackgroundParams?.blur ?? 0}
                      onChange={e => saveGroup({
                        ...currentGroup,
                        chatBackgroundParams: {
                          ...currentGroup.chatBackgroundParams,
                          blur: Number(e.target.value),
                          type: currentGroup.chatBackgroundParams?.type ?? 'gradient',
                          opacity: currentGroup.chatBackgroundParams?.opacity ?? 0.3,
                        },
                      })}
                      className="flex-1 accent-tavern-accent"
                    />
                    <span className="text-[10px] text-tavern-text-muted w-8 text-right">{currentGroup.chatBackgroundParams?.blur ?? 0}px</span>
                  </div>

                  {/* 预设渐变 */}
                  <div className="flex flex-wrap gap-1">
                    {[
                      { name: '无', value: '' },
                      { name: '日落', value: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' },
                      { name: '海洋', value: 'linear-gradient(135deg, #0c3483 0%, #a2b6df 100%)' },
                      { name: '樱花', value: 'linear-gradient(135deg, #f5af19 0%, #f12711 100%)' },
                      { name: '森林', value: 'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)' },
                      { name: '暗夜', value: 'linear-gradient(135deg, #141e30 0%, #243b55 100%)' },
                    ].map(g => (
                      <button
                        key={g.name}
                        onClick={() => saveGroup({
                          ...currentGroup,
                          chatBackgroundParams: {
                            ...currentGroup.chatBackgroundParams,
                            type: 'gradient',
                            gradient: g.value || undefined,
                            opacity: currentGroup.chatBackgroundParams?.opacity ?? 0.3,
                            blur: currentGroup.chatBackgroundParams?.blur ?? 0,
                          },
                        })}
                        className={cn(
                          'px-2 py-1 text-[10px] rounded border transition-colors',
                          (currentGroup.chatBackgroundParams?.gradient ?? '') === (g.value ?? '')
                            ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent'
                            : 'border-tavern-border-soft text-tavern-text-muted hover:border-tavern-border'
                        )}
                      >
                        {g.name}
                      </button>
                    ))}
                  </div>

                  {/* 自定义图片 */}
                  <button
                    onClick={async () => {
                      const path = await window.api.file.selectImage()
                      if (!path) return
                      const base64 = await window.api.file.readImageAsBase64(path)
                      saveGroup({
                        ...currentGroup,
                        chatBackground: base64,
                        chatBackgroundParams: {
                          ...currentGroup.chatBackgroundParams,
                          type: 'image',
                          opacity: currentGroup.chatBackgroundParams?.opacity ?? 0.6,
                          blur: currentGroup.chatBackgroundParams?.blur ?? 0,
                        },
                      })
                    }}
                    className="w-full btn-ghost text-xs py-1.5"
                  >
                    + 选择背景图片
                  </button>
                  {currentGroup.chatBackground && currentGroup.chatBackgroundParams?.type === 'image' && (
                    <button
                      onClick={() => saveGroup({
                        ...currentGroup,
                        chatBackground: undefined,
                        chatBackgroundParams: {
                          ...currentGroup.chatBackgroundParams,
                          type: 'gradient',
                        },
                      })}
                      className="w-full btn-ghost text-xs py-1 text-tavern-danger"
                    >
                      移除背景图片
                    </button>
                  )}
                </div>
              </div>

              {/* 主题色 */}
              <div>
                <label className="label">
                  <span className="inline-flex items-center gap-1.5">
                    <Palette className="w-3.5 h-3.5" />主题色
                  </span>
                </label>
                <div className="flex items-center gap-2 mt-1">
                  <input
                    type="color"
                    value={currentGroup.themeColor || '#6366f1'}
                    onChange={e => saveGroup({ ...currentGroup, themeColor: e.target.value || undefined })}
                    className="w-8 h-8 rounded cursor-pointer border-0 p-0 bg-transparent"
                  />
                  <span className="text-xs text-tavern-text-muted">
                    {currentGroup.themeColor || '默认'}
                  </span>
                  {currentGroup.themeColor && (
                    <button
                      onClick={() => saveGroup({ ...currentGroup, themeColor: undefined })}
                      className="text-[10px] text-tavern-text-muted hover:text-tavern-text"
                    >
                      重置
                    </button>
                  )}
                </div>
                {/* 预设颜色 */}
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#8b5cf6', '#06b6d4', '#ef4444', '#84cc16'].map(c => (
                    <button
                      key={c}
                      onClick={() => saveGroup({ ...currentGroup, themeColor: c })}
                      className={cn(
                        'w-6 h-6 rounded-full border-2 transition-all',
                        currentGroup.themeColor === c
                          ? 'border-white scale-110 shadow-md'
                          : 'border-transparent hover:scale-110'
                      )}
                      style={{ backgroundColor: c }}
                      title={c}
                    />
                  ))}
                </div>
              </div>

              {/* 删除群聊 */}
              <div className="pt-2 border-t border-tavern-border-soft">
                <button
                  onClick={() => { setShowSettings(false); confirmDelete(currentGroup.id) }}
                  className="w-full btn-ghost text-sm text-tavern-danger py-2"
                >
                  删除群聊
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ============ 删除确认 ============ */}
      <ConfirmDialog
        open={showDeleteConfirm}
        title="删除群聊"
        message="确定要删除此群聊吗？所有群聊对话数据将被清除，此操作不可撤销。"
        onConfirm={handleDelete}
        onClose={() => { setShowDeleteConfirm(false); setDeletingId(null) }}
      />

      {/* ============ 上下文查看器 ============ */}
      {showContextViewer && (
        <>
          <div className="fixed inset-0 z-50 bg-black/50" onClick={() => setShowContextViewer(false)} />
          <div className="fixed inset-4 z-50 bg-tavern-bg-card border border-tavern-border rounded-2xl shadow-2xl overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-tavern-border-soft bg-tavern-bg-soft">
              <h3 className="text-sm font-semibold text-tavern-text">上下文查看器</h3>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-tavern-text-muted">{contextContent.length} 条消息</span>
                <button onClick={() => setShowContextViewer(false)} className="btn-ghost p-1.5">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {contextContent.map((item, i) => (
                <div key={i} className="space-y-1">
                  <span className={cn(
                    'text-[10px] font-medium px-1.5 py-0.5 rounded',
                    item.role === 'system' ? 'bg-purple-500/10 text-purple-400' :
                    item.role === 'user' ? 'bg-blue-500/10 text-blue-400' :
                    'bg-emerald-500/10 text-emerald-400'
                  )}>
                    {item.role.toUpperCase()}
                  </span>
                  <pre className="text-xs text-tavern-text whitespace-pre-wrap font-mono bg-tavern-bg rounded-lg p-3 max-h-40 overflow-y-auto border border-tavern-border-soft/50">
                    {item.content}
                  </pre>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ============ 群聊开场白选择弹窗 ============ */}
      {showGreetingPicker && currentGroup && messages.length === 0 && !isStreaming && (() => {
        const memberGreetings: { charId: string; charName: string; avatar?: string; greetings: string[] }[] = []
        currentGroup.memberIds.forEach(id => {
          const char = characters.find(c => c.id === id)
          const displayName = char?.translatedContent?.name ?? char?.name ?? ''
          if (char?.groupOnlyGreetings && char.groupOnlyGreetings.length > 0) {
            memberGreetings.push({ charId: id, charName: displayName, avatar: char.avatar, greetings: char.groupOnlyGreetings })
          } else if (char?.firstMessage) {
            const displayFirstMsg = char.translatedContent?.firstMessage ?? char.firstMessage
            memberGreetings.push({ charId: id, charName: displayName, avatar: char.avatar, greetings: [displayFirstMsg] })
          }
        })
        if (memberGreetings.length === 0) return null

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in p-4">
            <div className="card w-[560px] max-w-full max-h-[85vh] flex flex-col overflow-hidden shadow-2xl">
              {/* 头部 */}
              <div className="flex items-center gap-3 p-5 border-b border-tavern-border-soft bg-tavern-bg-soft shrink-0">
                <div
                  className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 bg-tavern-accent-soft text-tavern-accent"
                  style={currentGroup.themeColor ? { backgroundColor: `${currentGroup.themeColor}20`, color: currentGroup.themeColor } : undefined}
                >
                  <Users className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-display font-bold text-lg truncate">{currentGroup.name}</h3>
                  <p className="text-xs text-tavern-text-muted">
                    选择一个开场白开始群聊对话 · {memberGreetings.length} 位角色
                  </p>
                </div>
                <button
                  onClick={() => setShowGreetingPicker(false)}
                  className="btn-ghost p-1.5 rounded-lg shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* 开场白列表 */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {memberGreetings.map((member) => (
                  <div key={member.charId} className="space-y-1.5">
                    {/* 角色名 */}
                    <div className="flex items-center gap-2 px-1">
                      {member.avatar ? (
                        <img src={member.avatar} className="w-5 h-5 rounded-full object-cover" alt="" />
                      ) : (
                        <div className="w-5 h-5 rounded-full bg-tavern-bg-hover flex items-center justify-center text-[10px] font-bold text-tavern-text-muted">
                          {member.charName[0]}
                        </div>
                      )}
                      <span className="text-xs font-medium text-tavern-text">{member.charName}</span>
                      <span className="text-[10px] text-tavern-text-muted">{member.greetings.length} 条开场白</span>
                    </div>
                    {/* 该角色的所有开场白 */}
                    {member.greetings.map((greeting, gi) => (
                      <button
                        key={`${member.charId}-${gi}`}
                        onClick={async () => {
                          setShowGreetingPicker(false)
                          if (!currentSessionId) return
                          const { sendMessage } = useGroupChatStore.getState()
                          await sendMessage(greeting, [], member.charId)
                        }}
                        className="w-full text-left px-3 py-2.5 rounded-lg border border-tavern-border-soft hover:bg-tavern-accent-soft/30 text-xs text-tavern-text transition-all group"
                        style={currentGroup.themeColor ? { ['--gc-theme' as string]: currentGroup.themeColor } : undefined}
                      >
                        <span className="text-tavern-text-muted text-[10px] block mb-0.5">
                          {member.greetings.length > 1 ? `开场白 #${gi + 1}` : '开场白'}
                        </span>
                        <span className="line-clamp-3 whitespace-pre-wrap">{greeting}</span>
                        <div className="mt-2 text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                          style={currentGroup.themeColor ? { color: currentGroup.themeColor } : undefined}>
                          点击以 {member.charName} 的身份发送此开场白
                        </div>
                      </button>
                    ))}
                  </div>
                ))}
              </div>

              {/* 底部 */}
              <div className="flex items-center justify-between gap-2 p-4 border-t border-tavern-border-soft bg-tavern-bg-soft shrink-0">
                <span className="text-xs text-tavern-text-muted">
                  点击任意开场白开始群聊，或
                </span>
                <button
                  className="btn-secondary text-xs"
                  onClick={() => setShowGreetingPicker(false)}
                >
                  跳过，手动开始
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* 空状态时不显示弹窗的自动触发提示：如果没有消息，自动弹出选择器 */}
      {currentGroup && messages.length === 0 && !isStreaming && !showGreetingPicker && (() => {
        const hasGreetings = currentGroup.memberIds.some(id => {
          const char = characters.find(c => c.id === id)
          return (char?.groupOnlyGreetings && char.groupOnlyGreetings.length > 0) || char?.firstMessage
        })
        if (!hasGreetings) return null
        return (
          <div className="absolute bottom-32 left-1/2 -translate-x-1/2 z-10">
            <button
              onClick={() => setShowGreetingPicker(true)}
              className="px-4 py-2 rounded-xl text-white text-xs font-medium shadow-lg hover:shadow-xl transition-all bg-tavern-accent"
              style={currentGroup.themeColor ? { backgroundColor: currentGroup.themeColor } : undefined}
            >
              选择开场白
            </button>
          </div>
        )
      })()}
    </div>
  )
}
