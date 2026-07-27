import React, { useState, useRef, useEffect, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import { Edit2, Check, X, RotateCcw, Trash2, Copy, Volume2, VolumeX, Play, Pause, User, Bot, Languages, GitBranch, Loader2, ChevronLeft, ChevronRight, Image as ImageIcon, RefreshCw, ChevronsDown } from 'lucide-react'
import type { Message, Character } from '../../../shared/types'
import { useChatStore } from '../../store/useChatStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { usePersonaStore } from '../../store/usePersonaStore'
import { cn } from '../../lib/utils'
import { formatTime } from '../../utils/format'
import { estimateTokens } from '../../utils/tokenCounter'
import { parseDialogue } from '../../utils/dialogue-parser'
import { getDisplayName } from '../../utils/variables'

interface MessageBubbleProps {
  message: Message
  character: Character | null
  isLast: boolean
}

import { MarkdownImage } from '../common/MarkdownImage'

const markdownComponents = { img: MarkdownImage }

// B-05：已播放过入场动画的消息 ID，避免虚拟滚动时反复播放
const animatedIds = new Set<string>()

export const MessageBubble = React.memo(function MessageBubble({ message, character, isLast }: MessageBubbleProps) {
  const shouldAnimate = !animatedIds.has(message.id)
  // 首帧渲染后立即标记为已动画
  if (shouldAnimate) {
    animatedIds.add(message.id)
  }
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState(message.content)
  const [ttsState, setTtsState] = useState<'idle' | 'speaking' | 'paused'>('idle')
  const [imgErrors, setImgErrors] = useState<Set<number>>(new Set())
  const [avatarError, setAvatarError] = useState(false)
  const [zoomImage, setZoomImage] = useState<string | null>(null)
  const [regenerating, setRegenerating] = useState(false)
  const [continuing, setContinuing] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const editMessage = useChatStore(s => s.editMessage)
  const deleteMessage = useChatStore(s => s.deleteMessage)
  const regenerateMessage = useChatStore(s => s.regenerateMessage)
  const continueMessage = useChatStore(s => s.continueMessage)
  const swipeMessage = useChatStore(s => s.swipeMessage)
  const isStreaming = useChatStore(s => s.isStreaming)
  const translatingMessages = useChatStore(s => s.translatingMessages)
  const showTranslationIds = useChatStore(s => s.showTranslationIds)
  const translateMessage = useChatStore(s => s.translateMessage)
  const updateMessageImages = useChatStore(s => s.updateMessageImages)
  const { settings, getActiveTTS } = useSettingsStore()
  const [thoughtExpanded, setThoughtExpanded] = useState(settings.autoExpandThought ?? false)
  const { getPersona } = usePersonaStore()
  const persona = getPersona(settings.activePersonaId)
  const ttsConfig = getActiveTTS()

  // 全局翻译状态
  const transState = translatingMessages[message.id]
  const showTranslation = showTranslationIds.has(message.id)
  const isTranslating = transState?.status === 'translating'

  // P-3 修复：用 useMemo 缓存 thought 解析，避免每次渲染都执行正则循环
  // B-05 修复：同时处理 <thought> 和 <thinking> 标签（部分模型使用 <thinking>）
  const { thought, originalDisplay } = useMemo(() => {
    // 先归一化：将 <thinking> 标签转为 <thought>，避免后续重复处理
    const normalized = (message.content || '').replace(/<thinking([\s>])/gi, '<thought$1').replace(/<\/thinking>/gi, '</thought>')
    const thoughtRegex = /<thought>([\s\S]*?)<\/thought>/gi
    const thoughts: string[] = []
    let thoughtExec: RegExpExecArray | null
    while ((thoughtExec = thoughtRegex.exec(normalized)) !== null) {
      thoughts.push(thoughtExec[1].trim())
    }
    const stripped = normalized.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim()
    // 如果剥离后为空但存在思考内容，则将思考内容作为显示兜底（避免显示"空消息"）
    const display = stripped || (thoughts.length > 0 ? thoughts.join('\n\n') : '')
    return {
      thought: thoughts.length > 0 ? thoughts.join('\n\n') : null,
      originalDisplay: display,
    }
  }, [message.content])
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'
  const isStreamingThis = isStreaming && isLast && !isUser

  // 决定显示的文本：翻译结果也做 thought 剥离
  const rawDisplay = showTranslation && transState?.content ? transState.content : originalDisplay
  const displayRaw = (rawDisplay || '')
    .replace(/<thinking([\s>])/gi, '<thought$1')
    .replace(/<\/thinking>/gi, '</thought>')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .trim()
  // B-05 修复：剥离后为空时回退到原始内容或思考内容，避免显示"空消息"
  const displayContent = displayRaw || originalDisplay || ''

  // B-05：纯图片消息，气泡不应撑满整行
  const hasOnlyImages = message.images?.length > 0 && !displayContent && !(thought && !isSystem)

  // 对话片段解析：将 *动作* / "对话" / Name: "对话" 拆分为结构化片段
  const dialogueSegments = useMemo(() => {
    if (isStreamingThis) return null
    const segments = parseDialogue(displayContent)
    // 如果没有识别出任何 dialogue/action 片段，返回 null（回退到普通 Markdown）
    const hasDialogueOrAction = segments.some(s => s.type === 'dialogue' || s.type === 'action')
    return hasDialogueOrAction ? segments : null
  }, [displayContent, isUser, isStreamingThis])

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus()
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px'
    }
  }, [editing])

  const handleSaveEdit = async () => {
    if (character) {
      await editMessage(message.id, editContent, character)
    }
    setEditing(false)
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content)
  }

  const handleSpeak = async () => {
    if (!message.content) return
    if (!ttsConfig) return
    if (ttsState === 'speaking') {
      await window.api.tts.pause()
      setTtsState('paused')
    } else if (ttsState === 'paused') {
      await window.api.tts.resume()
      setTtsState('speaking')
    } else {
      await window.api.tts.speak(message.content, {
        provider: ttsConfig.provider,
        voice: ttsConfig.voice,
        rate: 1,
      })
      setTtsState('speaking')
    }
  }

  const handleStopSpeak = async () => {
    await window.api.tts.stop()
    setTtsState('idle')
  }

  const handleTranslate = () => {
    if (!message.content || isTranslating) return
    // 如果已有翻译结果，切换显示
    if (transState?.status === 'done') {
      // 如果还没显示翻译，先切换为显示
      if (!showTranslation) {
        useChatStore.getState().toggleTranslation(message.id)
      } else {
        // 已显示翻译，切换回原文
        useChatStore.getState().toggleTranslation(message.id)
      }
      return
    }
    // 发起翻译
    translateMessage(message.id, message.content)
    // 翻译开始后自动显示
    useChatStore.getState().toggleTranslation(message.id)
  }

  const handleBranch = async () => {
    if (!character) return
    // 创建新会话作为分支
    const branchSession = await window.api.chat.createSession(character.id, `分支: ${message.content.slice(0, 20)}...`)
    if (!branchSession) return
    const { messages } = useChatStore.getState()
    const branchIdx = messages.findIndex((m) => m.id === message.id)
    if (branchIdx < 0) return
    const branchMsgs = messages.slice(0, branchIdx + 1)
    for (const msg of branchMsgs) {
      const branchMsg = { ...msg, id: `${msg.id}_b`, sessionId: branchSession.id, characterId: character.id }
      await window.api.chat.saveMessage(branchMsg)
    }
    // 刷新会话列表
    const sessions = await window.api.chat.listSessions(character.id)
    useChatStore.setState({ sessions, currentSessionId: branchSession.id })
    // 切换到新分支
    const branchMessages = await window.api.chat.listMessages(character.id, branchSession.id)
    useChatStore.setState({ messages: branchMessages })
  }

  // Markdown 内嵌图片：加载失败时通过父容器委托放大预览
  const handleMarkdownClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (target.tagName === 'IMG' && (target as HTMLImageElement).src) {
      setZoomImage((target as HTMLImageElement).src)
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
        <div className={cn('px-4', shouldAnimate && 'animate-fade-in-up')} style={{ marginBottom: `${settings.messageSpacing}px` }}>
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
          </div>
        </div>
        {/* 图片查看器 */}
        {zoomImage && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm cursor-zoom-out animate-fade-in" onClick={() => setZoomImage(null)}>
            <img src={zoomImage} alt="" className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl" />
            <button className="absolute top-4 right-4 p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors" onClick={(e) => { e.stopPropagation(); setZoomImage(null) }}><X className="w-6 h-6" /></button>
          </div>
        )}
        {/* 操作栏 */}
        {!isStreaming && (
          <div className="flex items-center justify-center gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button className="p-1.5 rounded text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover transition-colors" onClick={() => setEditing(true)} title="编辑"><Edit2 className="w-3.5 h-3.5" /></button>
            <button className="p-1.5 rounded text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover transition-colors" onClick={handleCopy} title="复制"><Copy className="w-3.5 h-3.5" /></button>
            <button className="p-1.5 rounded text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-bg-hover transition-colors disabled:opacity-50" disabled={regenerating} onClick={async () => { setRegenerating(true); try { const result = await window.api.imageGen.generate(message.content); if (result.success && result.images?.length) { await updateMessageImages(message.id, result.images) } } catch { /* 忽略 */ } setRegenerating(false) }} title="重新生图">
              {regenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            </button>
            <button className="p-1.5 rounded text-tavern-text-muted hover:text-tavern-danger hover:bg-tavern-bg-hover transition-colors" onClick={() => character && deleteMessage(message.id, character)} title="删除"><Trash2 className="w-3.5 h-3.5" /></button>
          </div>
        )}
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
            isUser
              ? 'bg-gradient-to-br from-tavern-user/30 to-tavern-user/10 text-tavern-user ring-2 ring-tavern-user/20'
              : isSystem
                ? 'bg-gradient-to-br from-tavern-accent/30 to-tavern-accent/10 text-tavern-accent ring-2 ring-tavern-accent/20'
                : 'bg-gradient-to-br from-tavern-assistant/30 to-tavern-assistant/10 text-tavern-assistant ring-2 ring-tavern-assistant/20'
          )}
        >
          {isUser ? (
            persona?.avatar && !avatarError ? (
              <img src={persona.avatar} alt="" className="w-full h-full rounded-full object-cover" onError={() => setAvatarError(true)} />
            ) : (
              <User className="w-5 h-5" />
            )
          ) : isSystem ? (
            <ImageIcon className="w-5 h-5" />
          ) : character?.avatar && !avatarError ? (
            <img src={character.avatar} alt="" className="w-full h-full rounded-full object-cover" onError={() => setAvatarError(true)} />
          ) : (
            <Bot className="w-5 h-5" />
          )}
        </div>

        {/* 消息内容 */}
        <div className={cn(isUser && 'flex flex-col items-end', hasOnlyImages ? 'w-fit' : 'flex-1 min-w-0')}>
          {/* 名字和时间 */}
          <div className={cn('flex items-center gap-2 mb-1 text-xs text-tavern-text-muted', isUser && 'flex-row-reverse')}>
            <span className="font-medium text-tavern-text-soft">
              {isUser ? settings.userName : isSystem ? '系统' : getDisplayName(character) || 'AI'}
            </span>
            <span>{formatTime(message.timestamp)}</span>
            {settings.showTokenCount && message.content && (
              <span className="px-1.5 py-0.5 rounded bg-tavern-bg-hover text-tavern-text-muted/70 text-[10px]" title={message.tokenUsage ? `输入: ${message.tokenUsage.promptTokens} · 输出: ${message.tokenUsage.completionTokens} · 费用: $${message.tokenUsage.cost.toFixed(4)}` : ''}>
                {message.tokenUsage ? `${message.tokenUsage.totalTokens} tok` : `${estimateTokens(message.content)} tok`}
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
              settings.bubbleStyle === 'round' && 'rounded-2xl',
              settings.bubbleStyle === 'standard' && 'rounded-lg',
              settings.bubbleStyle === 'sharp' && 'rounded-sm',
              isUser
                ? 'bg-gradient-to-bl from-amber-100 to-orange-50 border border-amber-200/60 rounded-br-sm shadow-md dark:from-amber-900/70 dark:to-orange-900/70 dark:border-amber-700/60 text-amber-950 dark:text-amber-50 bubble-user'
                : 'bg-tavern-bg-card border border-tavern-border rounded-bl-sm shadow-sm text-slate-900 dark:text-slate-100'
            )}
          >
            {message.images?.length > 0 && (
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
              {dialogueSegments ? (
                /* 分段渲染：对话/动作/旁白 */
                dialogueSegments.map((seg, i) => {
                  if (seg.type === 'dialogue') {
                    return (
                      <div key={i} className="dialogue-block">
                        {seg.speaker && <span className="dialogue-speaker">{seg.speaker}</span>}
                        <span className="dialogue-text">{seg.content}</span>
                      </div>
                    )
                  }
                  if (seg.type === 'action') {
                    return (
                      <div key={i} className="action-block">
                        {seg.content}
                      </div>
                    )
                  }
                  // plain 片段用 ReactMarkdown 渲染，支持 HTML 标签和 markdown 图片/链接
                  return (
                    <div key={i} className="narration-block">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        rehypePlugins={[
                          ...(settings.htmlRendering ? [rehypeRaw] : []),
                          rehypeHighlight,
                        ]}
                        components={markdownComponents}
                      >
                        {seg.content}
                      </ReactMarkdown>
                    </div>
                  )
                })
              ) : (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[
                    ...(settings.htmlRendering ? [rehypeRaw] : []),
                    rehypeHighlight,
                  ]}
                  components={markdownComponents}
                >
                  {displayContent || (isStreamingThis ? '' : (thought ? '💭 内容已在"内心想法"中展开' : '（空消息）'))}
                </ReactMarkdown>
              )}
            </div>
            )}
            {/* 翻译状态指示 */}
            {isTranslating && !transState?.content && (
              <div className="mt-2 flex items-center gap-1.5 text-xs text-tavern-accent">
                <Loader2 className="w-3 h-3 animate-spin" />
                翻译中...
              </div>
            )}
            {showTranslation && transState?.status === 'error' && (
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
          {!isStreaming && (
            <div className={cn('flex items-center gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity', isUser && 'flex-row-reverse')}>
              <button
                className="p-1.5 rounded text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover transition-colors"
                onClick={() => setEditing(true)}
                title="编辑"
              >
                <Edit2 className="w-3.5 h-3.5" />
              </button>
              <button
                className="p-1.5 rounded text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover transition-colors"
                onClick={handleCopy}
                title="复制"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
              {!isUser && !isSystem && character && (
                <button
                  className="p-1.5 rounded text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover transition-colors"
                  onClick={async () => {
                    const chatStore = useChatStore.getState()
                    let preset: any = null
                    if (chatStore.activePresetId) {
                      const presets = await window.api.preset.list()
                      preset = presets.find((p: any) => p.id === chatStore.activePresetId) ?? null
                    }
                    const activeLorebooks: any[] = []
                    if (chatStore.activeLorebookIds.length > 0) {
                      const lorebooks = await window.api.lorebook.list()
                      for (const id of chatStore.activeLorebookIds) {
                        const lb = lorebooks.find((lb: any) => lb.id === id)
                        if (lb && lb.enabled) activeLorebooks.push(lb)
                      }
                    }
                    await regenerateMessage(message.id, character, preset, activeLorebooks)
                  }}
                  title="重新生成"
                  disabled={isStreaming}
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              )}
              {!isUser && !isSystem && (
                <>
                  <button
                    className={cn(
                      'p-1.5 rounded transition-colors',
                      ttsState !== 'idle'
                        ? 'text-tavern-accent bg-tavern-accent-soft'
                        : 'text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover'
                    )}
                    onClick={handleSpeak}
                    title={ttsState === 'speaking' ? '暂停' : ttsState === 'paused' ? '继续' : '朗读'}
                  >
                    {ttsState === 'speaking' ? <Pause className="w-3.5 h-3.5" /> : ttsState === 'paused' ? <Play className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                  </button>
                  {ttsState !== 'idle' && (
                    <button
                      className="p-1.5 rounded text-tavern-text-muted hover:text-tavern-danger hover:bg-tavern-bg-hover transition-colors"
                      onClick={handleStopSpeak}
                      title="停止朗读"
                    >
                      <VolumeX className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    className={cn(
                      'p-1.5 rounded transition-colors',
                      showTranslation ? 'text-tavern-accent bg-tavern-accent-soft' : (isTranslating ? 'text-tavern-accent animate-pulse' : 'text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover')
                    )}
                    onClick={handleTranslate}
                    title={showTranslation ? '切回原文' : isTranslating ? '翻译中...' : '翻译'}
                    disabled={isTranslating}
                  >
                    <Languages className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
              <button
                className="p-1.5 rounded text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover transition-colors"
                onClick={handleBranch}
                title="从此处分支"
              >
                <GitBranch className="w-3.5 h-3.5" />
              </button>
              {/* 重新生图（仅 system 生图消息） */}
              {isSystem && message.content && (
                <button
                  className="p-1.5 rounded text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-bg-hover transition-colors disabled:opacity-50"
                  disabled={regenerating}
                  onClick={async () => {
                    setRegenerating(true)
                    try {
                      const result = await window.api.imageGen.generate(message.content)
                      if (result.success && result.images?.length) {
                        await updateMessageImages(message.id, result.images)
                      }
                    } catch { /* 忽略 */ }
                    setRegenerating(false)
                  }}
                  title="重新生图"
                >
                  {regenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                </button>
              )}
              <button
                className="p-1.5 rounded text-tavern-text-muted hover:text-tavern-danger hover:bg-tavern-bg-hover transition-colors"
                onClick={() => character && deleteMessage(message.id, character)}
                title="删除"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
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
                    let preset: any = null
                    if (chatStore.activePresetId) {
                      const presets = await window.api.preset.list()
                      preset = presets.find((p: any) => p.id === chatStore.activePresetId) ?? null
                    }
                    const activeLorebooks: any[] = []
                    if (chatStore.activeLorebookIds.length > 0) {
                      const lorebooks = await window.api.lorebook.list()
                      for (const id of chatStore.activeLorebookIds) {
                        const lb = lorebooks.find((lb: any) => lb.id === id)
                        if (lb && lb.enabled) activeLorebooks.push(lb)
                      }
                    }
                    await continueMessage(message.id, character, preset, activeLorebooks)
                  } catch { /* 忽略 */ }
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
