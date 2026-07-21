import { useEffect, useRef, useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { useChatStore } from '../store/useChatStore'
import { useCharacterStore } from '../store/useCharacterStore'
import { useSettingsStore } from '../store/useSettingsStore'
import { MessageBubble } from '../components/chat/MessageBubble'
import { ChatInput } from '../components/chat/ChatInput'
import { EmptyState } from '../components/common/EmptyState'
import { ConfirmDialog } from '../components/common/ConfirmDialog'
import { TokenUsage } from '../components/chat/TokenUsage'
import { QuickSettingsPanel } from '../components/chat/QuickSettingsPanel'
import { BackgroundPanel, PRESET_GRADIENTS } from '../components/chat/BackgroundPanel'
import { ContextViewer } from '../components/chat/ContextViewer'
import { StatusBar } from '../components/chat/StatusBar'
import { cn } from '../lib/utils'
import { estimateTokens } from '../utils/tokenCounter'
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
  Image,
  Sliders,
  Plus,
  Layers,
  Edit2,
  Brain,
} from 'lucide-react'

export function ChatPage() {
  const navigate = useNavigate()
  const { messages, loadMessages, isStreaming, clearChat, clearMessages, sessions, currentSessionId, loadSessions, switchSession, deleteSession, renameSession, toggleMemory, setMemoryMode, triggerMemorySummary, getStats } = useChatStore()
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
  const [showBgPanel, setShowBgPanel] = useState(false)
  const [showContextViewer, setShowContextViewer] = useState(false)
  const [greetingPickerOpen, setGreetingPickerOpen] = useState(false)
  const [selectedGreeting, setSelectedGreeting] = useState('')
  const [charImgErrors, setCharImgErrors] = useState<Set<string>>(new Set())
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  // 用户手动滚动状态：避免流式时强制把视图拉到底
  const userScrolledUpRef = useRef(false)
  // 背景图片拖拽状态
  const [isDraggingBg, setIsDraggingBg] = useState(false)
  const bgImgRef = useRef<HTMLImageElement>(null)
  const bgDragRef = useRef({ startX: 0, startY: 0, startPosX: 0, startPosY: 0 })

  const activeProfile = getActiveProfile()
  const isConnected = activeProfile !== null && (activeProfile.provider === 'ollama' || !!activeProfile.apiKey)

  // 加载消息（切换角色时）
  useEffect(() => {
    if (currentCharacter) {
      // 切换角色时取消任何进行中的流式请求
      if (useChatStore.getState().isStreaming) {
        useChatStore.getState().stopStreaming()
      }
      userScrolledUpRef.current = false
      loadSessions(currentCharacter.id)
        .then(() => loadMessages(currentCharacter))
        .then(() => {
          // 检测是否有备选开场白
          const state = useChatStore.getState()
          const hasAltGreetings = currentCharacter.alternateGreetings && currentCharacter.alternateGreetings.length > 0
          // 双重检查：messages 为空 且 当前 session 的 messageCount 也为 0，才弹出选择器
          const currentSession = state.sessions.find(s => s.id === state.currentSessionId)
          const hasExistingMessages = currentSession && currentSession.messageCount > 0
          if (hasAltGreetings && state.messages.length === 0 && !hasExistingMessages) {
            setSelectedGreeting(currentCharacter.translatedContent?.firstMessage ?? currentCharacter.firstMessage)
            setGreetingPickerOpen(true)
          }
        })
        .catch((err) => {
          console.error('加载会话失败', err)
        })
      // 自动激活角色卡关联的世界书
      const chatStore = useChatStore.getState()
      if (currentCharacter.lorebookId && !chatStore.activeLorebookIds.includes(currentCharacter.lorebookId)) {
        chatStore.setActiveLorebooks([...chatStore.activeLorebookIds, currentCharacter.lorebookId])
      }
    } else {
      clearMessages()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCharacter?.id])

  // 用户滚动监听已由 Virtuoso 的 atBottomStateChange 接管，无需手动监听
  // 自动滚动也由 Virtuoso 的 followOutput 接管

  // Token 统计：useMemo 避免流式时每个 chunk 都重算
  const totalTokens = useMemo(() => {
    return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
  }, [messages])

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

  // 使用选中开场白开始对话
  const handleStartWithGreeting = async () => {
    if (!currentCharacter || !selectedGreeting) return
    setGreetingPickerOpen(false)

    // 确保存在会话：没有已有会话时自动创建
    let sid = currentSessionId
    if (!sid) {
      const session = await window.api.chat.createSession(currentCharacter.id)
      const sessions = await window.api.chat.listSessions(currentCharacter.id)
      useChatStore.setState({ sessions, currentSessionId: session.id })
      sid = session.id
    }

    const settings = useSettingsStore.getState().settings
    const processed = replaceVariables(selectedGreeting, settings.userName, currentCharacter.name)
    const firstMsg: Message = {
      id: nanoid(),
      sessionId: sid,
      characterId: currentCharacter.id,
      role: 'assistant',
      content: processed,
      images: [],
      isEditing: false,
      timestamp: Date.now(),
    }
    await window.api.chat.saveMessage(firstMsg)
    // 刷新 sessions 以更新 messageCount，确保下次加载时不重复弹出选择器
    const updatedSessions = await window.api.chat.listSessions(currentCharacter.id)
    useChatStore.setState(s => ({ messages: [...s.messages, firstMsg], sessions: updatedSessions, currentSessionId: sid }))
  }

  // 背景图片拖拽
  const handleBgMouseDown = (e: React.MouseEvent) => {
    const params = currentCharacter?.chatBackgroundParams
    if (!params) return
    bgDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startPosX: params.posX ?? 50,
      startPosY: params.posY ?? 50,
    }
    setIsDraggingBg(true)
    e.preventDefault()
  }

  useEffect(() => {
    if (!isDraggingBg) return

    const handleMouseMove = (e: MouseEvent) => {
      const { startX, startY, startPosX, startPosY } = bgDragRef.current
      const scale = 0.4 // 1px 鼠标移动 ≈ 0.4% 位置变化
      const newPosX = Math.max(0, Math.min(100, startPosX + (e.clientX - startX) * scale))
      const newPosY = Math.max(0, Math.min(100, startPosY + (e.clientY - startY) * scale))
      if (bgImgRef.current) {
        bgImgRef.current.style.objectPosition = `${newPosX}% ${newPosY}%`
      }
    }

    const handleMouseUp = async (e: MouseEvent) => {
      const { startX, startY, startPosX, startPosY } = bgDragRef.current
      const scale = 0.4
      const newPosX = Math.max(0, Math.min(100, startPosX + (e.clientX - startX) * scale))
      const newPosY = Math.max(0, Math.min(100, startPosY + (e.clientY - startY) * scale))
      setIsDraggingBg(false)

      const store = useCharacterStore.getState()
      if (store.currentCharacter) {
        const updated = {
          ...store.currentCharacter,
          chatBackgroundParams: {
            ...store.currentCharacter.chatBackgroundParams!,
            posX: Math.round(newPosX),
            posY: Math.round(newPosY),
          },
        }
        await store.saveCharacter(updated)
      }
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDraggingBg])

  // 首次使用引导
  if (loaded && !isConnected) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="max-w-md text-center">
          <div className="w-20 h-20 mx-auto rounded-2xl bg-tavern-accent-soft flex items-center justify-center mb-6">
            <MessageSquare className="w-10 h-10 text-tavern-accent" />
          </div>
          <h2 className="text-xl font-display font-bold mb-2">欢迎使用轻语</h2>
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

  // 封面作为背景：当开关开启且角色有封面时使用封面，否则使用手动设置的背景
  const effectiveBg = useMemo(() => {
    const useCover = settings.useCoverAsBackground && currentCharacter?.cover
    if (useCover) {
      return {
        src: currentCharacter.cover!,
        type: 'image' as const,
        opacity: 40,
        blur: 4,
        posX: 50,
        posY: 50,
        scale: 100,
      }
    }
    if (currentCharacter?.chatBackground) {
      return {
        src: currentCharacter.chatBackground,
        type: currentCharacter.chatBackgroundParams?.type ?? 'image',
        opacity: currentCharacter.chatBackgroundParams?.opacity ?? 12,
        blur: currentCharacter.chatBackgroundParams?.blur ?? 2,
        posX: currentCharacter.chatBackgroundParams?.posX ?? 50,
        posY: currentCharacter.chatBackgroundParams?.posY ?? 50,
        scale: currentCharacter.chatBackgroundParams?.scale ?? 100,
        gradient: currentCharacter.chatBackgroundParams?.gradient,
      }
    }
    return null
  }, [settings.useCoverAsBackground, currentCharacter?.cover, currentCharacter?.chatBackground, currentCharacter?.chatBackgroundParams])

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
    <div className="flex-1 flex flex-col overflow-hidden relative">
      {/* 背景图层 */}
      {effectiveBg && (
        <div
          className={cn(
            'absolute inset-0 z-0 select-none overflow-hidden',
            effectiveBg.type === 'image' ? 'pointer-events-auto' : 'pointer-events-none'
          )}
        >
          {effectiveBg.type === 'gradient' && effectiveBg.gradient ? (
            <div
              className="w-full h-full scale-105"
              style={{
                background: PRESET_GRADIENTS.find(g => g.key === effectiveBg.gradient)?.css,
                opacity: effectiveBg.opacity / 100,
                filter: `blur(${effectiveBg.blur}px)`,
              }}
            />
          ) : (
            <img
              ref={bgImgRef}
              src={effectiveBg.src}
              className="w-full h-full object-cover"
              style={{
                opacity: effectiveBg.opacity / 100,
                filter: `blur(${effectiveBg.blur}px)`,
                objectPosition: `${effectiveBg.posX}% ${effectiveBg.posY}%`,
                transform: `scale(${effectiveBg.scale / 100})`,
                cursor: isDraggingBg ? 'grabbing' : 'grab',
              }}
              onMouseDown={handleBgMouseDown}
              alt=""
              draggable={false}
            />
          )}
        </div>
      )}

      {/* 顶栏 */}
      <header className="relative z-30 flex items-center justify-between px-4 h-14 border-b border-tavern-border-soft bg-tavern-bg-soft shrink-0">
        <div className="flex items-center gap-3">
          {/* 角色选择下拉 */}
          <div className="relative">
            <button
              onClick={() => setShowCharMenu(!showCharMenu)}
              className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-tavern-bg-hover transition-colors"
            >
              {currentCharacter.avatar && !charImgErrors.has(currentCharacter.id) ? (
                <img src={currentCharacter.avatar} alt="" className="w-8 h-8 rounded-full object-cover" onError={() => setCharImgErrors(prev => new Set(prev).add(currentCharacter.id))} />
              ) : (
                <div className="w-8 h-8 rounded-full bg-tavern-assistant/20 flex items-center justify-center text-tavern-assistant text-sm font-bold">
                  {currentCharacter.translatedContent?.name?.[0] ?? currentCharacter.name[0]}
                </div>
              )}
              <div className="text-left">
                <div className="text-sm font-medium text-tavern-text">{currentCharacter.translatedContent?.name ?? currentCharacter.name}</div>
                <div className="text-xs text-tavern-text-muted">
                  {isStreaming ? '生成中...' : '在线'}
                </div>
              </div>
              <ChevronDown className="w-4 h-4 text-tavern-text-muted" />
            </button>

            {showCharMenu && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setShowCharMenu(false)} />
                <div className="absolute top-full left-0 mt-1 w-64 max-h-80 overflow-y-auto bg-tavern-bg-card border border-tavern-border rounded-xl shadow-xl z-40 py-1">
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
                        {char.avatar && !charImgErrors.has(char.id) ? (
                          <img src={char.avatar} alt="" className="w-8 h-8 rounded-full object-cover" onError={() => setCharImgErrors(prev => new Set(prev).add(char.id))} />
                        ) : (
                          <div className="w-8 h-8 rounded-full bg-tavern-bg-hover flex items-center justify-center text-xs font-bold">
                            {char.translatedContent?.name?.[0] ?? char.name[0]}
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-tavern-text truncate">{char.translatedContent?.name ?? char.name}</div>
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
                    <div className="fixed inset-0 z-20" onClick={() => setShowSessionMenu(false)} />
                    <div className="absolute top-full left-0 mt-1 w-56 bg-tavern-bg-card border border-tavern-border rounded-xl shadow-xl z-40 py-1 max-h-72 overflow-y-auto">
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
                                    // 修复：统一走 store.deleteSession，不再绕过 store 直接 IPC
                                    if (currentCharacter) {
                                      await deleteSession(currentCharacter.id, s.id)
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
                  // 创建新会话
                  const session = await window.api.chat.createSession(currentCharacter.id)
                  const sessions = await window.api.chat.listSessions(currentCharacter.id)
                  useChatStore.setState({ sessions, currentSessionId: session.id, messages: [] })
                  // 如有备选开场白，弹出选择器；否则直接用默认开场白
                  if (currentCharacter.alternateGreetings && currentCharacter.alternateGreetings.length > 0) {
                    setSelectedGreeting(currentCharacter.translatedContent?.firstMessage ?? currentCharacter.firstMessage)
                    setGreetingPickerOpen(true)
                  } else {
                    const settings = useSettingsStore.getState().settings
                    const processed = replaceVariables(currentCharacter.firstMessage, settings.userName, currentCharacter.name)
                    const firstMsg: Message = {
                      id: nanoid(),
                      sessionId: session.id,
                      characterId: currentCharacter.id,
                      role: 'assistant' as const,
                      content: processed,
                      images: [],
                      isEditing: false,
                      timestamp: Date.now(),
                    }
                    await window.api.chat.saveMessage(firstMsg)
                    useChatStore.setState(() => ({ messages: [firstMsg] }))
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
            onClick={() => setShowBgPanel(!showBgPanel)}
            className={cn(
              'p-2 rounded-lg transition-colors',
              showBgPanel
                ? 'text-tavern-accent bg-tavern-accent-soft'
                : 'text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover'
            )}
            title="聊天背景"
          >
            <Image className="w-5 h-5" />
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
        <div className="relative z-10"><StatusBar character={currentCharacter} messages={messages} /></div>
      )}

      {/* 消息列表 - 使用 Virtuoso 虚拟滚动 */}
      <div
        className={cn(
          'flex-1 overflow-hidden relative z-0',
          `bubble-${settings.bubbleStyle}`
        )}
      >
        {messages.length === 0 ? (
          <EmptyState
            className="h-full"
            icon={<MessageSquare className="w-8 h-8" />}
            title="开始新的对话"
            description={`与 ${currentCharacter.translatedContent?.name ?? currentCharacter.name} 开始你的故事`}
          />
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            data={messages}
            className="h-full"
            followOutput={(isAtBottom) => {
              // 流式时若用户未手动向上滚动则跟随
              return settings.autoScroll && (isAtBottom || !userScrolledUpRef.current)
            }}
            atBottomStateChange={(atBottom) => {
              // 同步用户滚动状态
              userScrolledUpRef.current = !atBottom
            }}
            itemContent={(index, msg) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                character={currentCharacter}
                isLast={index === messages.length - 1}
              />
            )}
            components={{
              Footer: () => <div ref={messagesEndRef} className="h-4" />,
            }}
          />
        )}
      </div>

      {/* 输入区 */}
      <div className="relative z-10">
        <ChatInput character={currentCharacter} />
      </div>

      {/* 清空确认 */}
      <ConfirmDialog
        open={showClearConfirm}
        onClose={() => setShowClearConfirm(false)}
        onConfirm={() => clearChat(currentCharacter.id)}
        title="清空对话"
        message={`确定要清空与 ${currentCharacter.translatedContent?.name ?? currentCharacter.name} 的所有对话记录吗？此操作不可撤销。`}
        confirmText="清空"
        danger
      />

      {/* 快捷设置面板 */}
      <QuickSettingsPanel open={showQuickSettings} onClose={() => setShowQuickSettings(false)} />
      <BackgroundPanel open={showBgPanel} onClose={() => setShowBgPanel(false)} />

      {/* 开场白选择面板 */}
      {greetingPickerOpen && currentCharacter && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in p-4">
          <div className="card w-[560px] max-w-full max-h-[85vh] flex flex-col overflow-hidden shadow-2xl">
            {/* 头部：角色信息 + 标题（固定） */}
            <div className="flex items-center gap-3 p-5 border-b border-tavern-border-soft bg-tavern-bg-soft shrink-0">
              <div className="w-12 h-12 rounded-lg overflow-hidden bg-tavern-bg-hover shrink-0">
                {(currentCharacter.cover || currentCharacter.avatar) ? (
                  <img
                    src={currentCharacter.cover || currentCharacter.avatar}
                    alt=""
                    className="w-full h-full object-cover"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-tavern-text-muted text-lg font-display">
                    {currentCharacter.translatedContent?.name?.[0] ?? currentCharacter.name[0]}
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-display font-bold text-lg truncate">{currentCharacter.translatedContent?.name ?? currentCharacter.name}</h3>
                <p className="text-xs text-tavern-text-muted">选择一个开场白开始对话</p>
              </div>
            </div>

            {/* 中间：可滚动的开场白列表 */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {[currentCharacter.translatedContent?.firstMessage ?? currentCharacter.firstMessage, ...(currentCharacter.alternateGreetings || [])]
                .filter(Boolean)
                .map((greeting, i) => (
                  <div
                    key={i}
                    className={cn(
                      'p-3 rounded-lg border cursor-pointer transition-all text-sm',
                      selectedGreeting === greeting
                        ? 'border-tavern-accent bg-tavern-accent-soft shadow-sm'
                        : 'border-tavern-border hover:bg-tavern-bg-hover hover:border-tavern-border-soft'
                    )}
                    onClick={() => setSelectedGreeting(greeting)}
                  >
                    <div className="flex gap-2.5">
                      <span className={cn(
                        'shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold mt-0.5',
                        selectedGreeting === greeting
                          ? 'bg-tavern-accent text-tavern-bg'
                          : 'bg-tavern-bg-hover text-tavern-text-muted'
                      )}>
                        {i + 1}
                      </span>
                      <div className="flex-1 line-clamp-4 whitespace-pre-wrap text-tavern-text-soft">
                        {replaceVariables(greeting, settings.userName, currentCharacter.translatedContent?.name ?? currentCharacter.name)}
                      </div>
                    </div>
                  </div>
                ))}
            </div>

            {/* 底部：固定按钮区（始终可见） */}
            <div className="flex items-center justify-between gap-2 p-4 border-t border-tavern-border-soft bg-tavern-bg-soft shrink-0">
              <span className={cn(
                'text-xs',
                selectedGreeting ? 'text-tavern-accent' : 'text-tavern-text-muted'
              )}>
                {selectedGreeting ? '✓ 已选择开场白' : '请选择一条开场白，或跳过直接开始'}
              </span>
              <div className="flex gap-2">
                <button className="btn-secondary" onClick={() => { setGreetingPickerOpen(false); setSelectedGreeting('') }}>
                  跳过
                </button>
                <button className="btn-primary" onClick={handleStartWithGreeting} disabled={!selectedGreeting}>
                  开始对话
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 上下文查看器 */}
      <ContextViewer
        open={showContextViewer}
        onClose={() => setShowContextViewer(false)}
        character={currentCharacter}
        preset={null}
      />
    </div>
  )
}
