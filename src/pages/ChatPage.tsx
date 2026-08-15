import { useEffect, useRef, useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { useChatStore } from '../store/useChatStore'
import { useCharacterStore } from '../store/useCharacterStore'
import { isLocalProvider, isLocalUrl } from '../utils/defaults'
import { useSettingsStore } from '../store/useSettingsStore'
import { usePersonaStore } from '../store/usePersonaStore'
import { MessageBubble } from '../components/chat/MessageBubble'
import { ChatInput } from '../components/chat/ChatInput'
import { ChatGreetingPickerModal } from '../components/chat/ChatGreetingPickerModal'
import { ChatWelcomeGuide } from '../components/chat/ChatWelcomeGuide'
import { EmptyState } from '../components/common/EmptyState'
import { ConfirmDialog } from '../components/common/ConfirmDialog'
import { ChatHeader } from '../components/chat/ChatHeader'
import { QuickSettingsPanel } from '../components/chat/QuickSettingsPanel'
import { BackgroundPanel, PRESET_GRADIENTS } from '../components/chat/BackgroundPanel'
import { ContextViewer } from '../components/chat/ContextViewer'
import { StatusBar } from '../components/chat/StatusBar'
import { cn } from '../lib/utils'
import { logError } from '../lib/logger'
import { countChars } from '../utils/charCounter'
import { getDisplayName } from '../utils/variables'
import { getEffectiveLorebookIds } from '../utils/lorebook'
import { downloadFile } from '../utils/download'
import type { Message } from '../../shared/types'
import {
  MessageSquare,
  Users,
  Sparkles,
  X,
  AlertTriangle,
} from 'lucide-react'

/** 长对话摘要引导提示的消息数阈值 */
const MEMORY_HINT_THRESHOLD = 40

export function ChatPage() {
  const navigate = useNavigate()
  // P1 修复：选择性订阅 store 字段（此前无选择器订阅整个 store，
  // 任何字段变化都全页重渲染——流式 50ms flush 时每秒 20 次整树协调）
  const messages = useChatStore((s) => s.messages)
  const sessions = useChatStore((s) => s.sessions)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const currentSessionId = useChatStore((s) => s.currentSessionId)
  const activeLorebookIds = useChatStore((s) => s.activeLorebookIds)
  const loadMessages = useChatStore((s) => s.loadMessages)
  const clearChat = useChatStore((s) => s.clearChat)
  const clearMessages = useChatStore((s) => s.clearMessages)
  const loadSessions = useChatStore((s) => s.loadSessions)
  const setActiveLorebooks = useChatStore((s) => s.setActiveLorebooks)
  const { currentCharacter } = useCharacterStore()
  const { settings, loaded, getActiveProfile } = useSettingsStore()
  const { loadPersonas } = usePersonaStore()
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [showQuickSettings, setShowQuickSettings] = useState(false)
  const [showBgPanel, setShowBgPanel] = useState(false)
  const [showContextViewer, setShowContextViewer] = useState(false)
  const [greetingPickerOpen, setGreetingPickerOpen] = useState(false)
  const [selectedGreeting, setSelectedGreeting] = useState('')
  // 世界书绑定确认弹窗
  const [showLorebookConfirm, setShowLorebookConfirm] = useState(false)
  const [pendingLorebookIds, setPendingLorebookIds] = useState<string[]>([])
  // 长对话摘要引导提示：记录已关闭提示的会话 ID
  const [memoryHintDismissed, setMemoryHintDismissed] = useState<string | null>(null)
  /** 引用回复：被引用的目标消息（P1-5） */
  const [replyToMessage, setReplyToMessage] = useState<Message | null>(null)
  const pendingSessionCallbackRef = useRef<(() => void) | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  // 背景图片拖拽状态
  const [isDraggingBg, setIsDraggingBg] = useState(false)
  const bgImgRef = useRef<HTMLImageElement>(null)
  const bgDragRef = useRef({ startX: 0, startY: 0, startPosX: 0, startPosY: 0 })

  const activeProfile = getActiveProfile()
  const isConnected = activeProfile !== null && (isLocalProvider(activeProfile.provider) || isLocalUrl(activeProfile.baseUrl) || !!activeProfile.apiKey)

  // 长对话且未开启长记忆时，引导开启自动摘要（节省 token + 保持主题连贯）
  const currentChatSession = sessions.find(s => s.id === currentSessionId)
  const showMemoryHint = !!currentCharacter && !!currentSessionId
    && messages.length >= MEMORY_HINT_THRESHOLD
    && !!currentChatSession && !currentChatSession.memoryEnabled
    && memoryHintDismissed !== currentSessionId

  const handleEnableAutoMemory = async () => {
    if (!currentCharacter || !currentSessionId) return
    setMemoryHintDismissed(currentSessionId)
    try {
      const store = useChatStore.getState()
      await store.toggleMemory(currentCharacter.id, currentSessionId, true)
      await store.setMemoryMode(currentCharacter.id, currentSessionId, 'auto')
    } catch (e) {
      logError('ChatPage:enableAutoMemory', e)
    }
  }

  // 上下文上限预警（P1-3）：读取最近一次 buildContext 的用量
  const lastContextUsage = useChatStore((s) => s.lastContextUsage)
  const contextUsage = lastContextUsage && lastContextUsage.max > 0
    ? {
        used: lastContextUsage.used,
        max: lastContextUsage.max,
        ratio: lastContextUsage.used / lastContextUsage.max,
        pct: Math.min(999, Math.round((lastContextUsage.used / lastContextUsage.max) * 100)),
      }
    : null

  const handleSummarizeFromWarning = async () => {
    if (!currentCharacter) return
    try {
      const store = useChatStore.getState()
      const result = await store.triggerMemorySummary(currentCharacter)
      if (!result) {
        // 记忆未启用时提示引导
        if (currentSessionId) await store.toggleMemory(currentCharacter.id, currentSessionId, true)
      }
    } catch (e) {
      logError('ChatPage:summarizeFromWarning', e)
    }
  }

  // 加载消息（切换角色时）
  useEffect(() => {
    if (currentCharacter) {
      // 切换角色时取消任何进行中的流式请求
      if (useChatStore.getState().isStreaming) {
        useChatStore.getState().stopStreaming()
      }
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
          logError('ChatPage:loadSession', err)
        })
      // B-05 修复：切换角色时替换（非合并）预设为新角色的绑定
      const chatStore = useChatStore.getState()
      // 预设：有绑定则激活，无绑定则重置为 null
      const targetPreset = currentCharacter.boundPresetId ?? null
      if (targetPreset !== chatStore.activePresetId) {
        chatStore.setActivePreset(targetPreset)
      }
      // 世界书：由 loadMessages → syncLorebooksFromCurrentSession 处理，不在此处手动同步
    } else {
      clearMessages()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCharacter?.id])

  // 加载 persona 列表
  useEffect(() => { loadPersonas() }, [loadPersonas])

  // 流式输出时自动滚动到底部：每次内容更新都锁定最后一行
  useEffect(() => {
    if (!isStreaming || !settings.autoScroll) return
    requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({ index: messages.length - 1, align: 'end', behavior: 'auto' })
    })
  }, [messages, isStreaming, settings.autoScroll])

  // 全局键盘快捷键事件监听
  useEffect(() => {
    const handleExportChat = async () => {
      await handleExport()
    }
    const handleCopyLastAi = async () => {
      const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
      if (lastAssistant) {
        await navigator.clipboard.writeText(lastAssistant.content)
      }
    }
    window.addEventListener('shortcut:export-chat', handleExportChat)
    window.addEventListener('shortcut:copy-last-ai', handleCopyLastAi)
    return () => {
      window.removeEventListener('shortcut:export-chat', handleExportChat)
      window.removeEventListener('shortcut:copy-last-ai', handleCopyLastAi)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, currentCharacter, currentSessionId])

  // 新建会话统一入口（从 ChatHeader 触发）：检查绑定世界书 → 弹窗确认 → 创建会话
  const handleCreateSession = () => {
    checkBoundLorebooks(async () => {
      if (!currentCharacter) return
      const store = useChatStore.getState()
      await store.createSession(currentCharacter.id)
      // 如果有开场白，弹出选择器
      const hasGreetings = currentCharacter.firstMessage || (currentCharacter.alternateGreetings && currentCharacter.alternateGreetings.length > 0)
      if (hasGreetings) {
        setGreetingPickerOpen(true)
      }
    })
  }

  // 全局快捷键 Ctrl+N / 命令面板“新建对话”：监听 App 派发的事件
  useEffect(() => {
    const handleNewChat = () => handleCreateSession()
    window.addEventListener('shortcut:new-chat', handleNewChat)
    return () => window.removeEventListener('shortcut:new-chat', handleNewChat)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCharacter])

  // 字符统计：增量缓存——每条消息的 countChars 结果按 id 缓存，
  // 流式时只有正在生成的消息变化，其余消息不再重复正则统计（P1 修复）
  const charCountCacheRef = useRef(new Map<string, number>())
  const totalChars = useMemo(() => {
    const cache = charCountCacheRef.current
    // 清理已删除消息的缓存条目（防长会话内存膨胀）
    if (cache.size > messages.length + 50) {
      const alive = new Set(messages.map((m) => m.id))
      for (const id of [...cache.keys()]) {
        if (!alive.has(id)) cache.delete(id)
      }
    }
    let sum = 0
    for (const m of messages) {
      const cached = cache.get(m.id)
      if (cached !== undefined) {
        sum += cached
      } else {
        const c = countChars(m.content).total
        cache.set(m.id, c)
        sum += c
      }
    }
    return sum
  }, [messages])

  // 检查角色是否有绑定的世界书，如果有则弹窗确认
  const checkBoundLorebooks = (callback: () => void) => {
    if (!currentCharacter) {
      callback()
      return
    }
    const boundIds = getEffectiveLorebookIds(currentCharacter)
    if (boundIds.length === 0) {
      callback()
      return
    }
    // 检查是否已经激活了这些世界书
    const currentSet = new Set(activeLorebookIds)
    const allActive = boundIds.every(id => currentSet.has(id))
    if (allActive) {
      callback()
      return
    }
    // 弹窗确认，存储回调
    pendingSessionCallbackRef.current = callback
    setPendingLorebookIds(boundIds)
    setShowLorebookConfirm(true)
  }

  // 确认使用绑定的世界书
  const handleLorebookConfirm = async (useLorebooks: boolean) => {
    setShowLorebookConfirm(false)
    if (useLorebooks && pendingLorebookIds.length > 0) {
      setActiveLorebooks(pendingLorebookIds, currentCharacter?.id)
    }
    setPendingLorebookIds([])
    // 执行待处理的会话创建回调
    if (pendingSessionCallbackRef.current) {
      pendingSessionCallbackRef.current()
      pendingSessionCallbackRef.current = null
    }
  }

  // 导出对话
  const handleExport = async () => {
    if (!currentCharacter || !currentSessionId) return
    const content = await window.api.chat.exportChat(currentCharacter.id, currentSessionId, 'md')
    downloadFile(content, `${currentCharacter.name}-对话.md`)
  }

  // 使用选中开场白开始对话（P-7：复用 store 统一入口，消除重复的建会话/同步 persona/插消息逻辑）
  const handleStartWithGreeting = async () => {
    if (!currentCharacter || !selectedGreeting) return
    setGreetingPickerOpen(false)

    // 检查绑定的世界书
    checkBoundLorebooks(async () => {
      const store = useChatStore.getState()
      const sid = store.currentSessionId
      if (!sid) {
        // 没有会话：创建新会话（含默认记忆/persona 同步）+ 插入开场白
        await store.createSessionWithGreeting(currentCharacter, selectedGreeting)
      } else {
        // 已有（空）会话：直接插入开场白
        await store.insertGreetingMessage(currentCharacter, selectedGreeting)
      }
    })
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

  // 聊天背景：优先使用 chatBackgroundParams.useCover（角色封面）或手动设置的背景图/渐变
  // P-6 修复：引用回复查找 O(n)→O(1)——构建 id→message 索引，仅在 messages 变化时重建
  const messageMap = useMemo(() => {
    const map = new Map<string, Message>()
    for (const m of messages) map.set(m.id, m)
    return map
  }, [messages])

  const effectiveBg = useMemo(() => {
    const params = currentCharacter?.chatBackgroundParams
    const coverSrc = currentCharacter?.cover || currentCharacter?.avatar
    if (params?.useCover && coverSrc) {
      return {
        src: coverSrc,
        type: 'image' as const,
        opacity: params.opacity ?? 12,
        blur: params.blur ?? 0,
        posX: params.posX ?? 50,
        posY: params.posY ?? 50,
        scale: params.scale ?? 100,
      }
    }
    if (currentCharacter?.chatBackground) {
      return {
        src: currentCharacter.chatBackground,
        type: params?.type ?? 'image',
        opacity: params?.opacity ?? 12,
        blur: params?.blur ?? 2,
        posX: params?.posX ?? 50,
        posY: params?.posY ?? 50,
        scale: params?.scale ?? 100,
        gradient: params?.gradient,
      }
    }
    return null
  }, [currentCharacter?.chatBackground, currentCharacter?.chatBackgroundParams, currentCharacter?.avatar, currentCharacter?.cover])

  // 首次使用引导（抽取至 ChatWelcomeGuide）
  if (loaded && !isConnected) {
    return <ChatWelcomeGuide />
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
                filter: effectiveBg.blur > 0 ? `blur(${effectiveBg.blur}px)` : undefined,
                objectPosition: `${effectiveBg.posX}% ${effectiveBg.posY}%`,
                transform: `scale(${effectiveBg.scale / 100})`,
                imageRendering: 'auto',
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
      <ChatHeader
        currentCharacter={currentCharacter}
        messages={messages}
        isStreaming={isStreaming}
        totalChars={totalChars}
        showQuickSettings={showQuickSettings}
        showBgPanel={showBgPanel}
        onExport={handleExport}
        onClearConfirm={() => setShowClearConfirm(true)}
        onShowContextViewer={() => setShowContextViewer(true)}
        onShowQuickSettings={() => setShowQuickSettings(!showQuickSettings)}
        onShowBgPanel={() => setShowBgPanel(!showBgPanel)}
        onShowGreetingPicker={() => {
          setSelectedGreeting(currentCharacter.translatedContent?.firstMessage ?? currentCharacter.firstMessage)
          setGreetingPickerOpen(true)
        }}
        onCreateSession={handleCreateSession}
      />

      {/* 状态栏 — 有消息或有激活世界书时显示 */}
      {currentCharacter && (
        <div className="relative z-10"><StatusBar character={currentCharacter} messages={messages} /></div>
      )}

      {/* 长对话摘要引导提示条 */}
      {showMemoryHint && (
        <div className="relative z-10 flex items-center gap-2 px-4 py-1.5 text-xs bg-tavern-accent-soft border-b border-tavern-border-soft animate-fade-in">
          <Sparkles className="w-3.5 h-3.5 text-tavern-accent shrink-0" />
          <span className="flex-1 text-tavern-text-soft truncate">对话较长，开启自动摘要可节省 token 并保持主题连贯</span>
          <button
            onClick={handleEnableAutoMemory}
            className="px-2 py-0.5 rounded font-medium text-tavern-accent hover:bg-tavern-accent/10 transition-colors shrink-0"
          >
            开启
          </button>
          <button
            onClick={() => setMemoryHintDismissed(currentSessionId)}
            className="text-tavern-text-muted hover:text-tavern-text transition-colors shrink-0"
            title="本次会话不再提示"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 上下文上限预警（P1-3）：用量 ≥85% 显示 */}
      {contextUsage && contextUsage.ratio >= 0.85 && (
        <div className={cn(
          'relative z-10 flex items-center gap-2 px-4 py-1.5 text-xs border-b animate-fade-in',
          contextUsage.ratio >= 1 ? 'bg-tavern-danger/10 border-tavern-danger/20' : 'bg-tavern-warning/10 border-tavern-warning/20'
        )}>
          <AlertTriangle className={cn('w-3.5 h-3.5 shrink-0', contextUsage.ratio >= 1 ? 'text-tavern-danger' : 'text-tavern-warning')} />
          <span className="flex-1 text-tavern-text-soft truncate">
            上下文已使用 {contextUsage.pct}%（{contextUsage.used}/{contextUsage.max} token）
            {contextUsage.ratio >= 1 ? '，将裁剪早期历史' : '，接近上限将裁剪早期历史'}
          </span>
          <button
            onClick={handleSummarizeFromWarning}
            className="px-2 py-0.5 rounded font-medium text-tavern-accent hover:bg-tavern-accent/10 transition-colors shrink-0"
          >
            立即总结
          </button>
          <button
            onClick={() => useChatStore.getState().clearChat(currentCharacter!.id)}
            className="px-2 py-0.5 rounded font-medium text-tavern-text-muted hover:text-tavern-danger hover:bg-tavern-danger/10 transition-colors shrink-0"
          >
            清理历史
          </button>
        </div>
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
            description={`与 ${getDisplayName(currentCharacter)} 开始你的故事`}
          />
        ) : (
          <Virtuoso
            key={currentSessionId || 'empty'}
            ref={virtuosoRef}
            data={messages}
            className="h-full"
            initialTopMostItemIndex={999999}
            followOutput={settings.autoScroll ? 'smooth' : false}
            itemContent={(index, msg) => {
              const replied = msg.replyToId ? (messageMap.get(msg.replyToId) ?? null) : null
              return (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  character={currentCharacter}
                  isLast={index === messages.length - 1}
                  repliedMessage={replied}
                  onReply={() => setReplyToMessage(msg)}
                />
              )
            }}
            components={{
              Footer: () => <div ref={messagesEndRef} className="h-4" />,
            }}
          />
        )}
      </div>

      {/* 输入区 */}
      <div className="relative z-10">
        <ChatInput
          character={currentCharacter}
          replyTo={replyToMessage}
          onCancelReply={() => setReplyToMessage(null)}
        />
      </div>

      {/* 清空确认 */}
      <ConfirmDialog
        open={showClearConfirm}
        onClose={() => setShowClearConfirm(false)}
        onConfirm={async () => {
          await clearChat(currentCharacter.id)
          // 清空后自动插入开场白或弹出选择器（P-7：复用 insertGreetingMessage）
          const hasAltGreetings = currentCharacter.alternateGreetings && currentCharacter.alternateGreetings.length > 0
          if (hasAltGreetings) {
            setSelectedGreeting(currentCharacter.translatedContent?.firstMessage ?? currentCharacter.firstMessage)
            setGreetingPickerOpen(true)
          } else if (currentCharacter.firstMessage) {
            await useChatStore.getState().insertGreetingMessage(currentCharacter, currentCharacter.firstMessage)
          }
        }}
        title="清空对话"
        message={`确定要清空与 ${getDisplayName(currentCharacter)} 的所有对话记录吗？此操作不可撤销。`}
        confirmText="清空"
        danger
      />

      {/* 世界书绑定确认 */}
      <ConfirmDialog
        open={showLorebookConfirm}
        onClose={() => {
          setShowLorebookConfirm(false)
          setPendingLorebookIds([])
        }}
        onConfirm={() => handleLorebookConfirm(true)}
        cancelText="不使用"
        title="使用绑定的世界书"
        message={`当前角色绑定了 ${pendingLorebookIds.length} 个世界书，是否在本次对话中使用？`}
        confirmText="使用"
      />

      {/* 快捷设置面板 */}
      <QuickSettingsPanel open={showQuickSettings} onClose={() => setShowQuickSettings(false)} />
      <BackgroundPanel open={showBgPanel} onClose={() => setShowBgPanel(false)} />

      {/* 开场白选择面板（抽取至 ChatGreetingPickerModal） */}
      <ChatGreetingPickerModal
        open={greetingPickerOpen && !!currentCharacter}
        character={currentCharacter}
        selectedGreeting={selectedGreeting}
        userName={settings.userName}
        onSelectGreeting={setSelectedGreeting}
        onClose={() => { setGreetingPickerOpen(false); setSelectedGreeting('') }}
        onStart={handleStartWithGreeting}
      />

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
