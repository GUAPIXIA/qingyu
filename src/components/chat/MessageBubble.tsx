import React, { useState, useRef, useEffect, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { charAssetUrl } from '../../utils/asset'
import { Check, X, User, Bot, ChevronLeft, ChevronRight, Image as ImageIcon, ChevronsDown, RefreshCw, Reply, Loader2, Languages, Globe2, FileText, Trash2 } from 'lucide-react'
import type { Message, Character } from '../../../shared/types'
import { useChatStore } from '../../store/useChatStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { usePersonaStore } from '../../store/usePersonaStore'
import { cn } from '../../lib/utils'
import { ErrorBoundary } from '../common/ErrorBoundary'
import { formatTime } from '../../utils/format'
import { countChars, formatCharCount } from '../../utils/charCounter'
import { remarkRoleplay } from '../../utils/remark-roleplay'
import { extractThought, stripThought } from '../../utils/messagePostProcess'
import { buildRoleplayBlocks, stripOuterQuotes, splitQuoteSegments } from '../../utils/roleplayBlocks'
import { getDisplayName } from '../../utils/variables'
import { resolveMessageSpeakerKind } from '../../../shared/messageIdentity'

interface MessageBubbleProps {
  message: Message
  character: Character | null
  isLast: boolean
  /** 被引用消息（P1-5 引用回复） */
  repliedMessage?: Message | null
  /** 触发引用该消息 */
  onReply?: () => void
}

import { MarkdownImage } from '../common/MarkdownImage'
import { MarkdownLink } from '../common/MarkdownLink'
import { MessageActionBar } from './MessageActionBar'
import { DialogueDirectionCard } from './DialogueDirectionCard'
import { shouldShowDialogueDirections } from './dialogueDirectionView'
import { generateSingleDialogueDirections } from '../../store/dialogueDirectionRunner'
import { resolveDialogueDirectionsEnabled } from '../../../shared/dialogueDirections'
import { remarkAudio } from '../../utils/remark-audio'
import { Modal } from '../common/Modal'

/** 消息内嵌 <audio> 播放器（对齐安卓端：外部音频 URL，白名单 http/https） */
function MarkdownAudio({ src }: { src?: string }) {
  if (!src) return null
  return (
    <audio
      controls
      loop
      preload="none"
      src={src}
      style={{ width: '100%', maxWidth: 320, height: 44, margin: '4px 0' }}
    />
  )
}

const markdownComponents = { img: MarkdownImage, a: MarkdownLink, audio: MarkdownAudio }

// B-05：已播放过入场动画的消息 ID，避免虚拟滚动时反复播放
// BUG-18 修复：限制 Set 上限，超出时淘汰最早标记的 ID，避免长时间使用内存无限增长
const ANIMATED_IDS_MAX = 500
const animatedIds = new Set<string>()
function markAnimated(id: string): void {
  if (animatedIds.size >= ANIMATED_IDS_MAX) {
    const oldest = animatedIds.values().next().value
    if (oldest !== undefined) animatedIds.delete(oldest)
  }
  animatedIds.add(id)
}

export const MessageBubble = React.memo(function MessageBubble({ message, character, isLast, repliedMessage, onReply }: MessageBubbleProps) {
  const shouldAnimate = !animatedIds.has(message.id)
  // NEW-L7 修复：标记移入 effect，避免渲染阶段执行副作用（React 并发/严格模式下的不纯渲染）
  useEffect(() => {
    if (shouldAnimate) markAnimated(message.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message.id])
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState(message.content)
  const [imgErrors, setImgErrors] = useState<Set<number>>(new Set())
  const [avatarError, setAvatarError] = useState(false)
  const [zoomImage, setZoomImage] = useState<string | null>(null)
  const [imageContextMenu, setImageContextMenu] = useState<{ x: number; y: number; imageIndex: number } | null>(null)
  const [showImagePrompt, setShowImagePrompt] = useState(false)
  const [regeneratingImageIndex, setRegeneratingImageIndex] = useState<number | null>(null)
  const [continuing, setContinuing] = useState(false)
  /** OpenAI/Edge TTS 音频播放器（渲染进程播放 mp3） */
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const editMessage = useChatStore(s => s.editMessage)
  const deleteMessage = useChatStore(s => s.deleteMessage)
  const updateMessageImages = useChatStore(s => s.updateMessageImages)
  const continueMessage = useChatStore(s => s.continueMessage)
  const swipeMessage = useChatStore(s => s.swipeMessage)
  const isStreaming = useChatStore(s => s.isStreaming)
  const translatingMessages = useChatStore(s => s.translatingMessages)
  const showTranslationIds = useChatStore(s => s.showTranslationIds)
  // P-6 修复：字段级选择器订阅（此前无选择器，settings 任何变化都重渲染全部气泡）
  const settings = useSettingsStore((s) => s.settings)
  const sessions = useChatStore(s => s.sessions)
  const currentSessionId = useChatStore(s => s.currentSessionId)
  const [thoughtExpanded, setThoughtExpanded] = useState(settings.autoExpandThought ?? false)
  const [directionError, setDirectionError] = useState<string | null>(null)
  const dialogueDirectionsEnabled = resolveDialogueDirectionsEnabled(
    sessions.find((session) => session.id === (message.sessionId || currentSessionId)),
  )
  const getPersona = usePersonaStore((s) => s.getPersona)
  const persona = getPersona(settings.activePersonaId)

  // 全局翻译状态
  const transState = translatingMessages[message.id]
  const showTranslation = showTranslationIds.has(message.id)
  const isTranslating = transState?.status === 'translating'

  // P-3 修复：用 useMemo 缓存 thought 解析，避免每次渲染都执行正则循环
  const { thought, originalDisplay } = useMemo(() => {
    const { thought: t, content } = extractThought(message.content || '')
    return { thought: t, originalDisplay: content }
  }, [message.content])

  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'
  const speakerKind = resolveMessageSpeakerKind(message)
  const isNarrator = speakerKind === 'narrator'
  const isPersona = speakerKind === 'persona'
  const isDisplaySystem = speakerKind === 'system'
  const isStreamingThis = isStreaming && isLast && !isUser

  // 决定显示的文本
  const displayContent = useMemo(() => {
    if (showTranslation) {
      // 优先内存翻译结果，回退到持久化的 message.translation（重启/状态丢失后仍能显示译文）
      const translated = transState?.content || message.translation || ''
      const cleaned = stripThought(translated)
      if (cleaned) return cleaned
    }
    return originalDisplay || ''
  }, [showTranslation, transState?.content, message.translation, originalDisplay])

  // 阶段5：语义分块（仅 blocks 模式的新消息；旧消息走 Markdown 兼容渲染）。
  // 译文展示时同样按译文分块。
  const semanticBlocks = useMemo(
    () => (message.contentRenderMode === 'blocks' ? buildRoleplayBlocks(displayContent) : null),
    [message.contentRenderMode, displayContent],
  )

  // B-05：纯图片消息，气泡不应撑满整行
  const hasOnlyImages = message.images?.length > 0
    && (isSystem || (!displayContent && !thought))

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus()
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px'
    }
  }, [editing])

  useEffect(() => {
    if (!imageContextMenu) return
    const closeMenu = () => setImageContextMenu(null)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu()
    }
    window.addEventListener('resize', closeMenu)
    window.addEventListener('scroll', closeMenu, true)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('resize', closeMenu)
      window.removeEventListener('scroll', closeMenu, true)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [imageContextMenu])

  const handleSaveEdit = async () => {
    if (!character) return
    // Visible feedback should not wait for background memory invalidation and persistence.
    setEditing(false)
    try {
      await editMessage(message.id, editContent, character)
    } catch (error) {
      // Reopen with the draft intact so the user can retry.
      setEditing(true)
      useChatStore.setState({ error: `保存编辑失败：${error instanceof Error ? error.message : String(error)}` })
    }
  }

  const handleMarkdownClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (target.tagName === 'IMG' && (target as HTMLImageElement).src) {
      setZoomImage((target as HTMLImageElement).src)
    }
  }

  const handleGeneratedImageContextMenu = (event: React.MouseEvent, imageIndex: number) => {
    event.preventDefault()
    event.stopPropagation()
    const menuWidth = 208
    const menuHeight = 136
    const edgeGap = 8
    setImageContextMenu({
      x: Math.max(edgeGap, Math.min(event.clientX, window.innerWidth - menuWidth - edgeGap)),
      y: Math.max(edgeGap, Math.min(event.clientY, window.innerHeight - menuHeight - edgeGap)),
      imageIndex,
    })
  }

  const handleDeleteGeneratedImage = async (imageIndex: number) => {
    setImageContextMenu(null)
    if (!character) return
    if (message.images.length <= 1) {
      await deleteMessage(message.id, character)
      return
    }
    await updateMessageImages(message.id, message.images.filter((_, index) => index !== imageIndex))
  }

  const handleRegenerateGeneratedImage = async (imageIndex: number) => {
    setImageContextMenu(null)
    if (regeneratingImageIndex !== null) return
    const prompt = message.content.trim()
    if (!prompt) {
      useChatStore.setState({ error: '无法重新生图：这张图片没有保存生图提示词' })
      return
    }

    setRegeneratingImageIndex(imageIndex)
    try {
      const result = await window.api.imageGen.generate(prompt)
      if (!result.success || !result.images?.length) {
        useChatStore.setState({ error: `重新生图失败: ${result.error || '未知错误'}` })
        return
      }
      const regeneratedImage = result.images[0]
      await updateMessageImages(
        message.id,
        message.images.map((image, index) => index === imageIndex ? regeneratedImage : image),
      )
    } catch (error) {
      useChatStore.setState({ error: `重新生图失败: ${error instanceof Error ? error.message : String(error)}` })
    } finally {
      setRegeneratingImageIndex(null)
    }
  }

  if (editing) {
    return (
      <div className="px-4 py-2 animate-fade-in">
        <div className="mx-auto" style={{ maxWidth: `${settings.messageWidth ?? 768}px` }}>
          <textarea
            ref={textareaRef}
            value={editContent}
            onChange={(e) => {
              setEditContent(e.target.value)
              e.target.style.height = 'auto'
              e.target.style.height = e.target.scrollHeight + 'px'
            }}
            className="textarea w-full min-h-[80px] font-mono text-sm"
          />
          <div className="flex justify-end gap-2 mt-2">
            <button className="btn-ghost" onClick={() => { setEditing(false); setEditContent(message.content) }}>
              <X className="w-4 h-4" /> 取消
            </button>
            <button className="btn-primary" onClick={handleSaveEdit}>
              <Check className="w-4 h-4" /> 保存
            </button>
          </div>
        </div>
      </div>
    )
  }

  // B-05：纯图片系统消息（生图结果）用独立居中布局，不需要头像和气泡
  if (isSystem && hasOnlyImages) {
    return (
      <>
        <div
          data-image-only="true"
          className={cn('px-4', shouldAnimate && 'animate-fade-in-up')}
          style={{ marginBottom: `${settings.messageSpacing}px` }}
        >
          <div className="flex justify-center">
            <div className="flex flex-wrap gap-2 justify-center">
              {message.images.map((img, i) => (
                imgErrors.has(i) ? (
                  <button
                    key={i}
                    onClick={() => setImgErrors(prev => { const next = new Set(prev); next.delete(i); return next })}
                    className="w-24 h-24 rounded-lg bg-tavern-bg-hover flex flex-col items-center justify-center text-tavern-text-muted text-xs gap-1 cursor-pointer hover:bg-tavern-bg-hover/80 transition-colors"
                    title="点击重新加载"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>加载失败</span>
                  </button>
                ) : (
                  <div key={i} className="relative overflow-hidden rounded-lg">
                    <img
                      src={img}
                      alt={`生成图片 ${i + 1}`}
                      className={cn(
                        'max-w-48 max-h-48 rounded-lg object-cover cursor-pointer hover:opacity-80 transition-opacity',
                        regeneratingImageIndex === i && 'opacity-50',
                      )}
                      onClick={() => regeneratingImageIndex === null && setZoomImage(img)}
                      onContextMenu={(event) => handleGeneratedImageContextMenu(event, i)}
                      onError={() => setImgErrors((prev) => new Set(prev).add(i))}
                    />
                    {regeneratingImageIndex === i && (
                      <div
                        role="status"
                        aria-label={`正在重新生成图片 ${i + 1}`}
                        className="absolute inset-0 flex items-center justify-center bg-black/25 backdrop-blur-[1px]"
                      >
                        <Loader2 className="h-6 w-6 animate-spin text-white drop-shadow" />
                      </div>
                    )}
                  </div>
                )
              ))}
            </div>
          </div>
        </div>
        {/* 图片查看器 */}
        {zoomImage && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm cursor-zoom-out animate-fade-in" onClick={() => setZoomImage(null)}>
            <img src={zoomImage} alt="" className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl" />
            <button className="absolute top-4 right-4 p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors" onClick={(e) => { e.stopPropagation(); setZoomImage(null) }}><X className="w-6 h-6" /></button>
          </div>
        )}
        {imageContextMenu && (
          <>
            <div className="fixed inset-0 z-[109]" aria-hidden onClick={() => setImageContextMenu(null)} />
            <div
              role="menu"
              aria-label="生成图片操作"
              className="fixed z-[110] w-52 overflow-hidden rounded-xl border border-tavern-border bg-tavern-bg-card/95 p-1.5 shadow-2xl backdrop-blur-md animate-fade-in"
              style={{ left: imageContextMenu.x, top: imageContextMenu.y }}
            >
              <button
                role="menuitem"
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-tavern-text transition-colors hover:bg-tavern-bg-hover focus-visible:bg-tavern-bg-hover focus-visible:outline-none"
                onClick={() => {
                  setImageContextMenu(null)
                  setShowImagePrompt(true)
                }}
              >
                <FileText className="h-4 w-4 text-tavern-accent" />
                查看生图提示词
              </button>
              <button
                role="menuitem"
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-tavern-text transition-colors hover:bg-tavern-bg-hover focus-visible:bg-tavern-bg-hover focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => handleRegenerateGeneratedImage(imageContextMenu.imageIndex)}
                disabled={regeneratingImageIndex !== null || !message.content.trim()}
                title={!message.content.trim() ? '这张图片没有保存生图提示词' : undefined}
              >
                <RefreshCw className="h-4 w-4 text-tavern-accent" />
                重新生成图片
              </button>
              <div className="mx-2 border-t border-tavern-border-soft" />
              <button
                role="menuitem"
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-tavern-danger transition-colors hover:bg-tavern-danger/10 focus-visible:bg-tavern-danger/10 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => handleDeleteGeneratedImage(imageContextMenu.imageIndex)}
                disabled={!character}
              >
                <Trash2 className="h-4 w-4" />
                删除图片
              </button>
            </div>
          </>
        )}
        <Modal open={showImagePrompt} onClose={() => setShowImagePrompt(false)} title="生图提示词" width="lg">
          <div className="rounded-xl border border-tavern-border-soft bg-tavern-bg-soft px-4 py-3">
            <p className="select-text whitespace-pre-wrap break-words font-mono text-sm leading-6 text-tavern-text">
              {message.content.trim() || '此图片未保存生图提示词'}
            </p>
          </div>
        </Modal>
        {/* 操作栏 */}
        <MessageActionBar bare message={message} character={character} isUser={isUser} isSystem={isSystem} isStreaming={isStreaming} onReply={onReply} onEdit={() => { setEditContent(message.content); setEditing(true) }} />
      </>
    )
  }

  return (
    <>
    <div className={cn('px-4 group', shouldAnimate && 'animate-fade-in-up')} style={{ marginBottom: `${settings.messageSpacing}px` }}>
      <div className={cn('mx-auto flex gap-4', isUser && 'flex-row-reverse')} style={hasOnlyImages ? { maxWidth: `${settings.messageWidth ?? 768}px` } : { maxWidth: `${settings.messageWidth ?? 768}px`, width: '100%' }}>
        {/* 头像 */}
        <div
          className={cn(
            'w-10 h-10 rounded-full flex items-center justify-center shrink-0',
            isNarrator
              ? 'bg-gradient-to-br from-slate-500/20 to-indigo-500/15 text-indigo-500 ring-2 ring-indigo-500/20 dark:text-indigo-300'
              : isPersona
                ? 'bg-gradient-to-br from-tavern-user/30 to-tavern-user/10 text-tavern-user ring-2 ring-tavern-user/20'
                : isDisplaySystem
                ? 'bg-gradient-to-br from-tavern-accent/30 to-tavern-accent/10 text-tavern-accent ring-2 ring-tavern-accent/20'
                : 'bg-gradient-to-br from-tavern-assistant/30 to-tavern-assistant/10 text-tavern-assistant ring-2 ring-tavern-assistant/20'
          )}
        >
          {isNarrator ? (
            <Globe2 className="w-5 h-5" aria-label="旁白" />
          ) : isPersona ? (
            persona?.avatar && !avatarError ? (
              <img src={persona.avatar} alt="" className="w-full h-full rounded-full object-cover" onError={() => setAvatarError(true)} />
            ) : (
              <User className="w-5 h-5" />
            )
          ) : isDisplaySystem ? (
            <ImageIcon className="w-5 h-5" />
          ) : !avatarError && character ? (
            <img src={character.avatar || charAssetUrl(character.id, 'avatar', character.updatedAt)} alt="" className="w-full h-full rounded-full object-cover" onError={() => setAvatarError(true)} />
          ) : (
            <Bot className="w-5 h-5" />
          )}
        </div>

        {/* 消息内容 */}
        <div className={cn(isUser && 'flex flex-col items-end', hasOnlyImages ? 'w-fit' : 'flex-1 min-w-0')}>
          {/* 名字和时间 */}
          <div className={cn('flex items-center gap-2 mb-1 text-xs text-tavern-text-muted', isUser && 'flex-row-reverse')}>
            <span className="font-medium text-tavern-text-soft">
              {isNarrator ? '旁白' : isPersona ? settings.userName : isDisplaySystem ? '系统' : getDisplayName(character) || 'AI'}
            </span>
            {isNarrator && character && (
              <span className="rounded-full border border-indigo-400/20 bg-indigo-500/10 px-1.5 py-0.5 text-[10px] text-indigo-600 dark:text-indigo-300">
                推动焦点 · {getDisplayName(character)}
              </span>
            )}
            <span>{formatTime(message.timestamp)}</span>
            {settings.showTokenCount && message.content && (
              <span className="px-1.5 py-0.5 rounded bg-tavern-bg-hover text-tavern-text-muted/70 text-[10px]" title={message.charUsage ? `输入: ${message.charUsage.inputChars} 字符 · 输出: ${message.charUsage.outputChars} 字符` : ''}>
                {message.charUsage ? formatCharCount(message.charUsage.totalChars) : formatCharCount(countChars(message.content).total)}
              </span>
            )}
            {/* Swipe 多候选切换指示器 */}
            {!isUser && !isSystem && message.swipes && message.swipes.length > 1 && (
              <div className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-tavern-bg-hover">
                <button
                  className="p-0.5 rounded hover:text-tavern-text hover:bg-tavern-bg disabled:opacity-30"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (character) swipeMessage(message.id, -1, character)
                  }}
                  disabled={isStreaming}
                  title="上一个候选"
                >
                  <ChevronLeft className="w-3 h-3" />
                </button>
                <span className="tabular-nums text-[10px] min-w-[28px] text-center">
                  {(message.swipeIndex ?? 0) + 1}/{message.swipes.length}
                </span>
                <button
                  className="p-0.5 rounded hover:text-tavern-text hover:bg-tavern-bg disabled:opacity-30"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (character) swipeMessage(message.id, 1, character)
                  }}
                  disabled={isStreaming}
                  title="下一个候选"
                >
                  <ChevronRight className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>

          {/* 气泡 */}
          <div
            className={cn(
              'msg-bubble max-w-full',
              hasOnlyImages ? 'p-2' : 'px-5 py-3.5',
              isUser && !hasOnlyImages && 'w-fit',
              settings.bubbleStyle === 'round' && 'rounded-2xl',
              settings.bubbleStyle === 'standard' && 'rounded-lg',
              settings.bubbleStyle === 'sharp' && 'rounded-sm',
              isNarrator
                ? 'border border-indigo-200/70 bg-gradient-to-bl from-slate-50 to-indigo-50/70 rounded-br-sm shadow-sm text-slate-900 dark:border-indigo-700/40 dark:from-slate-900/95 dark:to-indigo-950/55 dark:text-slate-100 bubble-narrator'
                : isPersona
                  ? 'bg-gradient-to-bl from-amber-100 to-orange-50 border border-amber-200/60 rounded-br-sm shadow-md dark:from-amber-900/70 dark:to-orange-900/70 dark:border-amber-700/60 text-amber-950 dark:text-amber-50 bubble-user'
                  : 'bg-tavern-bg-card border border-tavern-border rounded-bl-sm shadow-sm text-slate-900 dark:text-slate-100'
            )}
          >
            {/* 引用回复：被引用消息摘要（P1-5） */}
            {repliedMessage && (
              <button
                type="button"
                onClick={onReply ? () => onReply() : undefined}
                className="w-full flex items-start gap-1.5 mb-2 px-2.5 py-1.5 rounded-lg bg-tavern-bg-soft/80 border border-tavern-border-soft text-left hover:bg-tavern-bg-hover transition-colors"
                title="点击引用这条消息"
              >
                <Reply className="w-3 h-3 text-tavern-accent shrink-0 mt-0.5" />
                <span className="min-w-0 flex-1 text-xs">
                  <span className="text-tavern-accent font-medium">
                    {repliedMessage.role === 'user' ? (settings.userName || '用户') : repliedMessage.role === 'system' ? '系统' : (character?.name ?? '角色')}:
                  </span>
                  <span className="text-tavern-text-muted ml-1 line-clamp-2">
                    {(repliedMessage.content || '').slice(0, 80)}
                    {(repliedMessage.content || '').length > 80 ? '...' : ''}
                  </span>
                </span>
              </button>
            )}
            {message.images?.length > 0 && (
              <ErrorBoundary fallback={<div className="text-xs text-tavern-danger">⚠️ 图片加载异常</div>}>
              <div className={cn('flex flex-wrap gap-2', (displayContent || thought) && 'mb-2')}>
                {message.images.map((img, i) => (
                  imgErrors.has(i) ? (
                    <button
                      key={i}
                      onClick={() => setImgErrors(prev => { const next = new Set(prev); next.delete(i); return next })}
                      className="w-24 h-24 rounded-lg bg-tavern-bg-hover flex flex-col items-center justify-center text-tavern-text-muted text-xs gap-1 cursor-pointer hover:bg-tavern-bg-hover/80 transition-colors"
                      title="点击重新加载"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>加载失败</span>
                    </button>
                  ) : (
                    <img
                      key={i}
                      src={img}
                      alt=""
                      className="max-w-48 max-h-48 rounded-lg object-cover cursor-pointer hover:opacity-80 transition-opacity"
                      onClick={() => setZoomImage(img)}
                      onError={() => setImgErrors((prev) => new Set(prev).add(i))}
                    />
                  )
                ))}
              </div>
              </ErrorBoundary>
            )}
            {/* 心理描写折叠区块 */}
            {thought && !isSystem && (
              <div className="mb-2 rounded-lg bg-tavern-bg-soft border border-tavern-border-soft px-3 py-2">
                <button
                  onClick={() => setThoughtExpanded(!thoughtExpanded)}
                  className="text-xs text-tavern-text-muted flex items-center gap-1 hover:text-tavern-text-soft"
                >
                  <span>💭 内心想法</span>
                  <span>{thoughtExpanded ? '▼' : '▶'}</span>
                </button>
                {thoughtExpanded && (
                  <div className="mt-1.5 text-sm italic text-tavern-text-muted select-text whitespace-pre-wrap" style={{ userSelect: 'text' }}>
                    {thought}
                  </div>
                )}
              </div>
            )}
            {/* system 消息只显示图片，不渲染对话文本 */}
            {!isSystem && (
            <div className={cn('markdown-body', isStreamingThis && 'typing-cursor')} onClick={handleMarkdownClick}>
              {/* BUG-09 修复：移除 rehypeRaw / allowDangerousHtml，防止消息内容中的原始 HTML（如 <script>、<img onerror>）执行导致 XSS */}
              <ErrorBoundary fallback={<pre className="text-xs text-tavern-danger whitespace-pre-wrap break-all">⚠️ 消息渲染异常</pre>}>
              {semanticBlocks ? (
                /* 阶段5：语义分块渲染——对白/叙述/混合段按 kind 呈现样式，不依赖模型手写星号与说话人前缀。
                   复用 markdown 路径同一套 CSS class（dialogue-block / action-block），避免 blocks 消息“无样式”。 */
                <div className="space-y-2">
                  {semanticBlocks.map((block, index) => {
                    if (block.kind === 'dialogue') {
                      // 对白块：左竖线引用形态；匿名对白（模型未写名字）同样结构、无名字行；展示层剥外层引号
                      return (
                        <p key={index} className="dialogue-block whitespace-pre-wrap select-text">
                          {block.speaker && <em className="dialogue-speaker">{block.speaker}</em>}
                          <em className="dialogue-text">{stripOuterQuotes(block.text)}</em>
                        </p>
                      )
                    }
                    if (block.kind === 'narration') {
                      // 叙述/动作：灰色弱化正文（不斜体、无底色）
                      return (
                        <p key={index} className="action-block whitespace-pre-wrap select-text">
                          {block.text}
                        </p>
                      )
                    }
                    // mixed：普通正文渲染，行内对白按引号段染色（与 remark 路径 dialogue-inline 一致）
                    return (
                      <p key={index} className="whitespace-pre-wrap select-text text-tavern-text">
                        {splitQuoteSegments(block.text).map((seg, segIndex) => seg.quoted ? (
                          <em key={segIndex} className="dialogue-inline">{seg.text}</em>
                        ) : (
                          <React.Fragment key={segIndex}>{seg.text}</React.Fragment>
                        ))}
                      </p>
                    )
                  })}
                  {!displayContent && (thought ? (
                    <p className="text-tavern-text-muted">💭 内容已在"内心想法"中展开</p>
                  ) : !isStreamingThis ? (
                    <p className="text-tavern-text-muted">（空消息）</p>
                  ) : null)}
                </div>
              ) : (
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkRoleplay, remarkAudio]}
                rehypePlugins={[rehypeHighlight]}
                components={markdownComponents}
              >
                {displayContent || (isStreamingThis ? '' : (thought ? '💭 内容已在"内心想法"中展开' : '（空消息）'))}
              </ReactMarkdown>
              )}
              </ErrorBoundary>
            </div>
            )}
            {/* 生成失败/截断提示：错误原因随消息持久化，正文保留不污染 */}
            {!isStreamingThis && message.generationError && (
              <div className="mt-2 text-xs text-tavern-danger">
                ⚠️ 生成中断：{message.generationError}
              </div>
            )}
            {/* 阶段3：非失败性收尾提示（已在完整句处收束/已自动补全/已停止），与失败提示区分 */}
            {!isStreamingThis && !message.generationError && message.generationNotice && (
              <div className="mt-2 text-xs text-tavern-text-muted/80">
                ℹ️ {message.generationNotice}
              </div>
            )}
            {/* 翻译状态指示 */}
            {isTranslating && !transState?.content && (
              <div className="mt-2 flex items-center gap-1.5 text-xs text-tavern-accent">
                <Loader2 className="w-3 h-3 animate-spin" />
                翻译中...
              </div>
            )}
            {transState?.status === 'error' && (
              <div className="mt-2 text-xs text-tavern-danger">
                翻译失败: {transState.errorMsg || '未知错误'}
              </div>
            )}
            {showTranslation && transState?.content && (
              <div className="mt-1 pt-1 border-t border-tavern-border-soft/50 flex items-center gap-1 text-xs text-tavern-accent">
                <Languages className="w-3 h-3" />
                已翻译 (点击翻译按钮可切回原文)
              </div>
            )}
          </div>

          {/* 操作栏 */}
          <MessageActionBar message={message} character={character} isUser={isUser} isSystem={isSystem} isStreaming={isStreaming} onReply={onReply} onEdit={() => { setEditContent(message.content); setEditing(true) }} />

          {/* 下一步方向：气泡外的独立交互，仅最新一条 AI 回复且等待用户时展示 */}
          {shouldShowDialogueDirections({
            message,
            character,
            isStreaming,
            isSystem,
            enabled: dialogueDirectionsEnabled,
          }) && message.dialogueDirections && (
            <DialogueDirectionCard
              directions={message.dialogueDirections}
              canRegenerate={isLast && !isStreaming}
              error={directionError}
              onRegenerate={async () => {
                if (!character) return
                setDirectionError(null)
                const result = await generateSingleDialogueDirections(
                  useChatStore.setState,
                  useChatStore.getState,
                  { messageId: message.id, character },
                )
                if (result.length === 0) setDirectionError('方向生成失败，请稍后重试')
              }}
            />
          )}

          {/* 继续续写按钮 — 始终可见，仅最后一条 assistant 消息 */}
          {isLast && !isUser && !isSystem && !isStreaming && character && (
            <div className="flex justify-center mt-1.5">
              <button
                className={cn(
                  'px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-all flex items-center gap-1.5',
                  continuing
                    ? 'border-tavern-border-soft bg-tavern-bg-card text-tavern-text-muted cursor-not-allowed'
                    : 'border-tavern-accent/40 bg-tavern-accent/5 text-tavern-accent hover:bg-tavern-accent/10 hover:border-tavern-accent/60 hover:shadow-sm',
                )}
                onClick={async () => {
                  setContinuing(true)
                  try {
                    const chatStore = useChatStore.getState()
                    const { preset, lorebooks } = await chatStore.getActiveChatConfig()
                    await continueMessage(message.id, character, preset, lorebooks)
                  } catch (e) {
                    // 提示错误，避免静默失败
                    useChatStore.setState({ error: `续写失败: ${e instanceof Error ? e.message : String(e)}` })
                  }
                  setContinuing(false)
                }}
                disabled={continuing}
                title="让 AI 从上一次回复的结尾继续生成"
              >
                {continuing ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <ChevronsDown className="w-3.5 h-3.5" />
                )}
                继续续写
              </button>
            </div>
          )}
        </div>

        {/* 对侧占位：预留头像宽度，使左右气泡对齐在同一中间列 */}
        <div className="w-10 shrink-0" aria-hidden="true" />
      </div>
    </div>

    {/* 图片放大查看器 */}
    {zoomImage && (
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm cursor-zoom-out animate-fade-in"
        onClick={() => setZoomImage(null)}
      >
        <img
          src={zoomImage}
          alt=""
          className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
        />
        <button
          className="absolute top-4 right-4 p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
          onClick={(e) => { e.stopPropagation(); setZoomImage(null) }}
        >
          <X className="w-6 h-6" />
        </button>
      </div>
    )}
    </>
  )
})
