import type { Character } from '../../../shared/types'
import { useCharacterStore } from '../../store/useCharacterStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { formatRelativeTime } from '../../utils/format'
import { getDisplayName } from '../../utils/variables'
import { Edit3, Trash2, MessageSquare, Download, Eye, EyeOff, Pin, Languages, Loader2 } from 'lucide-react'
import { useState, useMemo } from 'react'
import { cn } from '../../lib/utils'

interface CharacterCardProps {
  character: Character
  onEdit: () => void
  onDelete: () => void
  onChat: () => void
  onDetail?: () => void
  viewMode?: 'grid' | 'list'
  cardSize?: 'sm' | 'md' | 'lg'
}

/** 按逗号、中文逗号、换行分割 personality 文本为碎片 */
function splitPersonality(text: string): string[] {
  return text
    .split(/[,，、\n]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0 && s.length < 20)
}

export function CharacterCard({ character, onEdit, onDelete, onChat, onDetail, viewMode = 'grid', cardSize = 'md' }: CharacterCardProps) {
  const { exportPng, exportJson, togglePin, patchCharacter } = useCharacterStore()
  const blurStrength = useSettingsStore(s => s.settings.coverBlurStrength ?? 8)
  const [showMenu, setShowMenu] = useState(false)
  const [imgError, setImgError] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [translating, setTranslating] = useState(false)
  const coverSrc = character.cover || character.avatar
  const blurEnabled = character.coverBlurEnabled === true

  const handleTranslateFirstMessage = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const text = character.firstMessage
    if (!text || translating) return

    const profile = useSettingsStore.getState().getActiveProfile()
    if (!profile || (!profile.apiKey && profile.provider !== 'ollama')) return

    setTranslating(true)
    const requestId = `translate-fm-${Date.now()}-${Math.random().toString(36).slice(2)}`

    try {
      const result = await new Promise<string>((resolve) => {
        let collected = ''
        const unbindChunk = window.api.ai.onChunk((data) => {
          if (data.requestId !== requestId) return
          collected += data.text
        })
        const unbindDone = window.api.ai.onDone((doneId) => {
          if (doneId !== requestId) return
          unbindChunk(); unbindDone(); unbindError()
          const cleaned = collected.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim()
          resolve(cleaned || text)
        })
        const unbindError = window.api.ai.onError((data) => {
          if (data.requestId !== requestId) return
          unbindChunk(); unbindDone(); unbindError()
          resolve('')
        })

        window.api.ai.chat({
          requestId,
          messages: [
            {
              role: 'system',
              content: [
                '你是一位资深的 AI 角色扮演本地化翻译专家，专门将英文角色卡精准翻译为中文。',
                '- 这是角色初次见面对话/开场独白，保持人物语气和口吻风格',
                '- 对话中的人名一并翻译为中文',
                '- 保留所有 Markdown 格式、特殊标记（{{user}}、{{char}}、*动作描写* 等）不变',
                '- 只输出翻译结果，禁止添加解释、备注或额外内容',
              ].join('\n'),
            },
            { role: 'user', content: text },
          ],
          provider: profile.provider,
          apiKey: profile.apiKey,
          baseUrl: profile.baseUrl,
          model: useSettingsStore.getState().settings.activeModel || profile.model,
          temperature: 0.3,
          topP: 0.9,
          maxTokens: 4096,
          frequencyPenalty: 0,
          presencePenalty: 0,
          stream: true,
        })
      })

      if (result) {
        const tc = { ...(character.translatedContent || {}) }
        tc.firstMessage = result
        useCharacterStore.getState().patchCharacter(character.id, { translatedContent: tc } as Partial<Character>)
      }
    } catch {
      // 翻译失败静默处理
    } finally {
      setTranslating(false)
    }
  }

  const personalityChips = useMemo(() => {
    const text = character.translatedContent?.personality ?? character.personality
    if (!text) return []
    return splitPersonality(text)
  }, [character.personality, character.translatedContent?.personality])

  const scenarioText = character.translatedContent?.scenario ?? character.scenario

  const handlePreviewClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (coverSrc && !imgError) setShowPreview(true)
  }

  const toggleBlur = () => {
    patchCharacter(character.id, { coverBlurEnabled: !blurEnabled })
  }

  // ---- 尺寸相关配置 ----
  const sizeConfig = {
    sm: {
      coverAspect: 'aspect-square',
      nameSize: 'text-xs',
      showPersonality: 0,
      showTags: 1,
      showScenario: false,
      showCreator: false,
      padding: 'p-1.5',
      gap: 'gap-1',
      tagSize: 'text-[10px]',
    },
    md: {
      coverAspect: 'aspect-[3/4]',
      nameSize: 'text-sm',
      showPersonality: 3,
      showTags: 3,
      showScenario: true,
      showCreator: true,
      padding: 'p-2.5',
      gap: 'gap-1.5',
      tagSize: 'text-[10px]',
    },
    lg: {
      coverAspect: 'aspect-[2/3]',
      nameSize: 'text-base',
      showPersonality: 99,
      showTags: 99,
      showScenario: true,
      showCreator: true,
      padding: 'p-3',
      gap: 'gap-2',
      tagSize: 'text-xs',
    },
  }[cardSize]

  const cfg = sizeConfig

  const renderAvatar = (className: string) => (
    <div
      className={cn('bg-tavern-bg-hover overflow-hidden cursor-pointer relative group/cover', className)}
      onClick={handlePreviewClick}
    >
      {coverSrc && !imgError ? (
        <>
          <div
            className="absolute inset-0"
            style={blurEnabled ? { filter: `blur(${blurStrength}px)` } : undefined}
          >
            <img
              src={coverSrc}
              alt={character.name}
              className={cn(
                'w-full h-full object-cover transition-all duration-300',
                blurEnabled ? 'scale-110' : 'group-hover/cover:scale-105',
              )}
              onError={() => setImgError(true)}
            />
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); toggleBlur() }}
            className={cn(
              'absolute top-2 right-2 p-1.5 rounded-full transition-all duration-200 z-10',
              'opacity-0 group-hover/cover:opacity-100',
              blurEnabled
                ? 'bg-tavern-accent/80 text-white'
                : 'bg-black/40 text-white/60 hover:bg-black/60 hover:text-white',
            )}
            title={blurEnabled ? '取消毛玻璃' : '毛玻璃效果'}
          >
            {blurEnabled ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        </>
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <span className={cn('font-display text-tavern-text-muted', viewMode === 'list' ? 'text-xl' : cardSize === 'sm' ? 'text-2xl' : 'text-4xl')}>
            {character.translatedContent?.name?.[0] ?? character.name[0]}
          </span>
        </div>
      )}
    </div>
  )

  const actionButtons = (
    <>
      <button
        onClick={(e) => { e.stopPropagation(); onChat() }}
        className="p-2 rounded-lg bg-tavern-accent text-tavern-bg hover:bg-tavern-accent-hover transition-colors"
        title="开始对话"
      >
        <MessageSquare className="w-4 h-4" />
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onEdit() }}
        className="p-2 rounded-lg bg-white/90 text-gray-700 hover:bg-white hover:text-gray-900 transition-colors shadow-sm"
        title="编辑"
      >
        <Edit3 className="w-4 h-4" />
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu) }}
        className="p-2 rounded-lg bg-white/90 text-gray-700 hover:bg-white hover:text-gray-900 transition-colors relative shadow-sm"
        title="导出"
      >
        <Download className="w-4 h-4" />
        {showMenu && (
          <>
            <div className="fixed inset-0 z-10" onClick={(e) => { e.stopPropagation(); setShowMenu(false) }} />
            <div className="absolute bottom-full right-0 mb-1 z-20 bg-tavern-bg-card border border-tavern-border rounded-lg shadow-xl py-1 text-sm min-w-[120px]">
              <button
                onClick={(e) => { e.stopPropagation(); exportPng(character.id); setShowMenu(false) }}
                className="w-full px-4 py-2 text-left hover:bg-tavern-bg-hover transition-colors flex items-center gap-2"
              >
                <Download className="w-3.5 h-3.5" />
                导出 PNG
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); exportJson(character.id); setShowMenu(false) }}
                className="w-full px-4 py-2 text-left hover:bg-tavern-bg-hover transition-colors flex items-center gap-2"
              >
                <Download className="w-3.5 h-3.5" />
                导出 JSON
              </button>
            </div>
          </>
        )}
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete() }}
        className="p-2 rounded-lg bg-tavern-danger/90 text-white hover:bg-tavern-danger transition-colors"
        title="删除角色"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </>
  )

  // 标签 + 性格碎片行
  const renderTagsAndChips = () => {
    const visibleTags = character.tags.slice(0, cfg.showTags)
    const hiddenTagCount = character.tags.length - visibleTags.length
    const visibleChips = personalityChips.slice(0, cfg.showPersonality)
    const hiddenChipCount = personalityChips.length - visibleChips.length

    return (
      <div className={cn('flex flex-wrap items-center', cfg.gap)}>
        {/* 性格碎片 — 区别于 tags 的柔和色彩 */}
        {visibleChips.map((chip) => (
          <span
            key={`p-${chip}`}
            className={cn('px-1.5 py-0.5 rounded-full bg-tavern-accent/10 text-tavern-accent/80', cfg.tagSize)}
          >
            {chip}
          </span>
        ))}
        {hiddenChipCount > 0 && (
          <span className={cn('text-tavern-text-muted', cfg.tagSize)}>+{hiddenChipCount}</span>
        )}
        {/* 标签 */}
        {visibleTags.map((tag) => (
          <span
            key={tag}
            className={cn('px-1.5 py-0.5 rounded bg-tavern-bg-hover text-tavern-text-soft', cfg.tagSize)}
          >
            {tag}
          </span>
        ))}
        {hiddenTagCount > 0 && (
          <span className={cn('text-tavern-text-muted', cfg.tagSize)}>+{hiddenTagCount}</span>
        )}
      </div>
    )
  }

  // 共享的大图预览
  const previewOverlay = showPreview && coverSrc && (
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-8 animate-fade-in"
      onClick={() => setShowPreview(false)}
    >
      <button
        className="absolute top-4 right-4 p-2 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors text-lg"
        onClick={() => setShowPreview(false)}
      >
        ✕
      </button>
      <img
        src={coverSrc}
        alt={character.name}
        className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  )

  // ====== 列表模式 ======
  if (viewMode === 'list') {
    return (
      <>
        <div
          className="flex gap-4 p-3 rounded-xl border border-tavern-border-soft bg-tavern-bg-card hover:border-tavern-accent/50 transition-colors group cursor-pointer"
          onClick={onDetail}
        >
          <div className="shrink-0 relative">
            {renderAvatar('w-20 h-28 rounded-lg overflow-hidden')}
            <button
              onClick={(e) => { e.stopPropagation(); togglePin(character.id) }}
              className={cn(
                'absolute top-1 left-1 p-1 rounded-full transition-all duration-200 z-10',
                character.pinned
                  ? 'bg-tavern-accent text-white'
                  : 'bg-black/40 text-white/60 hover:bg-black/60 hover:text-white opacity-0 group-hover:opacity-100'
              )}
              title={character.pinned ? '取消置顶' : '置顶'}
            >
              <Pin className={cn('w-3 h-3', character.pinned && 'fill-current')} />
            </button>
          </div>

          <div className="flex-1 min-w-0 flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-medium text-tavern-text">{getDisplayName(character)}</h3>
                {character.pinned && <Pin className="w-3 h-3 text-tavern-accent fill-current" />}
              </div>
              <div className="mt-1.5">{renderTagsAndChips()}</div>
              {cfg.showScenario && scenarioText && (
                <p className="text-xs text-tavern-text-muted/70 mt-1 line-clamp-1 italic">{scenarioText}</p>
              )}
              {character.firstMessage && (
                <p className="text-xs text-tavern-text-muted/70 mt-1 line-clamp-2 leading-relaxed">{character.translatedContent?.firstMessage ?? character.firstMessage}</p>
              )}
            </div>
            <div className="flex items-center justify-between mt-2">
              <div className="flex items-center gap-2 text-xs text-tavern-text-muted">
                <span>{formatRelativeTime(character.updatedAt)}</span>
                {/* 首条消息翻译按钮 */}
                {character.firstMessage && !character.translatedContent?.firstMessage && (
                  <button
                    onClick={handleTranslateFirstMessage}
                    disabled={translating}
                    className="p-0.5 rounded text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-accent/10 transition-colors"
                    title="翻译首条消息"
                  >
                    {translating ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Languages className="w-3 h-3" />
                    )}
                  </button>
                )}
                {cfg.showCreator && character.creator && (
                  <span className="text-tavern-text-muted/60">@{character.creator}</span>
                )}
              </div>
              <div className="flex gap-1">{actionButtons}</div>
            </div>
          </div>
        </div>
        {previewOverlay}
      </>
    )
  }

  // ====== 网格模式 ======
  return (
    <div
      className="card overflow-hidden group hover:border-tavern-accent transition-colors cursor-pointer"
      onClick={onDetail}
    >
      {/* 封面区 */}
      <div className="relative">
        {renderAvatar(cfg.coverAspect)}

        {/* 置顶按钮 */}
        <button
          onClick={(e) => { e.stopPropagation(); togglePin(character.id) }}
          className={cn(
            'absolute top-2 left-2 p-1.5 rounded-full transition-all duration-200 z-10',
            'opacity-0 group-hover:opacity-100',
            character.pinned
              ? 'bg-tavern-accent text-white opacity-100'
              : 'bg-black/40 text-white/60 hover:bg-black/60 hover:text-white'
          )}
          title={character.pinned ? '取消置顶' : '置顶'}
        >
          <Pin className={cn('w-3.5 h-3.5', character.pinned && 'fill-current')} />
        </button>

        {/* 操作按钮悬浮层 */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end justify-end p-2 gap-1 pointer-events-none">
          <div className="pointer-events-auto flex gap-1">{actionButtons}</div>
        </div>
      </div>

      {/* 信息区 */}
      <div className={cfg.padding}>
        <h3 className={cn('font-medium text-tavern-text truncate', cfg.nameSize)}>
          {getDisplayName(character)}
        </h3>

        {/* 性格碎片 + 标签 */}
        {(personalityChips.length > 0 || character.tags.length > 0) && (
          <div className="mt-1.5">{renderTagsAndChips()}</div>
        )}

        {/* 场景预览 */}
        {cfg.showScenario && scenarioText && (
          <p className="text-xs text-tavern-text-muted/60 mt-1 line-clamp-1 italic">
            {scenarioText}
          </p>
        )}

        {/* 首条消息预览（中/大卡） */}
        {cardSize !== 'sm' && character.firstMessage && (
          <p className={cn('text-tavern-text-muted/70 mt-1 line-clamp-2 leading-relaxed', cardSize === 'lg' ? 'text-xs' : 'text-[11px]')}>
            {character.translatedContent?.firstMessage ?? character.firstMessage}
          </p>
        )}

        {/* 底部：时间 + 翻译 + 创作者 */}
        <div className={cn('flex items-center justify-between mt-1.5', cardSize === 'sm' ? 'text-[10px]' : 'text-xs')}>
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-tavern-text-muted shrink-0">{formatRelativeTime(character.updatedAt)}</span>
            {/* 首条消息翻译按钮（仅中/大卡，有首条消息时显示） */}
            {cardSize !== 'sm' && character.firstMessage && !character.translatedContent?.firstMessage && (
              <button
                onClick={handleTranslateFirstMessage}
                disabled={translating}
                className="shrink-0 p-0.5 rounded text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-accent/10 transition-colors"
                title="翻译首条消息"
              >
                {translating ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Languages className="w-3 h-3" />
                )}
              </button>
            )}
          </div>
          {cfg.showCreator && character.creator && (
            <span className="text-tavern-text-muted/50 truncate ml-2">@{character.creator}</span>
          )}
        </div>
      </div>

      {previewOverlay}
    </div>
  )
}
