import React, { useState, useMemo, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { charAssetUrl } from '../../utils/asset'
import { useCharacterStore } from '../../store/useCharacterStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { usePersonaStore } from '../../store/usePersonaStore'
import { cn } from '../../lib/utils'
import { getDisplayName } from '../../utils/variables'
import { remarkRoleplay, remarkMentionHighlight } from '../../utils/remark-roleplay'
import { extractThought } from '../../utils/messagePostProcess'
import { buildRoleplayBlocks, stripOuterQuotes, splitQuoteSegments } from '../../utils/roleplayBlocks'
import { splitMentionSegments } from '../../utils/mentionHighlight'
import { X, Edit2, RefreshCw, Languages, Check, Reply, Loader2, Globe2 } from 'lucide-react'
import type { GroupMessage } from '../../../shared/types'
import { resolveMessageSpeakerKind } from '../../../shared/messageIdentity'
import { DialogueDirectionCard } from './DialogueDirectionCard'

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
  /** 是否为最新一条消息；仅最新一条允许换一批。 */
  isLast?: boolean
  /** 会话已开启“下一步方向”；关闭时不渲染卡片。 */
  dialogueDirectionsEnabled?: boolean
  /** 触发“换一批”。 */
  onRegenerateDirections?: () => void | Promise<void>
  /** 方向生成失败的可见反馈。 */
  directionsError?: string | null
}

import { MarkdownImage } from '../common/MarkdownImage'
import { MarkdownLink } from '../common/MarkdownLink'
import { remarkAudio } from '../../utils/remark-audio'

/** 消息内嵌 <audio> 播放器（对齐单聊：白名单 http/https） */
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

  // 提取角色 <thought> 内心块；供应商 <think>/<thinking> 推理会在工具层先行丢弃。
  const { thought: thoughtContent, content: mainContent, isFallback: isThoughtFallback } = extractThought(message.content || '')

  // 翻译显示状态从 store 同步，而非本地 state
  const showTranslation = message._showTranslation ?? false
  // 只有 thought、没有正文时也保留独立折叠区；避免回退文本绕过折叠状态永久显示。
  const displayContent = showTranslation && message.translation
    ? message.translation
    : isThoughtFallback
      ? ''
      : mainContent

  // 阶段5：语义分块（仅 blocks 模式的新消息；旧消息走 Markdown 兼容渲染）
  const semanticBlocks = message.contentRenderMode === 'blocks'
    ? buildRoleplayBlocks(displayContent)
    : null

  // @提及高亮处理
  // BUG-09 修复：不再注入原始 HTML（原实现依赖 rehypeRaw，存在 XSS 风险），
  // 改为 AST 层插件高亮，这里只提取需要高亮的角色名
  const mentionNames = useMemo(() => {
    if (!message.mentionedCharacterIds || message.mentionedCharacterIds.length === 0) return []
    return message.mentionedCharacterIds
      .map(charId => characters.find(c => c.id === charId)?.name)
      .filter((n): n is string => !!n)
  }, [message.mentionedCharacterIds, characters])
  // 插件以 [工厂, 参数] 形式传入 remarkPlugins（unified 会在解析后以 tree 调用返回的 transformer）
  const mentionHighlightPlugins: NonNullable<import('react-markdown').Options['remarkPlugins']> = useMemo(
    () => (mentionNames.length > 0 ? [[remarkMentionHighlight, mentionNames]] : []),
    [mentionNames]
  )

  // S7：blocks 路径与 Markdown 路径共用同一提及识别（纯文本分段，不注入 HTML）
  const renderWithMentions = useCallback((text: string) => {
    if (mentionNames.length === 0) return text
    const segments = splitMentionSegments(text, mentionNames)
    if (!segments.some((segment) => segment.mention)) return text
    return segments.map((segment, index) => segment.mention
      ? <span key={index} className="mention-highlight">{segment.text}</span>
      : <span key={index}>{segment.text}</span>)
  }, [mentionNames])

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

              {/* 正文 */}
              {/* BUG-09 修复：移除 rehypeRaw / allowDangerousHtml，防止消息内容中的原始 HTML 执行导致 XSS；
                  @提及高亮由 remarkMentionHighlight 插件在 AST 层完成 */}
              <div className="markdown-body">
                {semanticBlocks ? (
                  /* 阶段5：语义分块渲染——对白/叙述/混合段按 kind 呈现样式。
                     复用 markdown 路径同一套 CSS class，避免 blocks 消息“无样式”。 */
                  <div className="space-y-2">
                    {semanticBlocks.map((block, index) => {
                      if (block.kind === 'dialogue') {
                        // 对白块：左竖线引用形态；匿名对白同样结构、无名字行；展示层剥外层引号
                        return (
                          <p key={index} className="dialogue-block whitespace-pre-wrap select-text">
                            {block.speaker && <em className="dialogue-speaker">{block.speaker}</em>}
                            <em className="dialogue-text">{renderWithMentions(stripOuterQuotes(block.text))}</em>
                          </p>
                        )
                      }
                      if (block.kind === 'narration') {
                        // 叙述/动作：灰色弱化正文（不斜体、无底色）
                        return (
                          <p key={index} className="action-block whitespace-pre-wrap select-text">
                            {renderWithMentions(block.text)}
                          </p>
                        )
                      }
                      // mixed：普通正文渲染，行内对白按引号段染色（与 remark 路径 dialogue-inline 一致）
                      return (
                        <p key={index} className="whitespace-pre-wrap select-text text-tavern-text">
                          {splitQuoteSegments(block.text).map((seg, segIndex) => seg.quoted ? (
                            <em key={segIndex} className="dialogue-inline">{renderWithMentions(seg.text)}</em>
                          ) : (
                            <React.Fragment key={segIndex}>{renderWithMentions(seg.text)}</React.Fragment>
                          ))}
                        </p>
                      )
                    })}
                  </div>
                ) : (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkRoleplay, remarkAudio, ...mentionHighlightPlugins]}
                    rehypePlugins={[rehypeHighlight]}
                    components={markdownComponents}
                  >
                    {displayContent || ''}
                  </ReactMarkdown>
                )}
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
                canRegenerate={!!isLast && !!onRegenerateDirections}
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
