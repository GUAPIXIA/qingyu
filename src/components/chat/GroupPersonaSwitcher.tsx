import { useState } from 'react'
import { ChevronDown, Star, UserCircle } from 'lucide-react'
import { useGroupChatStore } from '../../store/useGroupChatStore'
import { usePersonaStore } from '../../store/usePersonaStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { cn } from '../../lib/utils'
import { Dropdown } from '../common/Dropdown'

/** 群聊会话级身份切换器：身份会参与 {{user}} 替换与用户人设注入。 */
export function GroupPersonaSwitcher() {
  const sessions = useGroupChatStore((state) => state.sessions)
  const currentSessionId = useGroupChatStore((state) => state.currentSessionId)
  const setSessionPersona = useGroupChatStore((state) => state.setSessionPersona)
  const personas = usePersonaStore((state) => state.personas)
  const getPersona = usePersonaStore((state) => state.getPersona)
  const defaultPersonaId = useSettingsStore((state) => state.settings.defaultPersonaId)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  const currentSession = sessions.find((session) => session.id === currentSessionId)
  const effectivePersonaId = currentSession?.personaId === undefined
    ? defaultPersonaId
    : currentSession.personaId
  const currentPersona = getPersona(effectivePersonaId)
  const currentLabel = currentPersona?.name ?? '不使用身份'

  const switchPersona = async (personaId: string | null) => {
    if (!currentSessionId || saving) return
    setSaving(true)
    try {
      await setSessionPersona(personaId)
      setOpen(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dropdown
      open={open}
      onOpenChange={setOpen}
      panelClassName="w-56 max-h-72 overflow-y-auto"
      trigger={
        <button
          type="button"
          aria-label={`当前身份：${currentLabel}，点击切换`}
          disabled={!currentSessionId || saving}
          className="group/persona flex min-w-0 items-center gap-2 rounded-xl border border-tavern-border-soft bg-tavern-bg px-2.5 py-1.5 text-left transition-all hover:border-tavern-accent/40 hover:bg-tavern-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="relative grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-full bg-tavern-accent-soft text-tavern-accent ring-1 ring-tavern-accent/20">
            {currentPersona?.avatar ? (
              <img src={currentPersona.avatar} alt="" className="h-full w-full object-cover" />
            ) : (
              <UserCircle className="h-4 w-4" />
            )}
            <span className="absolute bottom-0 right-0 h-2 w-2 rounded-full border border-tavern-bg bg-tavern-success" />
          </span>
          <span className="min-w-0">
            <span className="block text-[10px] leading-none text-tavern-text-muted">我的身份</span>
            <span className="mt-1 block max-w-24 truncate text-xs font-medium text-tavern-text-soft">{currentLabel}</span>
          </span>
          <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-tavern-text-muted transition-transform', open && 'rotate-180')} />
        </button>
      }
    >
      <div className="px-3 pb-1.5 pt-2">
        <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-tavern-text-muted">以谁的身份参与本会话</p>
      </div>
      <button
        type="button"
        aria-label="切换为身份：不使用身份"
        onClick={() => switchPersona(null)}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-tavern-bg-hover',
          !effectivePersonaId && 'bg-tavern-accent-soft text-tavern-accent',
        )}
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-tavern-bg-hover text-tavern-text-muted">
          <UserCircle className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate">不使用身份</span>
          <span className="block text-[10px] text-tavern-text-muted">显示为“用户”</span>
        </span>
        {!effectivePersonaId && <span className="text-xs">✓</span>}
      </button>
      {personas.map((persona) => (
        <button
          key={persona.id}
          type="button"
          aria-label={`切换为身份：${persona.name}`}
          onClick={() => switchPersona(persona.id)}
          className={cn(
            'flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-tavern-text transition-colors hover:bg-tavern-bg-hover',
            effectivePersonaId === persona.id && 'bg-tavern-accent-soft text-tavern-accent',
          )}
        >
          <span className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-full bg-tavern-bg-hover text-tavern-text-muted">
            {persona.avatar ? (
              <img src={persona.avatar} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="text-xs font-bold">{persona.name[0] || '你'}</span>
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1 truncate">
              <span className="truncate">{persona.name}</span>
              {defaultPersonaId === persona.id && <Star className="h-3 w-3 shrink-0 text-tavern-warning" aria-label="默认身份" />}
            </span>
            {persona.description && <span className="block truncate text-[10px] text-tavern-text-muted">{persona.description}</span>}
          </span>
          {effectivePersonaId === persona.id && <span className="text-xs">✓</span>}
        </button>
      ))}
      {personas.length === 0 && (
        <p className="px-3 py-3 text-center text-xs text-tavern-text-muted">暂无可用身份，请先在身份页面创建</p>
      )}
    </Dropdown>
  )
}
