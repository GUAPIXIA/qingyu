import { useEffect, useState, useRef } from 'react'
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
import { Modal } from '../components/common/Modal'
import { SessionSwitcher } from '../components/common/SessionSwitcher'
import { GroupChatSettingsPanel } from '../components/chat/GroupChatSettingsPanel'
import { MemoryPanel } from '../components/chat/MemoryPanel'
import { cn } from '../lib/utils'
import { downloadFile } from '../utils/download'
import type { GroupChat, GroupMessage, Lorebook, Preset } from '../../shared/types'
import {
  Plus,
  Trash2,
  Users,
  MessageSquare,
  Settings2,
  Edit2,
  Check,
  Eye,
  Search,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react'

export function GroupChatPage() {
  const { characters } = useCharacterStore()
  const {
    groupChats, currentGroup, sessions, currentSessionId,
    messages,
    isStreaming,
    loadGroups, selectGroup, saveGroup, deleteGroup,
    createSession, switchSession, deleteSession, renameSession,
    clearChat, deleteMessage, editMessage, regenerateMessage, translateMessage,
    sendPollingRound,
    toggleMemory, setMemoryMode, triggerMemorySummary,
  } = useGroupChatStore()

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [lorebooks, setLorebooks] = useState<Lorebook[]>([])
  const [presets, setPresets] = useState<Preset[]>([])
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const [showContextViewer, setShowContextViewer] = useState(false)
  const [contextContent, setContextContent] = useState<{ role: string; content: string }[]>([])
  const [showGreetingPicker, setShowGreetingPicker] = useState(false)
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [replyToMessage, setReplyToMessage] = useState<GroupMessage | null>(null)
  const [showMemoryPanel, setShowMemoryPanel] = useState(false)
  const [memoryInterval, setMemoryInterval] = useState(10)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([])
  const [memberSearch, setMemberSearch] = useState('')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

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

  const handleCreate = () => {
    setSelectedMemberIds([])
    setMemberSearch('')
    setShowCreateModal(true)
  }

  /** 切换角色选中状态 */
  const toggleMemberSelect = (charId: string) => {
    setSelectedMemberIds(prev =>
      prev.includes(charId) ? prev.filter(id => id !== charId) : [...prev, charId]
    )
  }

  /** 确认创建群聊：群聊名称按角色名逐个拼接 */
  const confirmCreate = async () => {
    if (selectedMemberIds.length === 0) return
    const memberNames = selectedMemberIds
      .map(id => characters.find(c => c.id === id)?.name ?? '未知')
      .join('、')
    const newGroup: GroupChat = {
      id: nanoid(),
      name: memberNames,
      memberIds: [...selectedMemberIds],
      currentSpeakerIndex: 0,
      autoMode: false,
      chatMode: 'polling',
      maxRounds: 1,
      speakerInterval: 2000,
      lorebookIds: [],
      presetId: 'builtin-default',
      systemPrompt: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await saveGroup(newGroup)
    setSelectedId(newGroup.id)
    selectGroup(newGroup.id)
    setShowCreateModal(false)
    setSelectedMemberIds([])
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
      // L-02 修复：确保 currentSpeakerIndex 不为负数
      currentSpeakerIndex: Math.max(0, Math.min(currentGroup.currentSpeakerIndex, currentGroup.memberIds.length - 2)),
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
      downloadFile(content, `${currentGroup.name}-群聊.md`)
    } catch { /* ignore */ }
  }

  // 角色搜索过滤
  const filteredCharacters = memberSearch.trim()
    ? characters.filter(c =>
        c.name.toLowerCase().includes(memberSearch.toLowerCase()) ||
        (c.description && c.description.toLowerCase().includes(memberSearch.toLowerCase())) ||
        (c.tags && c.tags.some(t => t.toLowerCase().includes(memberSearch.toLowerCase())))
      )
    : characters

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* ============ 左栏：群聊列表（可收起） ============ */}
      <aside className={cn(
        'border-r border-tavern-border-soft bg-tavern-bg-soft flex flex-col shrink-0 transition-all duration-200',
        sidebarCollapsed ? 'w-0 overflow-hidden' : 'w-64'
      )}>
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-tavern-border-soft">
          <span className="text-xs font-medium text-tavern-text-muted">群聊列表</span>
          <div className="flex items-center gap-0.5">
            <button
              onClick={handleCreate}
              className="btn-ghost p-1 rounded-lg hover:bg-tavern-accent-soft hover:text-tavern-accent"
              title="新建群聊"
            >
              <Plus className="w-4 h-4" />
            </button>
            <button
              onClick={() => setSidebarCollapsed(true)}
              className="btn-ghost p-1 rounded-lg hover:bg-tavern-bg-hover text-tavern-text-muted"
              title="收起列表"
            >
              <PanelLeftClose className="w-4 h-4" />
            </button>
          </div>
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
        {/* 收起状态下的展开按钮（始终可见，放在 main 顶部不遮挡内容） */}
        {sidebarCollapsed && !currentGroup && (
          <button
            onClick={() => setSidebarCollapsed(false)}
            className="absolute top-2 left-2 z-30 p-1.5 rounded-lg bg-tavern-bg-soft border border-tavern-border-soft text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover transition-colors shadow-sm"
            title="展开群聊列表"
          >
            <PanelLeftOpen className="w-4 h-4" />
          </button>
        )}
        {/* 聊天背景 */}
        {currentGroup?.chatBackgroundParams && (
          <div
            className="absolute inset-0 z-0 pointer-events-none"
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
              className="flex items-center justify-between px-4 h-12 border-b border-tavern-border-soft bg-tavern-bg-soft shrink-0 relative z-10"
              style={currentGroup?.themeColor ? { borderBottomColor: currentGroup.themeColor, borderBottomWidth: '2px' } : undefined}
            >
              <div className="flex items-center gap-2 min-w-0">
                {sidebarCollapsed && (
                  <button
                    onClick={() => setSidebarCollapsed(false)}
                    className="btn-ghost p-1 rounded-lg hover:bg-tavern-bg-hover text-tavern-text-muted shrink-0"
                    title="展开群聊列表"
                  >
                    <PanelLeftOpen className="w-4 h-4" />
                  </button>
                )}
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

                {/* ---- 会话管理 ---- */}
                <SessionSwitcher
                  sessions={sessions}
                  currentSessionId={currentSessionId}
                  variant="group"
                  onSwitch={(id) => switchSession(currentGroup.id, id)}
                  onRename={(id, title) => renameSession(currentGroup.id, id, title)}
                  onDelete={(id) => deleteSession(currentGroup.id, id)}
                  onCreate={() => createSession(currentGroup.id)}
                />
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

                {/* 长记忆 */}
                {currentSessionId && (
                  <MemoryPanel
                    open={showMemoryPanel}
                    onToggle={() => {
                      if (!showMemoryPanel && currentSessionId) {
                        const curS = sessions.find(s => s.id === currentSessionId)
                        setMemoryInterval(curS?.autoMemoryInterval ?? 10)
                      }
                      setShowMemoryPanel(!showMemoryPanel)
                    }}
                    sessions={sessions}
                    currentSessionId={currentSessionId}
                    currentCharacterId={currentGroup?.id ?? null}
                    memoryInterval={memoryInterval}
                    onMemoryIntervalChange={setMemoryInterval}
                    onToggleMemory={(enabled) => {
                      if (currentGroup && currentSessionId) toggleMemory(currentGroup.id, currentSessionId, enabled)
                    }}
                    onSetMemoryMode={(mode, interval) => {
                      if (currentGroup && currentSessionId) setMemoryMode(currentGroup.id, currentSessionId, mode, interval)
                    }}
                    onTriggerSummary={() => {
                      triggerMemorySummary()
                    }}
                    isStreaming={isStreaming}
                    memoryStats={messages.length > 0 ? {
                      totalMessages: messages.length,
                      totalChars: messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0),
                      durationStr: messages.length > 1
                        ? (() => {
                            const ms = messages[messages.length - 1].timestamp - messages[0].timestamp
                            const hours = Math.floor(ms / 3600000)
                            const mins = Math.floor((ms % 3600000) / 60000)
                            return hours > 0 ? `${hours}小时${mins}分钟` : `${mins}分钟`
                          })()
                        : '不足1分钟',
                    } : null}
                  />
                )}

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
                  onClick={() => setShowClearConfirm(true)}
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
            <div className="flex-1 overflow-hidden relative z-0">
              {messages.length === 0 && !isStreaming ? (
                <div className="flex items-center justify-center h-full text-xs text-tavern-text-muted">
                  <div className="text-center">
                    <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    <p>选择成员并开始群聊对话</p>
                  </div>
                </div>
              ) : (
                <Virtuoso
                  key={currentGroup?.id || 'default'}
                  ref={virtuosoRef}
                  data={messages}
                  className="h-full"
                  followOutput="smooth"
                  itemContent={(index, m) => {
                    const memberIdx = currentGroup.memberIds.indexOf(m.characterId)
                    const isAiMsg = m.characterId !== '__user__'
                    const isStreamingMsg = isStreaming && index === messages.length - 1 && isAiMsg
                    // 查找被引用的消息
                    const repliedMessage = m.replyToId
                      ? messages.find(msg => msg.id === m.replyToId)
                      : undefined
                    return (
                      <GroupChatMessage
                        key={m.id}
                        message={m}
                        memberIndex={memberIdx}
                        isStreamingMessage={isStreamingMsg}
                        repliedMessage={repliedMessage}
                        bubbleOpacity={currentGroup.bubbleOpacity}
                        onReply={
                          !isStreaming ? () => setReplyToMessage(m) : undefined
                        }
                        onDelete={
                          !currentSessionId || isStreaming ? undefined : () => deleteMessage(currentGroup.id, currentSessionId!, m.id)
                        }
                        onEdit={
                          !currentSessionId || isStreaming ? undefined : (content: string) => editMessage(currentGroup.id, currentSessionId!, m.id, content)
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
                    Footer: () => <div className="h-4" />,
                  }}
                />
              )}
            </div>

            {/* ---- 输入区 ---- */}
            <div className="relative z-10">
            <GroupChatInput
              group={currentGroup}
              replyTo={replyToMessage}
              onCancelReply={() => setReplyToMessage(null)}
            />
            </div>

            {/* ---- 成员栏 ---- */}
            <div className="relative z-10">
            <GroupMemberBar
              memberIds={currentGroup.memberIds}
              currentSpeakerIndex={currentGroup.currentSpeakerIndex}
              themeColor={currentGroup.themeColor}
              onSpeakerClick={(charId) => {
                const idx = currentGroup.memberIds.indexOf(charId)
                if (idx < 0) return
                // 更新当前发言者索引
                const updated = { ...currentGroup, currentSpeakerIndex: idx }
                saveGroup(updated)
                // polling 模式且非自动时，手动触发该角色发言
                if (currentGroup.chatMode === 'polling' && !currentGroup.autoMode && !isStreaming) {
                  sendPollingRound(charId)
                }
              }}
            />
            </div>
          </>
        )}
      </main>

      {/* ============ 群聊设置弹窗 ============ */}
      {showSettings && currentGroup && (
        <GroupChatSettingsPanel
          group={currentGroup}
          characters={characters}
          lorebooks={lorebooks}
          presets={presets}
          onClose={() => setShowSettings(false)}
          onSave={saveGroup}
          onDelete={() => confirmDelete(currentGroup.id)}
          onAddMember={handleAddMember}
          onRemoveMember={handleRemoveMember}
          onMoveMember={handleMoveMember}
          onToggleLorebook={toggleLorebook}
          onExport={handleExport}
        />
      )}

      {/* ============ 删除群聊确认 ============ */}
      <ConfirmDialog
        open={showDeleteConfirm}
        title="删除群聊"
        message="确定要删除此群聊吗？所有群聊对话数据将被清除，此操作不可撤销。"
        onConfirm={handleDelete}
        onClose={() => { setShowDeleteConfirm(false); setDeletingId(null) }}
        danger
      />

      {/* ============ 清空聊天确认 ============ */}
      <ConfirmDialog
        open={showClearConfirm}
        title="清空聊天"
        message="确定要清空当前会话的所有聊天记录吗？此操作不可撤销。"
        onConfirm={async () => {
          if (currentGroup) {
            await clearChat(currentGroup.id)
          }
          setShowClearConfirm(false)
        }}
        onClose={() => setShowClearConfirm(false)}
        danger
      />

      {/* ============ 上下文查看器 ============ */}
      <Modal
        open={showContextViewer}
        onClose={() => setShowContextViewer(false)}
        width="xl"
        headerClassName="px-4 py-3 bg-tavern-bg-soft"
        header={
          <div className="flex items-center gap-2 flex-1">
            <h3 className="text-sm font-semibold text-tavern-text">上下文查看器</h3>
            <span className="text-[10px] text-tavern-text-muted">{contextContent.length} 条消息</span>
          </div>
        }
        contentClassName="p-4"
      >
        <div className="space-y-3">
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
      </Modal>

      {/* ============ 群聊开场白选择弹窗 ============ */}
      {(() => {
        if (!currentGroup || messages.length > 0 || isStreaming || !showGreetingPicker) return null
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
          <Modal
            open={true}
            onClose={() => setShowGreetingPicker(false)}
            width="custom"
            widthClassName="w-[560px]"
            headerClassName="px-5 py-4 bg-tavern-bg-soft"
            header={
              <div className="flex items-center gap-3 flex-1 min-w-0">
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
              </div>
            }
            footer={
              <>
                <span className="text-xs text-tavern-text-muted mr-auto">
                  点击任意开场白开始群聊，或
                </span>
                <button
                  className="btn-secondary text-xs"
                  onClick={() => setShowGreetingPicker(false)}
                >
                  跳过，手动开始
                </button>
              </>
            }
          >
            <div className="space-y-3">
              {memberGreetings.map((member) => (
                <div key={member.charId} className="space-y-1.5">
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
                  {member.greetings.map((greeting, gi) => (
                    <button
                      key={`${member.charId}-${gi}`}
                      onClick={async () => {
                        setShowGreetingPicker(false)
                        if (!currentSessionId) return
                        const { insertCharacterMessage } = useGroupChatStore.getState()
                        await insertCharacterMessage(member.charId, greeting)
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
          </Modal>
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

      {/* ============ 新建群聊：角色选择弹窗 ============ */}
      <Modal
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        title="新建群聊 - 选择角色"
        width="md"
        footer={
          <div className="flex items-center justify-between w-full">
            <span className="text-xs text-tavern-text-muted">
              已选 {selectedMemberIds.length} 位角色
              {selectedMemberIds.length > 0 && (
                <span className="ml-2 text-tavern-text-soft">
                  群聊名称：{selectedMemberIds
                    .map(id => characters.find(c => c.id === id)?.name ?? '未知')
                    .join('、')}
                </span>
              )}
            </span>
            <div className="flex items-center gap-2">
              <button onClick={() => setShowCreateModal(false)} className="btn-ghost text-xs">
                取消
              </button>
              <button
                onClick={confirmCreate}
                disabled={selectedMemberIds.length === 0}
                className="btn-primary text-xs"
              >
                创建群聊
              </button>
            </div>
          </div>
        }
      >
        {/* 搜索框 */}
        <div className="mb-2 relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-tavern-text-muted" />
          <input
            value={memberSearch}
            onChange={e => setMemberSearch(e.target.value)}
            placeholder="搜索角色名称、描述或标签..."
            className="w-full pl-8 pr-3 py-1.5 text-sm bg-tavern-bg border border-tavern-border rounded-lg text-tavern-text outline-none focus:border-tavern-accent"
            autoFocus
          />
        </div>

        <div className="space-y-1 max-h-72 overflow-y-auto">
          {characters.length === 0 ? (
            <div className="py-8 text-center text-sm text-tavern-text-muted">
              暂无角色，请先创建或导入角色
            </div>
          ) : filteredCharacters.length === 0 ? (
            <div className="py-8 text-center text-sm text-tavern-text-muted">
              未找到匹配的角色
            </div>
          ) : (
            filteredCharacters.map(char => {
              const selected = selectedMemberIds.includes(char.id)
              return (
                <div
                  key={char.id}
                  onClick={() => toggleMemberSelect(char.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => e.key === 'Enter' && toggleMemberSelect(char.id)}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors',
                    selected
                      ? 'bg-tavern-accent-soft border border-tavern-accent'
                      : 'hover:bg-tavern-bg-hover border border-transparent'
                  )}
                >
                  {char.avatar ? (
                    <img src={char.avatar} className="w-9 h-9 rounded-lg object-cover shrink-0" alt="" />
                  ) : (
                    <div className="w-9 h-9 rounded-lg bg-tavern-bg-hover flex items-center justify-center text-sm font-bold text-tavern-text-muted shrink-0">
                      {char.name[0]}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-tavern-text truncate">{char.name}</div>
                    {char.description && (
                      <div className="text-xs text-tavern-text-muted truncate">{char.description}</div>
                    )}
                  </div>
                  <div className={cn(
                    'w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors',
                    selected ? 'bg-tavern-accent border-tavern-accent' : 'border-tavern-border'
                  )}>
                    {selected && <Check className="w-3 h-3 text-white" />}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </Modal>
    </div>
  )
}
