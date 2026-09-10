import { useEffect, useRef, useState } from 'react'
import { Globe2, UserRound } from 'lucide-react'
import type { NarrativeMode } from '../../../shared/types'
import { NARRATIVE_MODE_OPTIONS, resolveNarrativeMode } from '../../../shared/narrativeMode'
import { cn } from '../../lib/utils'
import { logError } from '../../lib/logger'
import { useChatStore } from '../../store/useChatStore'

interface NarrativeModeSwitcherProps {
  characterId: string
  isStreaming: boolean
}

/** 单聊会话级叙事模式切换器。旧会话缺少字段时固定按代入模式显示。 */
export function NarrativeModeSwitcher({ characterId, isStreaming }: NarrativeModeSwitcherProps) {
  const sessions = useChatStore((state) => state.sessions)
  const currentSessionId = useChatStore((state) => state.currentSessionId)
  const updateSessionField = useChatStore((state) => state.updateSessionField)
  const currentSession = sessions.find((session) => session.id === currentSessionId)
  const activeMode = resolveNarrativeMode(currentSession?.narrativeMode)
  const [savingMode, setSavingMode] = useState<NarrativeMode | null>(null)
  const [notice, setNotice] = useState<{ success: boolean; text: string } | null>(null)
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
  }, [])

  const showNotice = (nextNotice: { success: boolean; text: string }) => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    setNotice(nextNotice)
    noticeTimerRef.current = setTimeout(() => setNotice(null), 2400)
  }

  const changeMode = async (mode: NarrativeMode) => {
    if (!currentSessionId || isStreaming || savingMode || mode === activeMode) return
    setSavingMode(mode)
    try {
      await updateSessionField(characterId, currentSessionId, 'narrativeMode', mode)
      const label = NARRATIVE_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? mode
      showNotice({ success: true, text: `已切换为${label}，仅影响后续回复` })
    } catch (error) {
      logError('NarrativeModeSwitcher:updateSession', error)
      showNotice({ success: false, text: '叙事模式保存失败，请重试' })
    } finally {
      setSavingMode(null)
    }
  }

  const disabled = isStreaming || !currentSessionId || savingMode !== null

  return (
    <div className="relative shrink-0">
      <div
        role="radiogroup"
        aria-label="叙事模式"
        className="flex items-center gap-0.5 rounded-lg border border-tavern-border-soft bg-tavern-bg/70 p-0.5"
      >
        {NARRATIVE_MODE_OPTIONS.map((option) => {
          const selected = option.value === activeMode
          const Icon = option.value === 'immersive' ? UserRound : Globe2
          const compactLabel = option.value === 'immersive' ? '代入' : '全局'

          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={option.label}
              disabled={disabled}
              title={`${option.label}：${option.description}${isStreaming ? '（回复生成完成后可切换）' : ''}`}
              onClick={() => void changeMode(option.value)}
              className={cn(
                'flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium transition-all',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tavern-accent/50',
                'disabled:cursor-not-allowed disabled:opacity-50',
                selected
                  ? 'bg-tavern-accent-soft text-tavern-accent shadow-sm'
                  : 'text-tavern-text-muted hover:bg-tavern-bg-hover hover:text-tavern-text-soft',
              )}
            >
              <Icon className={cn('h-3.5 w-3.5 shrink-0', savingMode === option.value && 'animate-pulse')} />
              <span className="hidden xl:inline">{compactLabel}</span>
            </button>
          )
        })}
      </div>

      {notice && (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            'absolute left-1/2 top-full z-50 mt-2 -translate-x-1/2 whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-[10px] shadow-lg',
            notice.success
              ? 'border-tavern-accent/25 bg-tavern-bg-card text-tavern-text-soft'
              : 'border-tavern-danger/30 bg-tavern-bg-card text-tavern-danger',
          )}
        >
          {notice.text}
        </div>
      )}
    </div>
  )
}
