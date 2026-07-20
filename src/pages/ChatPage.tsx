import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useChatStore } from '../store/useChatStore'
import { useCharacterStore } from '../store/useCharacterStore'
import { useSettingsStore } from '../store/useSettingsStore'
import { MessageBubble } from '../components/chat/MessageBubble'
import { ChatInput } from '../components/chat/ChatInput'
import { EmptyState } from '../components/common/EmptyState'
import { ConfirmDialog } from '../components/common/ConfirmDialog'
import { TokenUsage } from '../components/chat/TokenUsage'
import { QuickSettingsPanel } from '../components/chat/QuickSettingsPanel'
import { ContextViewer } from '../components/chat/ContextViewer'
import { StatusBar } from '../components/chat/StatusBar'
import { cn } from '../lib/utils'
import { estimateTokens, formatTokens } from '../utils/tokenCounter'
import { replaceVariables } from '../utils/variables'
import { nanoid } from 'nanoid'
import type { Message } from '../../shared/types'
import {
  MessageSquare,
  Settings as SettingsIcon,
  Trash2,
  Download,
  Users,
  ChevronDown,
  ArrowDownToLine,
  Eye,
  Sliders,
  Plus,
  Layers,
  Edit2,
  Brain,
} from 'lucide-react'

export function ChatPage() {
  const navigate = useNavigate()
  const { messages, loadMessages, isStreaming, clearChat, clearMessages, sessions, currentSessionId, loadSessions, createSession, switchSession, deleteCurrentSession, renameSession, toggleMemory, setMemoryMode, triggerMemorySummary, getStats } = useChatStore()
  const { currentCharacter, characters, selectCharacter } = useCharacterStore()
  const { settings, loaded, updateSettings, getActiveProfile } = useSettingsStore()
  const [showCharMenu, setShowCharMenu] = useState(false)
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [showSessionMenu, setShowSessionMenu] = useState(false)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [sessionEditTitle, setSessionEditTitle] = useState('')
  const [showMemoryPanel, setShowMemoryPanel] = useState(false)
  const [memoryStats, setMemoryStats] = useState<{ totalMessages: number; totalChars: number; durationStr: string } | null>(null)
  const [memoryInterval, setMemoryInterval] = useState(10)
  const [showQuickSettings, setShowQuickSettings] = useState(false)
  const [showContextViewer, setShowContextViewer] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)

  const activeProfile = getActiveProfile()
  const isConnected = activeProfile !== null && (activeProfile.provider === 'ollama' || !!activeProfile.apiKey)

  // 加载消息（切换角色时）
  useEffect(() => {
    if (currentCharacter) {
      loadSessions(currentCharacter.id).then(() => loadMessages(currentCharacter))
    } else {
      clearMessages()
    }
  }, [currentCharacter?.id, loadMessages, clearMessages])

  // 自动滚动
  useEffect(() => {
    if (settings.autoScroll && messagesContainerRef.current) {
      messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight
    }
  }, [messages])

  // Token 统计
  const totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)

  // 导出对话
  const handleExport = async () => {
    if (!currentCharacter || !currentSessionId) return
    const content = await window.api.chat.exportChat(currentCharacter.id, currentSessionId, 'md')
    const blob = new Blob([content], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${currentCharacter.name}-对话.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  // 首次使用引导
  if (loaded && !isConnected) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="max-w-md text-center">
          <div className="w-20 h-20 mx-auto rounded-2xl bg-tavern-accent-soft flex items-center justify-center mb-6">
            <MessageSquare className="w-10 h-10 text-tavern-accent" />
          </div>
          <h2 className="text-xl font-display font-bold mb-2">欢迎使用轻 Tavern</h2>
          <p className="text-tavern-text-soft mb-6">
            开始你的 AI 角色扮演之旅。只需 3 步即可开启对话：
          </p>
          <div className="text-left space-y-3 mb-6">
            <div className="flex gap-3 items-start p-3 rounded-lg bg-tavern-bg-card">
              <span className="w-6 h-6 rounded-full bg-tavern-accent text-tavern-bg flex items-center justify-center text-sm font-bold shrink-0">1</span>
              <div>
                <div className="font-medium text-tavern-text">配置 AI 连接</div>
                <div className="text-sm text-tavern-text-muted">选择 AI 服务商并填入 API 密钥</div>
              </div>
            </div>
            <div className="flex gap-3 items-start p-3 rounded-lg bg-tavern-bg-card">
              <span className="w-6 h-6 rounded-full bg-tavern-accent text-tavern-bg flex items-center justify-center text-sm font-bold shrink-0">2</span>
              <div>
                <div className="font-medium text-tavern-text">选择或创建角色</div>
                <div className="text-sm text-tavern-text-muted">从角色库选择，或创建你的专属角色</div>
              </div>
            </div>
            <div className="flex gap-3 items-start p-3 rounded-lg bg-tavern-bg-card">
              <span className="w-6 h-6 rounded-full bg-tavern-accent text-tavern-bg flex items-center justify-center text-sm font-bold shrink-0">3</span>
              <div>
                <div className="font-medium text-tavern-text">开始对话</div>
                <div className="text-sm text-tavern-text-muted">输入消息，享受沉浸式角色扮演</div>
              </div>
            </div>
          </div>
          <button className="btn-primary w-full" onClick={() => navigate('/settings')}>
            <SettingsIcon className="w-4 h-4" />
            开始配置
          </button>
        </div>
      </div>
    )
  }

  if (!currentCharacter) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <EmptyState
          icon={<Users className="w-8 h-8" />}
          title="选择一个角色开始对话"
          description="从左侧角色库中选择，或创建新角色"
          action={
            <button className="btn-primary" onClick={() => navigate('/characters')}>
              <Users className="w-4 h-4" />
              前往角色管理
            </button>
          }
        />
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 顶栏 */}
      <header className="flex items-center justify-between px-4 h-14 border-b border-tavern-border-soft bg-tavern-bg-soft shrink-0">
        <div className="flex items-center gap-3">
          {/* 角色选择下拉 */}
          <div className="relative">
            <button
              onClick={() => setShowCharMenu(!showCharMenu)}
              className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-tavern-bg-hover transition-colors"
            >
              {currentCharacter.avatar ? (
                <img src={currentCharacter.avatar} alt="" className="w-8 h-8 rounded-full object-cover" />
              ) : (
                <div className="w-8 h-8 rounded-full bg-tavern-assistant/20 flex items-center justify-center text-tavern-assistant text-sm font-bold">
                  {currentCharacter.name[0]}
                </div>
              )}
              <div className="text-left">
                <div className="text-sm font-medium text-tavern-text">{currentCharacter.name}</div>
                <div className="text-xs text-tavern-text-muted">
                  {isStreaming ? '生成中...' : '在线'}
                </div>
              </div>
              <ChevronDown className="w-4 h-4 text-tavern-text-muted" />
            </button>

            {showCharMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowCharMenu(false)} />
                <div className="absolute top-full left-0 mt-1 w-64 max-h-80 overflow-y-auto bg-tavern-bg-card border border-tavern-border rounded-xl shadow-xl z-20 py-1">
                  {characters.length === 0 ? (
                    <div className="px-4 py-3 text-sm text-tavern-text-muted text-center">
                      暂无角色，请先创建
                    </div>
                  ) : (
                    characters.map((char) => (
                      <button
                        key={char.id}
                        onClick={() => {
                          selectCharacter(char.id)
                          setShowCharMenu(false)
                        }}
                        className={cn(
                          'w-full flex items-center gap-2 px-3 py-2 hover:bg-tavern-bg-hover transition-colors text-left',
                          char.id === currentCharacter.id && 'bg-tavern-accent-soft'
                        )}
                      >
                        {char.avatar ? (
                          <img src={char.avatar} alt="" className="w-8 h-8 rounded-full object-cover" />
                        ) : (
                          <div className="w-8 h-8 rounded-full bg-tavern-bg-hover flex items-center justify-center text-xs font-bold">
                            {char.name[0]}
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-tavern-text truncate">{char.name}</div>
                          {char.tags[0] && (
                            <div className="text-xs text-tavern-text-muted truncate">{char.tags[0]}</div>
                          )}
                        </div>
                      </button>
                    ))
                  )}
                  <div className="border-t border-tavern-border-soft mt-1 pt-1">
                    <button
                      onClick={() => {
                        navigate('/characters')
                        setShowCharMenu(false)
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-tavern-bg-hover transition-colors text-sm text-tavern-accent"
                    >
                      <Users className="w-4 h-4" />
                      管理角色
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* 会话切换器 */}
          {sessions.length > 0 && (
            <div className="flex items-center gap-1">
              <span className="text-tavern-border-soft select-none">|</span>
              <div className="relative">
                <button
                  onClick={() => setShowSessionMenu(!showSessionMenu)}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-tavern-bg-hover transition-colors text-sm text-tavern-text-soft"
                  title="切换对话"
                >
                  <Layers className="w-3.5 h-3.5 text-tavern-text-muted" />
                  <span className="max-w-[100px] truncate">
                    {sessions.find(s => s.id === currentSessionId)?.title ?? '对话'}
                  </span>
                  <ChevronDown className="w-3 h-3 text-tavern-text-muted" />
                </button>

                {showSessionMenu && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setShowSessionMenu(false)} />
                    <div className="absolute top-full left-0 mt-1 w-56 bg-tavern-bg-card border border-tavern-border rounded-xl shadow-xl z-20 py-1 max-h-72 overflow-y-auto">
                      {sessions.map((s) => (
                        <div
                          key={s.id}
                          className={cn(
                            'flex items-center gap-2 px-3 py-2 hover:bg-tavern-bg-hover transition-colors',
                            s.id === currentSessionId && 'bg-tavern-accent-soft'
                          )}
                        >
                          {editingSessionId === s.id ? (
                            <input
                              className="input text-xs flex-1 py-1 px-2"
                              value={sessionEditTitle}
                              onChange={(e) => setSessionEditTitle(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  renameSession(currentCharacter!.id, s.id, sessionEditTitle)
                                  setEditingSessionId(null)
                                } else if (e.key === 'Escape') {
                                  setEditingSessionId(null)
                                }
                              }}
                              autoFocus
                              onBlur={() => setEditingSessionId(null)}
                            />
                          ) : (
                            <>
                              <button
                                className="flex-1 text-left text-sm text-tavern-text truncate"
                                onClick={() => {
                                  switchSession(s.id, currentCharacter!)
                                  setShowSessionMenu(false)
                                }}
                              >
                                {s.title}
                                <span className="text-xs text-tavern-text-muted ml-2">
                                  ({s.messageCount}条)
                                </span>
                              </button>
                              <button
                                className="p-0.5 rounded text-tavern-text-muted hover:text-tavern-text"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setEditingSessionId(s.id)
                                  setSessionEditTitle(s.title)
                                }}
                                title="重命名"
                              >
                                <Edit2 className="w-3 h-3" />
                              </button>
                              {sessions.length > 1 && (
                                <button
                                  className="p-0.5 rounded text-tavern-text-muted hover:text-tavern-danger"
                                  onClick={async (e) => {
                                    e.stopPropagation()
                                    await window.api.chat.deleteSession(currentCharacter!.id, s.id)
                                    // 刷新
                                    const newSessions = await window.api.chat.listSessions(currentCharacter!.id)
                                    const newSid = newSessions[0]?.id ?? null
                                    useChatStore.setState({ sessions: newSessions, currentSessionId: newSid })
                                    if (newSid) {
                                      switchSession(newSid, currentCharacter!)
                                    } else {
                                      useChatStore.setState({ messages: [] })
                                    }
                                  }}
                                  title="删除"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
              <button
                onClick={async () => {
                  if (!currentCharacter) return
                  await createSession(currentCharacter.id)
                  clearMessages()
                  // 有开场白则插入
                  if (currentCharacter.firstMessage) {
                    const settings = useSettingsStore.getState().settings
                    const processedFirstMsg = replaceVariables(currentCharacter.firstMessage, settings.userName, currentCharacter.name)
                    const firstMsg: Message = {
                      id: nanoid(),
                      sessionId: currentSessionId || 'default',
                      characterId: currentCharacter.id,
                      role: 'assistant',
                      content: processedFirstMsg,
                      images: [],
                      isEditing: false,
                      timestamp: Date.now(),
                    }
                    await window.api.chat.saveMessage(firstMsg)
                    useChatStore.setState(s => ({ messages: [firstMsg] }))
                  }
                }}
                className="p-1 rounded-lg text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-bg-hover transition-colors"
                title="新建对话"
              >
                <Plus className="w-4 h-4" />
              </button>

              {/* 长记忆按钮 */}
              <div className="relative">
                <button
                  onClick={async () => {
                    if (!currentCharacter || !currentSessionId) return
                    const stats = await getStats(currentCharacter.id, currentSessionId)
                    if (stats) setMemoryStats(stats)
                    const curS = sessions.find(s => s.id === currentSessionId)
                    setMemoryInterval(curS?.autoMemoryInterval ?? 10)
                    setShowMemoryPanel(!showMemoryPanel)
                  }}
                  className={cn(
                    'p-1 rounded-lg text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-bg-hover transition-colors',
                    showMemoryPanel && 'text-tavern-accent bg-tavern-bg-hover'
                  )}
                  title="长记忆"
                >
                  <Brain className="w-4 h-4" />
                </button>

                {showMemoryPanel && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setShowMemoryPanel(false)} />
                    <div className="absolute top-full right-0 mt-1 w-72 bg-tavern-bg-card border border-tavern-border rounded-xl shadow-xl z-20 py-2 px-3 text-sm">
                      <h4 className="font-medium text-tavern-text mb-2">长记忆设置</h4>

                      {/* 开关 */}
                      <label className="flex items-center justify-between py-1.5 cursor-pointer">
                        <span className="text-tavern-text-soft">启用长记忆</span>
                        <input
                          type="checkbox"
                          checked={sessions.find(s => s.id === currentSessionId)?.memoryEnabled ?? false}
                          onChange={(e) => {
                            if (currentCharacter && currentSessionId) toggleMemory(currentCharacter.id, currentSessionId, e.target.checked)
                          }}
                          className="toggle"
                        />
                      </label>

                      {/* 模式选择 */}
                      <div className="flex items-center justify-between py-1.5">
                        <span className="text-tavern-text-soft">总结模式</span>
                        <select
                          value={sessions.find(s => s.id === currentSessionId)?.memoryMode ?? 'manual'}
                          onChange={(e) => {
                            if (currentCharacter && currentSessionId) {
                              setMemoryMode(currentCharacter.id, currentSessionId, e.target.value as 'manual' | 'auto', memoryInterval)
                            }
                          }}
                          className="input text-xs py-1 px-2 w-24"
                        >
                          <option value="manual">手动</option>
                          <option value="auto">自动</option>
                        </select>
                      </div>

                      {/* 自动间隔 */}
                      {sessions.find(s => s.id === currentSessionId)?.memoryMode === 'auto' && (
                        <div className="flex items-center justify-between py-1.5">
                          <span className="text-tavern-text-soft">自动间隔</span>
                          <div className="flex items-center gap-1">
                            <input
                              type="number"
                              value={memoryInterval}
                              min={4}
                              max={50}
                              onChange={(e) => {
                                const v = Math.max(4, Math.min(50, parseInt(e.target.value) || 10))
                                setMemoryInterval(v)
                                if (currentCharacter && currentSessionId) {
                                  setMemoryMode(currentCharacter.id, currentSessionId, 'auto', v)
                                }
                              }}
                              className="input text-xs py-1 px-2 w-16 text-center"
                            />
                            <span className="text-xs text-tavern-text-muted">条</span>
                          </div>
                        </div>
                      )}

                      {/* 手动总结 */}
                      <button
                        className="btn-secondary w-full mt-2 text-xs"
                        onClick={() => {
                          if (currentCharacter) triggerMemorySummary(currentCharacter)
                        }}
                        disabled={isStreaming}
                      >
                        立即总结
                      </button>

                      {/* 当前总结预览 */}
                      {(() => {
                        const s = sessions.find(s => s.id === currentSessionId)
                        if (s?.memory) {
                          return (
                            <div className="mt-2 p-2 rounded bg-tavern-bg-hover text-xs text-tavern-text-muted max-h-20 overflow-y-auto">
                              <span className="text-tavern-text-soft font-medium">当前摘要：</span>
                              {s.memory.slice(0, 200)}{s.memory.length > 200 ? '...' : ''}
                            </div>
                          )
                        }
                        return null
                      })()}

                      {/* 统计信息 */}
                      {memoryStats && (
                        <div className="mt-2 pt-2 border-t border-tavern-border-soft text-xs text-tavern-text-muted space-y-0.5">
                          <div className="flex justify-between">
                            <span>总消息数</span>
                            <span className="text-tavern-text-soft">{memoryStats.totalMessages}</span>
                          </div>
                          <div className="flex justify-between">
                            <span>总文字量</span>
                            <span className="text-tavern-text-soft">{memoryStats.totalChars.toLocaleString()}</span>
                          </div>
                          <div className="flex justify-between">
                            <span>对话时长</span>
                            <span className="text-tavern-text-soft">{memoryStats.durationStr}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center gap-1">
          <TokenUsage tokens={totalTokens} maxTokens={activeProfile?.maxContext || 8192} />
          <button
            onClick={() => updateSettings({ autoScroll: !settings.autoScroll })}
            className={cn(
              'p-2 rounded-lg transition-colors',
              settings.autoScroll
                ? 'text-tavern-accent bg-tavern-accent-soft'
                : 'text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover'
            )}
            title={settings.autoScroll ? '自动滚动：开' : '自动滚动：关'}
          >
            <ArrowDownToLine className="w-5 h-5" />
          </button>
          <button
            onClick={() => setShowContextViewer(true)}
            className="p-2 rounded-lg text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover transition-colors"
            title="查看上下文"
          >
            <Eye className="w-5 h-5" />
          </button>
          <button
            onClick={() => setShowQuickSettings(!showQuickSettings)}
            className={cn(
              'p-2 rounded-lg transition-colors',
              showQuickSettings
                ? 'text-tavern-accent bg-tavern-accent-soft'
                : 'text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover'
            )}
            title="快捷设置"
          >
            <Sliders className="w-5 h-5" />
          </button>
          <button
            onClick={handleExport}
            className="p-2 rounded-lg text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover transition-colors"
            title="导出对话"
          >
            <Download className="w-5 h-5" />
          </button>
          <button
            onClick={() => setShowClearConfirm(true)}
            className="p-2 rounded-lg text-tavern-text-muted hover:text-tavern-danger hover:bg-tavern-bg-hover transition-colors"
            title="清空对话"
          >
            <Trash2 className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* 状态栏 */}
      {currentCharacter && messages.length > 0 && (
        <StatusBar character={currentCharacter} messages={messages} />
      )}

      {/* 消息列表 */}
      <div
        ref={messagesContainerRef}
        className={cn(
          'flex-1 overflow-y-auto py-4',
          `bubble-${settings.bubbleStyle}`,
          `spacing-${settings.messageSpacing}`
        )}
      >
        {messages.length === 0 ? (
          <EmptyState
            className="h-full"
            icon={<MessageSquare className="w-8 h-8" />}
            title="开始新的对话"
            description={`与 ${currentCharacter.name} 开始你的故事`}
          />
        ) : (
          messages.map((msg, i) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              character={currentCharacter}
              isLast={i === messages.length - 1}
            />
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* 输入区 */}
      <ChatInput character={currentCharacter} />

      {/* 清空确认 */}
      <ConfirmDialog
        open={showClearConfirm}
        onClose={() => setShowClearConfirm(false)}
        onConfirm={() => clearChat(currentCharacter.id)}
        title="清空对话"
        message={`确定要清空与 ${currentCharacter.name} 的所有对话记录吗？此操作不可撤销。`}
        confirmText="清空"
        danger
      />

      {/* 快捷设置面板 */}
      <QuickSettingsPanel open={showQuickSettings} onClose={() => setShowQuickSettings(false)} />

      {/* 上下文查看器 */}
      <ContextViewer
        open={showContextViewer}
        onClose={() => setShowContextViewer(false)}
        character={currentCharacter}
        preset={null}
        lorebook={null}
      />
    </div>
  )
}
