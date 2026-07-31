import React, { useState, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import { charAssetUrl } from '../../utils/asset'
import { useCharacterStore } from '../../store/useCharacterStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { usePersonaStore } from '../../store/usePersonaStore'
import { cn } from '../../lib/utils'
import { getDisplayName } from '../../utils/variables'
import { remarkRoleplay } from '../../utils/remark-roleplay'
import { extractThought } from '../../utils/messagePostProcess'
import { X, Edit2, RefreshCw, Languages, Check, Reply, Loader2 } from 'lucide-react'
import type { GroupMessage } from '../../../shared/types'

interface GroupChatMessageProps {
  message: GroupMessage
  memberIndex?: number
  isStreamingMessage?: boolean
  repliedMessage?: GroupMessage
  bubbleOpacity?: number
  onDelete?: () => void
  onEdit?: (content: string) => void
  onRegenerate?: () => void
  onTranslate?: () => void
  onReply?: () => void
}

const ROLE_COLORS = [
  'border-l-amber-500 bg-amber-500/5',
  'border-l-emerald-500 bg-emerald-500/5',
  'border-l-blue-500 bg-blue-500/5',
  'border-l-purple-500 bg-purple-500/5',
  'border-l-rose-500 bg-rose-500/5',
  'border-l-cyan-500 bg-cyan-500/5',
  'border-l-orange-500 bg-orange-500/5',
  'border-l-pink-500 bg-pink-500/5',
]

import { MarkdownImage } from '../common/MarkdownImage'

const markdownComponents = { img: MarkdownImage }

export const GroupChatMessage = React.memo(function GroupChatMessage({ message, memberIndex, isStreamingMessage, repliedMessage, bubbleOpacity, onDelete, onEdit, onRegenerate, onTranslate, onReply }: GroupChatMessageProps) {
  const { characters } = useCharacterStore()
  const { settings } = useSettingsStore()
  const { getPersona } = usePersonaStore()
  const persona = getPersona(settings.activePersonaId)
  const [showThought, setShowThought] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editDraft, setEditDraft] = useState('')
  const [imgErrors, setImgErrors] = useState<Set<number>>(new Set())

  const isUser = message.characterId === '__user__'
  const isFree = message.characterId === '__free__'
  const isStreaming = isStreamingMessage ?? false

  const character = characters.find(c => c.id === message.characterId)
  const colorIdx = memberIndex ?? 0
  const borderColor = ROLE_COLORS[colorIdx % ROLE_COLORS.length]

  // 提取 thought 块并剥离（统一处理 <thought> 和 <thinking> 标签）
  const { thought: thoughtContent, content: mainContent, isFallback: isThoughtFallback } = extractThought(message.content || '')

  // 翻译显示状态从 store 同步，而非本地 state
  const showTranslation = message._showTranslation ?? false
  const displayContent = showTranslation && message.translation ? message.translation : mainContent

  // @提及高亮处理
  const mentionHighlightedContent = useMemo(() => {
    if (isStreaming || !displayContent) return displayContent
    let result = displayContent
    // 从消息中记录的 mentionedCharacterIds 获取角色名
    if (message.mentionedCharacterIds && message.mentionedCharacterIds.length > 0) {
      for (const charId of message.mentionedCharacterIds) {
        const char = characters.find(c => c.id === charId)
        if (char) {
          const name = char.name
          // 转义正则特殊字符
          const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const regex = new RegExp(`@${escaped}`, 'g')
          result = result.replace(regex, `<span class="mention-highlight">@${name}</span>`)
        }
      }
    }
    return result
  }, [displayContent, isStreaming, message.mentionedCharacterIds, characters])

  if (isFree) {
    return null
  }

  const startEdit = () => {
    setEditDraft(message.content)
    setIsEditing(true)
  }

  const saveEdit = () => {
    if (onEdit && editDraft.trim()) {
      onEdit(editDraft.trim())
    }
    setIsEditing(false)
  }

  const cancelEdit = () => {
    setIsEditing(false)
    setEditDraft('')
  }

  const hasActions = onDelete || onEdit || onRegenerate || onTranslate || onReply

  return (
    <div className="px-4 group" style={{ marginBottom: `${settings.messageSpacing}px` }}>
      <div className={cn('mx-auto flex gap-4', isUser && 'flex-row-reverse')} style={{ maxWidth: `${settings.messageWidth ?? 768}px`, width: '100%' }}>
        {/* 头像 */}
        <div className={cn(
          'w-10 h-10 rounded-full flex items-center justify-center shrink-0',
          isUser
            ? 'bg-gradient-to-br from-tavern-user/30 to-tavern-user/10 text-tavern-user ring-2 ring-tavern-user/20'
            : 'bg-gradient-to-br from-tavern-assistant/30 to-tavern-assistant/10 text-tavern-assistant ring-2 ring-tavern-assistant/20'
        )}>
          {isUser ? (
            persona?.avatar ? (
              <img src={persona.avatar} className="w-full h-full rounded-full object-cover" alt="" />
            ) : (
              <span className="text-xs font-bold">{settings.userName?.[0] || '你'}</span>
            )
          ) : character ? (
            <img src={charAssetUrl(character.id, 'avatar', character.updatedAt)} className="w-full h-full rounded-full object-cover" alt="" />
          ) : (
            <span className={cn('text-xs font-bold', isStreaming && 'animate-pulse')}>
              {character?.translatedContent?.name?.[0] ?? character?.name?.[0] ?? '?'}
            </span>
          )}
        </div>

        {/* 消息内容 */}
        <div className={cn('flex-1 min-w-0', isUser && 'flex flex-col items-end')}>
          {/* 名字和时间 */}
          <div className={cn('flex items-center gap-2 mb-1 text-xs text-tavern-text-muted', isUser && 'flex-row-reverse')}>
            <span className="font-medium text-tavern-text-soft">
              {isUser ? (settings.userName || '你') : getDisplayName(character) || '未知'}
            </span>
            {isStreaming && <span className="text-tavern-accent">生成中...</span>}
            <span>
              {new Date(message.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
            </span>
            {isUser && message.status === 'sending' && (
              <Loader2 className="w-3 h-3 animate-spin text-tavern-text-muted" />
            )}
            {isUser && (!message.status || message.status === 'sent') && (
              <Check className="w-3 h-3 text-tavern-text-muted/60" />
            )}
          </div>

          {/* 气泡本体 */}
          <div className={cn(
            'msg-bubble max-w-full px-5 py-3.5 text-sm leading-relaxed break-words relative group/bubble',
            settings.bubbleStyle === 'round' && 'rounded-2xl',
            settings.bubbleStyle === 'standard' && 'rounded-lg',
            settings.bubbleStyle === 'sharp' && 'rounded-sm',
            isUser
              ? 'bg-gradient-to-bl from-amber-100 to-orange-50 border border-amber-200/60 rounded-br-sm shadow-md dark:from-amber-900/70 dark:to-orange-900/70 dark:border-amber-700/60 text-amber-950 dark:text-amber-50'
              : cn('border-l-[3px] rounded-bl-sm shadow-sm',
                   borderColor, 'text-tavern-text',
                   isStreaming && 'border-dashed')
          )}
          style={!isUser ? { backgroundColor: `color-mix(in srgb, var(--tavern-bg-card) ${(bubbleOpacity ?? 1) * 100}%, transparent)` } : undefined}
          >
          {/* 引用回复块 */}
          {repliedMessage && (
            <div className="reply-quote mb-1.5">
              <span className="reply-speaker">
                {repliedMessage.characterId === '__user__'
                  ? '用户'
                  : (characters.find(c => c.id === repliedMessage.characterId)?.name ?? '未知')}
              </span>
              <span className="ml-1">{repliedMessage.content.slice(0, 50)}{repliedMessage.content.length > 50 ? '...' : ''}</span>
            </div>
          )}
          {isEditing ? (
            <div className="space-y-2">
              <textarea
                value={editDraft}
                onChange={e => setEditDraft(e.target.value)}
                className="w-full min-h-[60px] bg-tavern-bg border border-tavern-border rounded-lg px-2.5 py-1.5 text-xs text-tavern-text outline-none focus:border-tavern-accent resize-none"
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    saveEdit()
                  }
                  if (e.key === 'Escape') cancelEdit()
                }}
              />
              <div className="flex items-center gap-1 justify-end">
                <button onClick={cancelEdit} className="px-2 py-0.5 text-[10px] text-tavern-text-muted hover:text-tavern-text rounded">
                  取消
                </button>
                <button onClick={saveEdit} className="px-2 py-0.5 text-[10px] bg-tavern-accent text-white rounded hover:bg-tavern-accent/80">
                  <Check className="w-3 h-3 inline mr-0.5" />保存
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Thought 折叠区（回退显示时不重复展示） */}
              {thoughtContent && !isThoughtFallback && (
                <div className="mb-1.5">
                  <button
                    onClick={() => setShowThought(!showThought)}
                    className="text-[10px] text-tavern-text-muted hover:text-tavern-accent transition-colors italic"
                  >
                    {showThought ? '收起心理描写 ▲' : '展开心理描写 ▼'}
                  </button>
                  {showThought && (
                    <div className="mt-1 px-2.5 py-1.5 rounded-lg bg-tavern-bg-soft/60 border border-tavern-border-soft/50 text-xs text-tavern-text-muted italic leading-relaxed">
                      {thoughtContent}
                    </div>
                  )}
                </div>
              )}

              {/* 正文 */}
              <div className="markdown-body">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkRoleplay]}
                  remarkRehypeOptions={{ allowDangerousHtml: true }}
                  rehypePlugins={[rehypeRaw, rehypeHighlight]}
                  components={markdownComponents}
                >
                  {mentionHighlightedContent || ''}
                </ReactMarkdown>
              </div>

              {/* 翻译切换 */}
              {message.translation && message.translation !== '...' && (
                <button
                  onClick={() => onTranslate?.()}
                  className="mt-1 text-[10px] text-tavern-accent hover:underline"
                >
                  {showTranslation ? '显示原文' : '显示译文'}
                </button>
              )}

              {/* 翻译加载中 */}
              {message.translation === '...' && (
                <div className="mt-1 text-[10px] text-tavern-text-muted italic">翻译中...</div>
              )}

              {/* 图片 */}
              {message.images && message.images.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {message.images.map((img, i) => (
                    imgErrors.has(i) ? (
                      <button
                        key={i}
                        onClick={() => setImgErrors(prev => { const next = new Set(prev); next.delete(i); return next })}
                        className="w-[100px] h-[100px] rounded-lg bg-tavern-bg-hover flex flex-col items-center justify-center text-tavern-text-muted text-xs gap-1 cursor-pointer hover:bg-tavern-bg-hover/80 transition-colors"
                        title="点击重新加载"
                      >
                        <RefreshCw className="w-3 h-3" />
                        <span>加载失败</span>
                      </button>
                    ) : (
                      <img key={i} src={img} className="max-w-[200px] max-h-[200px] rounded-lg object-cover" alt="" onError={() => setImgErrors(prev => new Set(prev).add(i))} />
                    )
                  ))}
                </div>
              )}
            </>
          )}

          {/* 操作按钮组 (hover 可见) */}
          {hasActions && !isEditing && !isStreaming && (
            <div className="absolute top-1 right-1 flex items-center gap-0.5 opacity-0 group-hover/bubble:opacity-100 transition-opacity">
              {onReply && (
                <button
                  onClick={onReply}
                  className="p-0.5 rounded text-tavern-text-muted hover:text-tavern-accent"
                  title="引用回复"
                >
                  <Reply className="w-3 h-3" />
                </button>
              )}
              {onTranslate && (
                <button
                  onClick={onTranslate}
                  className="p-0.5 rounded text-tavern-text-muted hover:text-tavern-accent"
                  title="翻译"
                >
                  <Languages className="w-3 h-3" />
                </button>
              )}
              {onEdit && (
                <button
                  onClick={startEdit}
                  className="p-0.5 rounded text-tavern-text-muted hover:text-tavern-text"
                  title="编辑"
                >
                  <Edit2 className="w-3 h-3" />
                </button>
              )}
              {onRegenerate && (
                <button
                  onClick={onRegenerate}
                  className="p-0.5 rounded text-tavern-text-muted hover:text-tavern-accent"
                  title="重新生成"
                >
                  <RefreshCw className="w-3 h-3" />
                </button>
              )}
              {onDelete && (
                <button
                  onClick={onDelete}
                  className="p-0.5 rounded text-tavern-text-muted hover:text-tavern-danger"
                  title="删除"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          )}
        </div>
        </div>
      </div>
    </div>
  )
})
