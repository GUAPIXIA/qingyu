import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, Sliders, Users, UserCircle, Plus, Star } from 'lucide-react'
import { useChatStore } from '../../store/useChatStore'
import { useCharacterStore } from '../../store/useCharacterStore'
import { charAssetUrl } from '../../utils/asset'
import { useSettingsStore } from '../../store/useSettingsStore'
import { usePersonaStore } from '../../store/usePersonaStore'
import { Dropdown } from '../common/Dropdown'
import { SessionSwitcher } from '../common/SessionSwitcher'
import { CharacterAvatar } from '../character/CharacterAvatar'
import { getDisplayName } from '../../utils/variables'
import { MemoryPanel } from './MemoryPanel'
import { TokenUsage } from './TokenUsage'
import { cn } from '../../lib/utils'
import type { Character } from '../../../shared/types'

interface ChatHeaderProps {
  currentCharacter: Character
  isStreaming: boolean
  totalChars: number
  showQuickSettings: boolean
  onShowQuickSettings: () => void
  onCreateSession: () => void
}

export function ChatHeader({
  currentCharacter,
  isStreaming,
  totalChars,
  showQuickSettings,
  onShowQuickSettings,
  onCreateSession,
}: ChatHeaderProps) {
  const navigate = useNavigate()
  // P-6 修复：字段级选择器订阅，避免流式 flush（50ms）时顶栏整体重渲染
  const sessions = useChatStore((s) => s.sessions)
  const currentSessionId = useChatStore((s) => s.currentSessionId)
  const switchSession = useChatStore((s) => s.switchSession)
  const deleteSession = useChatStore((s) => s.deleteSession)
  const renameSession = useChatStore((s) => s.renameSession)
  const toggleMemory = useChatStore((s) => s.toggleMemory)
  const setMemoryMode = useChatStore((s) => s.setMemoryMode)
  const updateMemoryFacts = useChatStore((s) => s.updateMemoryFacts)
  const triggerMemorySummary = useChatStore((s) => s.triggerMemorySummary)
  const getStats = useChatStore((s) => s.getStats)
  const characters = useCharacterStore((s) => s.characters)
  const selectCharacter = useCharacterStore((s) => s.selectCharacter)
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const personas = usePersonaStore((s) => s.personas)
  const getPersona = usePersonaStore((s) => s.getPersona)

  const [showCharMenu, setShowCharMenu] = useState(false)
  const [showPersonaMenu, setShowPersonaMenu] = useState(false)
  const [showMemoryPanel, setShowMemoryPanel] = useState(false)
  const [memoryStats, setMemoryStats] = useState<{ totalMessages: number; totalChars: number; durationStr: string } | null>(null)
  const [memoryInterval, setMemoryInterval] = useState(10)

  // 切换当前会话的身份
  const handleSwitchPersona = async (personaId: string | null) => {
    if (!currentCharacter || !currentSessionId) return
    await window.api.chat.updateSession(currentCharacter.id, currentSessionId, { personaId })
    useChatStore.setState(s => ({
      sessions: s.sessions.map(sess =>
        sess.id === currentSessionId ? { ...sess, personaId: personaId ?? undefined } : sess
      ),
    }))
    const persona = personaId ? getPersona(personaId) : undefined
    if (persona) {
      updateSettings({
        activePersonaId: persona.id,
        userName: persona.name,
        userDescription: persona.description,
        userPersona: persona.persona,
      })
    } else {
      updateSettings({
        activePersonaId: null,
        userName: '用户',
        userDescription: '',
        userPersona: '',
      })
    }
    setShowPersonaMenu(false)
  }

  return (
    <header className="relative z-30 flex items-center justify-between px-4 h-14 border-b border-tavern-border-soft bg-tavern-bg-soft shrink-0">
      <div className="flex items-center gap-3">
        {/* 角色选择下拉 */}
        <Dropdown
          open={showCharMenu}
          onOpenChange={setShowCharMenu}
          panelClassName="w-64 max-h-80 overflow-y-auto"
          trigger={
            <button className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-tavern-bg-hover transition-colors">
              <CharacterAvatar
                avatar={currentCharacter.avatar || charAssetUrl(currentCharacter.id, 'avatar', currentCharacter.updatedAt)}
                name={getDisplayName(currentCharacter)}
                size="md"
                fallbackClassName="bg-tavern-assistant/20 text-tavern-assistant"
              />
              <div className="text-left">
                <div className="text-sm font-medium text-tavern-text">{getDisplayName(currentCharacter)}</div>
                <div className="text-xs text-tavern-text-muted">
                  {isStreaming ? '生成中...' : '在线'}
                </div>
              </div>
              <ChevronDown className="w-4 h-4 text-tavern-text-muted" />
            </button>
          }
        >
          {characters.length === 0 ? (
            <div className="px-4 py-3 text-sm text-tavern-text-muted text-center">
              暂无角色，请先创建
            </div>
          ) : (
            characters.map((char) => (
              <button
                key={char.id}
                onClick={() => {
                  selectCharacter(char.id)
                  setShowCharMenu(false)
                }}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2 hover:bg-tavern-bg-hover transition-colors text-left',
                  char.id === currentCharacter.id && 'bg-tavern-accent-soft'
                )}
              >
                <CharacterAvatar
                  avatar={char.avatar || charAssetUrl(char.id, 'avatar', char.updatedAt)}
                  name={getDisplayName(char)}
                  size="md"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-tavern-text truncate">{getDisplayName(char)}</div>
                  {char.tags?.[0] && (
                    <div className="text-xs text-tavern-text-muted truncate">{char.tags[0]}</div>
                  )}
                </div>
              </button>
            ))
          )}
          <div className="border-t border-tavern-border-soft mt-1 pt-1">
            <button
              onClick={() => {
                navigate('/characters')
                setShowCharMenu(false)
              }}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-tavern-bg-hover transition-colors text-sm text-tavern-accent"
            >
              <Users className="w-4 h-4" />
              管理角色
            </button>
          </div>
        </Dropdown>

        {/* 身份切换器 */}
        <span className="text-tavern-border-soft select-none">|</span>
        <Dropdown
          open={showPersonaMenu}
          onOpenChange={setShowPersonaMenu}
          panelClassName="w-48 max-h-60 overflow-y-auto"
          trigger={
            <button
              className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-tavern-bg-hover transition-colors text-sm"
              title="切换身份"
            >
              {(() => {
                const session = sessions.find(s => s.id === currentSessionId)
                const persona = getPersona(session?.personaId)
                if (persona?.avatar) {
                  return <img src={persona.avatar} alt="" className="w-5 h-5 rounded-full object-cover" />
                }
                return <UserCircle className="w-4 h-4 text-tavern-text-muted" />
              })()}
              <span className="max-w-[80px] truncate text-tavern-text-soft">
                {(() => {
                  const s = sessions.find(s => s.id === currentSessionId)
                  const p = getPersona(s?.personaId)
                  return p?.name ?? '身份'
                })()}
              </span>
              <ChevronDown className="w-3 h-3 text-tavern-text-muted" />
            </button>
          }
        >
          {(() => {
            const currentSession = sessions.find(s => s.id === currentSessionId)
            const currentPersonaId = currentSession?.personaId
            return (
              <>
                <button
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-2 hover:bg-tavern-bg-hover transition-colors text-sm text-tavern-text',
                    !currentPersonaId && 'bg-tavern-accent-soft'
                  )}
                  onClick={() => handleSwitchPersona(null)}
                >
                  <UserCircle className="w-4 h-4 text-tavern-text-muted" />
                  不使用身份
                  {!currentPersonaId && <span className="ml-auto text-tavern-accent text-xs">✓</span>}
                </button>
                {personas.map((p) => (
                  <button
                    key={p.id}
                    className={cn(
                      'w-full flex items-center gap-2 px-3 py-2 hover:bg-tavern-bg-hover transition-colors text-sm text-tavern-text',
                      currentPersonaId === p.id && 'bg-tavern-accent-soft'
                    )}
                    onClick={() => handleSwitchPersona(p.id)}
                  >
                    {p.avatar ? (
                      <img src={p.avatar} alt="" className="w-5 h-5 rounded-full object-cover" />
                    ) : (
                      <UserCircle className="w-4 h-4 text-tavern-text-muted" />
                    )}
                    <span className="truncate">{p.name}</span>
                    {settings.defaultPersonaId === p.id && (
                      <span title="默认身份" className="shrink-0">
                        <Star className="w-3 h-3 text-tavern-warning" />
                      </span>
                    )}
                    {currentPersonaId === p.id && <span className="ml-auto text-tavern-accent text-xs">✓</span>}
                  </button>
                ))}
              </>
            )
          })()}
        </Dropdown>

        {/* 会话切换器 + 长记忆按钮 */}
        <SessionSwitcher
          sessions={sessions}
          currentSessionId={currentSessionId}
          showPersona
          getPersona={getPersona}
          onSwitch={(id) => switchSession(id, currentCharacter)}
          onRename={(id, title) => renameSession(currentCharacter.id, id, title)}
          onDelete={(id) => deleteSession(currentCharacter.id, id)}
          onCreate={() => onCreateSession()}
          extra={<>
            {/* 新建会话按钮（Chat 风格） */}
            <button
              onClick={() => onCreateSession()}
              className="p-2 rounded-lg text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover transition-colors"
              title="新建会话"
            >
              <Plus className="w-4 h-4" />
            </button>
            <MemoryPanel
              open={showMemoryPanel}
              onToggle={async () => {
                if (!showMemoryPanel && currentCharacter && currentSessionId) {
                  const stats = await getStats(currentCharacter.id, currentSessionId)
                  if (stats) setMemoryStats(stats)
                  const curS = sessions.find(s => s.id === currentSessionId)
                  setMemoryInterval(curS?.autoMemoryInterval ?? 10)
                }
                setShowMemoryPanel(!showMemoryPanel)
              }}
              sessions={sessions}
              currentSessionId={currentSessionId}
              currentCharacterId={currentCharacter?.id ?? null}
              memoryInterval={memoryInterval}
              onMemoryIntervalChange={setMemoryInterval}
              onToggleMemory={(enabled) => {
                if (currentCharacter && currentSessionId) toggleMemory(currentCharacter.id, currentSessionId, enabled)
              }}
              onSetMemoryMode={(mode, interval) => {
                if (currentCharacter && currentSessionId) setMemoryMode(currentCharacter.id, currentSessionId, mode, interval)
              }}
              onUpdateMemoryFacts={(facts) => {
                if (!currentCharacter || !currentSessionId) return Promise.resolve()
                return updateMemoryFacts(currentCharacter.id, currentSessionId, facts)
              }}
              onTriggerSummary={() => {
                if (currentCharacter) triggerMemorySummary(currentCharacter)
              }}
              isStreaming={isStreaming}
              memoryStats={memoryStats}
            />
          </>}
        />
      </div>

      {/* 右上角快捷设置直达入口 */}
      <div className="flex items-center gap-1">
        <span className="mr-1 hidden sm:inline"><TokenUsage chars={totalChars} /></span>
        <button
          type="button"
          aria-label="快捷设置"
          aria-expanded={showQuickSettings}
          onClick={onShowQuickSettings}
          className={cn(
            'p-2 rounded-lg transition-colors',
            showQuickSettings
              ? 'text-tavern-accent bg-tavern-accent-soft'
              : 'text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover'
          )}
          title="快捷设置"
        >
          <Sliders className="w-5 h-5" />
        </button>
      </div>
    </header>
  )
}
