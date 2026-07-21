import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import { useCharacterStore } from '../../store/useCharacterStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { cn } from '../../lib/utils'
import { THEME_COLORS } from '../../utils/defaults'
import { X, Edit2, RefreshCw, Languages, Check } from 'lucide-react'
import type { GroupMessage } from '../../../shared/types'

interface GroupChatMessageProps {
  message: GroupMessage
  memberIndex?: number
  onDelete?: () => void
  onEdit?: (content: string) => void
  onRegenerate?: () => void
  onTranslate?: () => void
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

/** Markdown 内嵌图片组件：加载失败时显示重试按钮 */
function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const [error, setError] = useState(false)
  if (!src) return null
  if (error) {
    return (
      <button
        onClick={() => setError(false)}
        className="inline-flex items-center gap-1 px-2 py-1 rounded bg-tavern-bg-hover text-xs text-tavern-text-muted cursor-pointer hover:bg-tavern-bg-hover/80 transition-colors"
        title="点击重新加载图片"
      >
        <RefreshCw className="w-3 h-3" />
        <span>{alt || '图片加载失败'}</span>
      </button>
    )
  }
  return (
    <img
      src={src}
      alt={alt}
      onError={() => setError(true)}
      className="max-w-full rounded"
    />
  )
}

const markdownComponents = { img: MarkdownImage }

export function GroupChatMessage({ message, memberIndex, onDelete, onEdit, onRegenerate, onTranslate }: GroupChatMessageProps) {
  const { currentCharacter, characters } = useCharacterStore()
  const { settings } = useSettingsStore()
  const [showThought, setShowThought] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editDraft, setEditDraft] = useState('')
  const [showTranslation, setShowTranslation] = useState(false)
  const [imgErrors, setImgErrors] = useState<Set<number>>(new Set())

  const isUser = message.characterId === '__user__'
  const isFree = message.characterId === '__free__'
  const isStreaming = message.id === '__streaming__'

  const character = characters.find(c => c.id === message.characterId)
  const colorIdx = memberIndex ?? 0
  const borderColor = ROLE_COLORS[colorIdx % ROLE_COLORS.length]

  // 提取 <thought>
  const thoughtMatch = message.content.match(/<thought>([\s\S]*?)<\/thought>/i)
  const thoughtContent = thoughtMatch?.[1]?.trim()
  const mainContent = message.content.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim()

  const displayContent = showTranslation && message.translation ? message.translation : mainContent

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

  const hasActions = onDelete || onEdit || onRegenerate || onTranslate

  return (
    <div className={cn(
      'flex gap-3 msg-row',
      isUser ? 'flex-row-reverse' : 'flex-row'
    )}>
      {/* 头像 */}
      <div className="shrink-0 mt-0.5">
        {isUser ? (
          <div className="w-8 h-8 rounded-full bg-tavern-user/15 text-tavern-user flex items-center justify-center text-xs font-bold">
            你
          </div>
        ) : character?.avatar ? (
          <img src={character.avatar} className="w-8 h-8 rounded-full object-cover" alt="" />
        ) : (
          <div className={cn(
            'w-8 h-8 rounded-full bg-tavern-bg-hover flex items-center justify-center text-xs font-bold',
            isStreaming && 'animate-pulse'
          )}>
            {character?.translatedContent?.name?.[0] ?? character?.name?.[0] ?? '?'}
          </div>
        )}
      </div>

      {/* 气泡 */}
      <div className={cn(
        'max-w-[75%] min-w-[80px]',
        isUser ? 'items-end' : 'items-start'
      )}>
        {/* 发送者名称 */}
        <div className={cn(
          'text-[10px] mb-0.5 text-tavern-text-muted',
          isUser ? 'text-right' : 'text-left'
        )}>
          {isUser ? (settings.userName || '你') : (character?.translatedContent?.name ?? character?.name ?? '未知')}
          {isStreaming && ' · 生成中...'}
        </div>

        {/* 气泡本体 */}
        <div className={cn(
          'rounded-2xl px-4 py-2.5 text-sm leading-relaxed break-words relative group/bubble',
          isUser
            ? 'bg-tavern-user/15 border border-tavern-user/20 text-tavern-text rounded-br-md'
            : cn('border-l-[3px] bg-tavern-bg-card', borderColor, 'text-tavern-text rounded-bl-md',
                 isStreaming && 'border-dashed')
        )}>
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
              {/* Thought 折叠区 */}
              {thoughtContent && (
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
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[
                    ...(settings.htmlRendering ? [rehypeRaw] : []),
                    rehypeHighlight,
                  ]}
                  components={markdownComponents}
                >
                  {displayContent || ''}
                </ReactMarkdown>
              </div>

              {/* 翻译切换 */}
              {message.translation && message.translation !== '...' && (
                <button
                  onClick={() => setShowTranslation(!showTranslation)}
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

              {/* 时间 */}
              <div className={cn(
                'text-[10px] text-tavern-text-muted/60 mt-1',
                isUser ? 'text-right' : 'text-left'
              )}>
                {new Date(message.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
              </div>
            </>
          )}

          {/* 操作按钮组 (hover 可见) */}
          {hasActions && !isEditing && !isStreaming && (
            <div className="absolute top-1 right-1 flex items-center gap-0.5 opacity-0 group-hover/bubble:opacity-100 transition-opacity">
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
  )
}
