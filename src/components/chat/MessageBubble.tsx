import { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import { Edit2, Check, X, RotateCcw, Trash2, Copy, Volume2, VolumeX, Play, Pause, User, Bot, Languages, GitBranch } from 'lucide-react'
import type { Message, Character } from '../../../shared/types'
import { useChatStore } from '../../store/useChatStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { cn } from '../../lib/utils'
import { formatTime } from '../../utils/format'
import { estimateTokens } from '../../utils/tokenCounter'

interface MessageBubbleProps {
  message: Message
  character: Character | null
  isLast: boolean
}

export function MessageBubble({ message, character, isLast }: MessageBubbleProps) {
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState(message.content)
  const [ttsState, setTtsState] = useState<'idle' | 'speaking' | 'paused'>('idle')
  const [translation, setTranslation] = useState<string | null>(message.translation ?? null)
  const [translating, setTranslating] = useState(false)
  const [thoughtExpanded, setThoughtExpanded] = useState(false)
  const [imgErrors, setImgErrors] = useState<Set<number>>(new Set())
  const { editMessage, deleteMessage, regenerateMessage, isStreaming, currentRequestId } = useChatStore()
  const { settings, getActiveTTS } = useSettingsStore()
  const ttsConfig = getActiveTTS()

  // 解析心理描写 <thought>...</thought>
  const thoughtMatch = message.content?.match(/<thought>([\s\S]*?)<\/thought>/i)
  const thought = thoughtMatch?.[1]?.trim() ?? null
  const displayContent = thought ? message.content.replace(/<thought>[\s\S]*?<\/thought>/i, '').trim() : message.content
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isUser = message.role === 'user'
  const isStreamingThis = isStreaming && isLast && !isUser

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

  const handleTranslate = async () => {
    if (!message.content || translating) return
    if (translation) {
      setTranslation(null)
      return
    }
    setTranslating(true)
    setTranslation('')

    const requestId = `translate-${message.id}-${Date.now()}`
    let result = ''

    const unbindChunk = window.api.ai.onChunk((data) => {
      if (data.requestId !== requestId) return
      result += data.text
      setTranslation(result)
    })
    const unbindDone = window.api.ai.onDone((doneId) => {
      if (doneId !== requestId) return
      unbindChunk(); unbindDone(); unbindError()
      setTranslating(false)
      // 持久化翻译结果到消息
      if (character && result) {
        const updatedMsg = { ...message, translation: result }
        window.api.chat.saveMessage(updatedMsg)
        useChatStore.setState((s) => ({
          messages: s.messages.map((m) => (m.id === message.id ? updatedMsg : m)),
        }))
      }
    })
    const unbindError = window.api.ai.onError((data) => {
      if (data.requestId !== requestId) return
      unbindChunk(); unbindDone(); unbindError()
      setTranslating(false)
      setTranslation('翻译失败: ' + data.error)
    })

    const profile = useSettingsStore.getState().getActiveProfile()
    if (!profile) { setTranslating(false); return }
    const settings = useSettingsStore.getState().settings
    await window.api.ai.chat({
      requestId,
      messages: [
        { role: 'system', content: '你是一个翻译助手。请将以下文本翻译成中文。只输出翻译结果，不要添加任何解释或额外内容。' },
        { role: 'user', content: message.content },
      ],
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: settings.activeModel || profile.model,
      temperature: 0.3,
      topP: 0.9,
      maxTokens: 2048,
      frequencyPenalty: 0,
      presencePenalty: 0,
      stream: true,
    })
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

  if (editing) {
    return (
      <div className="px-4 py-2 animate-fade-in">
        <div className="max-w-3xl mx-auto">
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

  return (
    <div className="px-4 group animate-fade-in-up msg-row">
      <div className={cn('max-w-3xl mx-auto flex gap-3', isUser && 'flex-row-reverse')}>
        {/* 头像 */}
        <div
          className={cn(
            'w-9 h-9 rounded-full flex items-center justify-center shrink-0',
            isUser
              ? 'bg-tavern-user/20 text-tavern-user'
              : 'bg-tavern-assistant/20 text-tavern-assistant'
          )}
        >
          {isUser ? (
            <User className="w-5 h-5" />
          ) : character?.avatar ? (
            <img src={character.avatar} alt="" className="w-full h-full rounded-full object-cover" />
          ) : (
            <Bot className="w-5 h-5" />
          )}
        </div>

        {/* 消息内容 */}
        <div className={cn('flex-1 min-w-0', isUser && 'flex flex-col items-end')}>
          {/* 名字和时间 */}
          <div className={cn('flex items-center gap-2 mb-1 text-xs text-tavern-text-muted', isUser && 'flex-row-reverse')}>
            <span className="font-medium text-tavern-text-soft">
              {isUser ? '你' : character?.name ?? 'AI'}
            </span>
            <span>{formatTime(message.timestamp)}</span>
            {settings.showTokenCount && message.content && (
              <span className="px-1.5 py-0.5 rounded bg-tavern-bg-hover text-tavern-text-muted/70 text-[10px]">
                {estimateTokens(message.content)} tok
              </span>
            )}
          </div>

          {/* 气泡 */}
          <div
            className={cn(
              'msg-bubble px-4 py-3 max-w-full shadow-sm',
              settings.bubbleStyle === 'round' && 'rounded-2xl',
              settings.bubbleStyle === 'standard' && 'rounded-lg',
              settings.bubbleStyle === 'sharp' && 'rounded-sm',
              isUser
                ? 'bg-tavern-user/20 border border-tavern-user/30 rounded-tr-sm'
                : 'bg-tavern-bg-soft border border-tavern-border rounded-tl-sm'
            )}
          >
            {message.images?.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {message.images.map((img, i) => (
                  imgErrors.has(i) ? (
                    <div key={i} className="w-24 h-24 rounded-lg bg-tavern-bg-hover flex items-center justify-center text-tavern-text-muted text-xs">
                      图片加载失败
                    </div>
                  ) : (
                    <img
                      key={i}
                      src={img}
                      alt=""
                      className="max-w-48 max-h-48 rounded-lg object-cover"
                      onError={() => setImgErrors((prev) => new Set(prev).add(i))}
                    />
                  )
                ))}
              </div>
            )}
            {/* 心理描写折叠区块 */}
            {thought && (
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
            <div className={cn('markdown-body', isStreamingThis && 'typing-cursor')}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[
                  ...(settings.htmlRendering ? [rehypeRaw] : []),
                  rehypeHighlight,
                ]}
              >
                {displayContent || (isStreamingThis ? '' : '（空消息）')}
              </ReactMarkdown>
            </div>
            {/* 翻译结果 */}
            {translation !== null && (
              <div className="mt-2 pt-2 border-t border-tavern-border-soft">
                <div className="text-xs text-tavern-text-muted mb-1 flex items-center gap-1">
                  <Languages className="w-3 h-3" />
                  {translating ? '翻译中...' : '中文翻译'}
                </div>
                <div className="text-sm text-tavern-text-soft whitespace-pre-wrap select-text" style={{ userSelect: 'text', WebkitUserSelect: 'text' }}>
                  {translation || '...'}
                </div>
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
              {!isUser && character && (
                <button
                  className="p-1.5 rounded text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover transition-colors"
                  onClick={() => regenerateMessage(message.id, character, null, null)}
                  title="重新生成"
                  disabled={isStreaming}
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              )}
              {!isUser && (
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
                      translation ? 'text-tavern-accent bg-tavern-accent-soft' : 'text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover'
                    )}
                    onClick={handleTranslate}
                    title="翻译"
                    disabled={translating}
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
              <button
                className="p-1.5 rounded text-tavern-text-muted hover:text-tavern-danger hover:bg-tavern-bg-hover transition-colors"
                onClick={() => character && deleteMessage(message.id, character)}
                title="删除"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
