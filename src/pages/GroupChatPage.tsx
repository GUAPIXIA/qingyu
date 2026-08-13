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
import { Modal } from '../components/common/Modal'
import { GreetingPickerModal } from './group/GreetingPickerModal'
import { NewGroupModal } from './group/NewGroupModal'
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
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react'

export function GroupChatPage() {
  const { characters } = useCharacterStore()
  // 优化：选择性订阅（此前全量订阅 store，群聊流式/轮询时整页重渲染）
  const groupChats = useGroupChatStore((s) => s.groupChats)
  const currentGroup = useGroupChatStore((s) => s.currentGroup)
  const sessions = useGroupChatStore((s) => s.sessions)
  const currentSessionId = useGroupChatStore((s) => s.currentSessionId)
  const messages = useGroupChatStore((s) => s.messages)
  const isStreaming = useGroupChatStore((s) => s.isStreaming)
  const loadGroups = useGroupChatStore((s) => s.loadGroups)
  const selectGroup = useGroupChatStore((s) => s.selectGroup)
  const saveGroup = useGroupChatStore((s) => s.saveGroup)
  const deleteGroup = useGroupChatStore((s) => s.deleteGroup)
  const createSession = useGroupChatStore((s) => s.createSession)
  const switchSession = useGroupChatStore((s) => s.switchSession)
  const deleteSession = useGroupChatStore((s) => s.deleteSession)
  const renameSession = useGroupChatStore((s) => s.renameSession)
  const clearChat = useGroupChatStore((s) => s.clearChat)
  const deleteMessage = useGroupChatStore((s) => s.deleteMessage)
  const editMessage = useGroupChatStore((s) => s.editMessage)
  const regenerateMessage = useGroupChatStore((s) => s.regenerateMessage)
  const translateMessage = useGroupChatStore((s) => s.translateMessage)
  const sendPollingRound = useGroupChatStore((s) => s.sendPollingRound)
  const toggleMemory = useGroupChatStore((s) => s.toggleMemory)
  const setMemoryMode = useGroupChatStore((s) => s.setMemoryMode)
  const triggerMemorySummary = useGroupChatStore((s) => s.triggerMemorySummary)

  // P-6 修复：引用回复查找 O(n)→O(1)——构建 id→message 索引，仅在 messages 变化时重建
  const messageMap = useMemo(() => {
    const map = new Map<string, GroupMessage>()
    for (const m of messages) map.set(m.id, m)
    return map
  }, [messages])

  // P-8 修复：成员索引查找 O(n)→O(1)——itemContent 每条可见消息渲染都查 indexOf
  const memberIndexMap = useMemo(() => {
    const map = new Map<string, number>()
    currentGroup?.memberIds.forEach((id, i) => map.set(id, i))
    return map
  }, [currentGroup?.memberIds])

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
  }, [loadGroups])

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
                {/* 字符总量 */}
                {(() => {
                  const totalChars = messages.reduce((sum, m) => sum + (m.charUsage?.totalChars ?? 0), 0)
                  if (totalChars > 0) {
                    return (
                      <span className="text-[10px] text-tavern-text-muted px-1.5 py-0.5 rounded bg-tavern-bg-hover">
                        {totalChars} 字符
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
                    const memberIdx = memberIndexMap.get(m.characterId) ?? -1
                    const isAiMsg = m.characterId !== '__user__'
                    const isStreamingMsg = isStreaming && index === messages.length - 1 && isAiMsg
                    // 查找被引用的消息（P-6：Map 索引 O(1)）
                    const repliedMessage = m.replyToId
                      ? messageMap.get(m.replyToId)
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
      <GreetingPickerModal
        open={showGreetingPicker}
        group={currentGroup}
        messagesCount={messages.length}
        isStreaming={isStreaming}
        onClose={() => setShowGreetingPicker(false)}
      />

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
      <NewGroupModal
        open={showCreateModal}
        characters={characters}
        filteredCharacters={filteredCharacters}
        selectedMemberIds={selectedMemberIds}
        memberSearch={memberSearch}
        onMemberSearchChange={setMemberSearch}
        onToggleMember={toggleMemberSelect}
        onCreate={confirmCreate}
        onClose={() => setShowCreateModal(false)}
      />

    </div>
  )
}
