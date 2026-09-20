import React, { useState, useMemo } from 'react'
import { charAssetUrl } from '../../utils/asset'
import { useCharacterStore } from '../../store/useCharacterStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { usePersonaStore } from '../../store/usePersonaStore'
import { cn } from '../../lib/utils'
import { getDisplayName } from '../../utils/variables'
import { extractThought } from '../../utils/messagePostProcess'
import { X, Edit2, RefreshCw, Languages, Check, Reply, Loader2, Globe2 } from 'lucide-react'
import type { GroupMessage } from '../../../shared/types'
import { resolveMessageSpeakerKind } from '../../../shared/messageIdentity'
import { DialogueDirectionCard } from './DialogueDirectionCard'
import { RoleplayContentRenderer } from './RoleplayContentRenderer'

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
  isLast?: boolean
  /** 当前消息是否是最新可操作的方向消息；未传时兼容旧调用，沿用 isLast。 */
  canRegenerateDirections?: boolean
  dialogueDirectionsEnabled?: boolean
  onRegenerateDirections?: () => void | Promise<void>
  directionsError?: string | null
}

export const GroupChatMessage = React.memo(function GroupChatMessage({
  message,
  isStreamingMessage,
  repliedMessage,
  bubbleOpacity,
  onDelete,
  onEdit,
  onRegenerate,
  onTranslate,
  onReply,
  isLast,
  canRegenerateDirections,
  dialogueDirectionsEnabled,
  onRegenerateDirections,
  directionsError,
}: GroupChatMessageProps) {
  // P-6 修复：字段级选择器订阅
  const characters = useCharacterStore((s) => s.characters)
  const settings = useSettingsStore((s) => s.settings)
  const getPersona = usePersonaStore((s) => s.getPersona)
  const persona = getPersona(settings.activePersonaId)
  const [showThought, setShowThought] = useState(settings.autoExpandThought ?? false)
  const [isEditing, setIsEditing] = useState(false)
  const [editDraft, setEditDraft] = useState('')
  const [imgErrors, setImgErrors] = useState<Set<number>>(new Set())

  const isUser = message.characterId === '__user__'
  const isFree = message.characterId === '__free__'
  const speakerKind = resolveMessageSpeakerKind(message)
  const isNarrator = speakerKind === 'narrator'
  const isPersona = speakerKind === 'persona'
  const isStreaming = isStreamingMessage ?? false

  const character = characters.find(c => c.id === message.characterId)

  // 提取角色 <thought> 内心块；供应商 RaisedButton / <thinking> 推理会在工具层先行丢弃。
  const { thought: thoughtContent, content: mainContent, isFallback: isThoughtFallback } = extractThought(message.content || '')

  // 翻译显示状态从 store 同步，而非本地 state
  const showTranslation = message._showTranslation ?? false
  // 只有 thought、没有正文时也保留独立折叠区；避免回退文本绕过折叠状态永久显示。
  const displayContent = showTranslation && message.translation
    ? message.translation
    : isThoughtFallback
      ? ''
      : mainContent

  // @提及高亮：只提取需要高亮的角色名（与单聊共用 RoleplayContentRenderer）
  const mentionNames = useMemo(() => {
    if (!message.mentionedCharacterIds || message.mentionedCharacterIds.length === 0) return []
    return message.mentionedCharacterIds
      .map(charId => characters.find(c => c.id === charId)?.name)
      .filter((n): n is string => !!n)
  }, [message.mentionedCharacterIds, characters])

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
          isNarrator
            ? 'bg-gradient-to-br from-slate-500/20 to-indigo-500/15 text-indigo-500 ring-2 ring-indigo-500/20 dark:text-indigo-300'
            : isPersona
              ? 'bg-gradient-to-br from-tavern-user/30 to-tavern-user/10 text-tavern-user ring-2 ring-tavern-user/20'
              : 'bg-gradient-to-br from-tavern-assistant/30 to-tavern-assistant/10 text-tavern-assistant ring-2 ring-tavern-assistant/20'
        )}>
          {isNarrator ? (
            <Globe2 className="h-5 w-5" aria-label="旁白" />
          ) : isPersona ? (
            persona?.avatar ? (
              <img src={persona.avatar} className="w-full h-full rounded-full object-cover" alt="" />
            ) : (
              <span className="text-xs font-bold">{settings.userName?.[0] || '你'}</span>
            )
          ) : character ? (
            <img src={charAssetUrl(character.id, 'avatar', character.updatedAt)} className="w-full h-full rounded-full object-cover" alt="" />
          ) : (
            <span className={cn('text-xs font-bold', isStreaming && 'animate-pulse')}>
              {'?'}
            </span>
          )}
        </div>

        {/* 消息内容 */}
        <div className={cn('flex-1 min-w-0', isUser && 'flex flex-col items-end')}>
          {/* 名字和时间 */}
          <div className={cn('flex items-center gap-2 mb-1 text-xs text-tavern-text-muted', isUser && 'flex-row-reverse')}>
            <span className="font-medium text-tavern-text-soft">
              {isNarrator ? '旁白' : isPersona ? (settings.userName || '你') : getDisplayName(character) || '未知'}
            </span>
            {isNarrator && character && (
              <span className="rounded-full border border-indigo-400/20 bg-indigo-500/10 px-1.5 py-0.5 text-[10px] text-indigo-600 dark:text-indigo-300">
                焦点 · {getDisplayName(character)}
              </span>
            )}
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
            isUser && 'w-fit',
            settings.bubbleStyle === 'round' && 'rounded-2xl',
            settings.bubbleStyle === 'standard' && 'rounded-lg',
            settings.bubbleStyle === 'sharp' && 'rounded-sm',
            isNarrator
              ? cn('border border-indigo-200/70 bg-gradient-to-bl from-slate-50 to-indigo-50/70 rounded-br-sm shadow-sm text-slate-900 dark:border-indigo-700/40 dark:from-slate-900/95 dark:to-indigo-950/55 dark:text-slate-100 bubble-narrator', isStreaming && 'border-dashed')
              : isPersona
                ? 'bg-gradient-to-bl from-amber-100 to-orange-50 border border-amber-200/60 rounded-br-sm shadow-md dark:from-amber-900/70 dark:to-orange-900/70 dark:border-amber-700/60 text-amber-950 dark:text-amber-50 bubble-user'
                : cn('bg-tavern-bg-card border border-tavern-border rounded-bl-sm shadow-sm text-slate-900 dark:text-slate-100',
                   isStreaming && 'border-dashed')
          )}
          style={!isUser && !isNarrator ? { backgroundColor: `color-mix(in srgb, var(--tavern-bg-card) ${(bubbleOpacity ?? 1) * 100}%, transparent)` } : undefined}
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
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
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
              {/* Thought 折叠区：即使模型尚未生成正文，也应允许用户收起。 */}
              {thoughtContent && (
                <div className="mb-2 rounded-lg bg-tavern-bg-soft border border-tavern-border-soft px-3 py-2">
                  <button
                    onClick={() => setShowThought(!showThought)}
                    aria-expanded={showThought}
                    aria-label={showThought ? '收起思考内容' : '展开思考内容'}
                    className="text-xs text-tavern-text-muted flex items-center gap-1 hover:text-tavern-text-soft"
                  >
                    <span>💭 内心想法</span>
                    <span>{showThought ? '▼' : '▶'}</span>
                  </button>
                  {showThought && (
                    <div className="mt-1.5 text-sm italic text-tavern-text-muted select-text whitespace-pre-wrap">
                      {thoughtContent}
                    </div>
                  )}
                </div>
              )}

              {/* 正文：单聊/群聊共用 RoleplayContentRenderer */}
              <RoleplayContentRenderer
                content={displayContent || ''}
                contentRenderMode={message.contentRenderMode}
                isStreaming={isStreaming}
                mentionNames={mentionNames}
              />

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

          {/* 下一步方向：气泡外的独立交互，仅等待用户输入时展示 */}
          {dialogueDirectionsEnabled
            && !isStreaming
            && !isUser
            && !isFree
            && !!mainContent
            && (message.dialogueDirections?.length ?? 0) > 0
            && message.dialogueDirections && (
              <DialogueDirectionCard
                directions={message.dialogueDirections}
                canRegenerate={(canRegenerateDirections ?? !!isLast) && !!onRegenerateDirections}
                onRegenerate={() => onRegenerateDirections?.()}
                error={directionsError}
                scope="group"
              />
            )}
        </div>
        </div>

        {/* 对侧占位：预留头像宽度，使左右气泡对齐在同一中间列 */}
        <div className="w-10 shrink-0" aria-hidden="true" />
      </div>
    </div>
  )
})
