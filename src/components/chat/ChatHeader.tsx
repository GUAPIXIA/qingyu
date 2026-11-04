import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, Sliders, Users, UserCircle, Plus, Star, Globe2, Compass } from 'lucide-react'
import { useChatStore } from '../../store/useChatStore'
import { useCharacterStore } from '../../store/useCharacterStore'
import { charAssetUrl } from '../../utils/asset'
import { useSettingsStore } from '../../store/useSettingsStore'
import { usePersonaStore } from '../../store/usePersonaStore'
import { Dropdown } from '../common/Dropdown'
import { SessionSwitcher } from '../common/SessionSwitcher'
import { CharacterAvatar } from '../character/CharacterAvatar'
import { getDisplayName } from '../../../shared/chat-core/variables'
import { MemoryPanel } from './MemoryPanel'
import { TokenUsage } from './TokenUsage'
import { NarrativeModeSwitcher } from './NarrativeModeSwitcher'
import { WorldStatePanel } from './WorldStatePanel'
import { cn } from '../../lib/utils'
import type { Character } from '../../../shared/types'
import { resolveNarrativeMode } from '../../../shared/narrativeMode'
import { syncPersonaToSettings } from '../../store/chatUtils'

interface ChatHeaderProps {
  currentCharacter: Character
  isStreaming: boolean
  totalChars: number
  showQuickSettings: boolean
  onShowQuickSettings: () => void
  onCreateSession: () => void
  showSpatialBoard: boolean
  onShowSpatialBoard: () => void
}

export function ChatHeader({
  currentCharacter,
  isStreaming,
  totalChars,
  showQuickSettings,
  onShowQuickSettings,
  onCreateSession,
  showSpatialBoard,
  onShowSpatialBoard,
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
  const updateSessionField = useChatStore((s) => s.updateSessionField)
  const triggerMemorySummary = useChatStore((s) => s.triggerMemorySummary)
  const summarizingMemoryKey = useChatStore((s) => s.summarizingMemoryKey)
  const memorySummaryError = useChatStore((s) => s.memorySummaryError)
  const getStats = useChatStore((s) => s.getStats)
  const characters = useCharacterStore((s) => s.characters)
  const selectCharacter = useCharacterStore((s) => s.selectCharacter)
  const settings = useSettingsStore((s) => s.settings)
  const personas = usePersonaStore((s) => s.personas)
  const getPersona = usePersonaStore((s) => s.getPersona)

  const [showCharMenu, setShowCharMenu] = useState(false)
  const [showPersonaMenu, setShowPersonaMenu] = useState(false)
  const [showMemoryPanel, setShowMemoryPanel] = useState(false)
  const [showWorldStatePanel, setShowWorldStatePanel] = useState(false)
  const [memoryStats, setMemoryStats] = useState<{ totalMessages: number; totalChars: number; durationStr: string } | null>(null)
  const [memoryInterval, setMemoryInterval] = useState(10)
  const currentSession = sessions.find((session) => session.id === currentSessionId)
  const narrativeMode = resolveNarrativeMode(currentSession?.narrativeMode)

  // 切换当前会话的身份
  const handleSwitchPersona = async (personaId: string | null) => {
    if (!currentCharacter || !currentSessionId) return
    await window.api.chat.updateSession(currentCharacter.id, currentSessionId, { personaId })
    useChatStore.setState(s => ({
      sessions: s.sessions.map(sess =>
        sess.id === currentSessionId ? { ...sess, personaId } : sess
      ),
    }))
    syncPersonaToSettings(personaId)
    setShowPersonaMenu(false)
  }

  return (
    <header className="relative z-30 flex h-[72px] shrink-0 items-center justify-center bg-transparent px-3">
      {/* 新样式：会话控件收进居中悬浮圆角工具条（设计稿见 work/frameless-window-preview.html） */}
      <div className="session-toolbar relative flex min-w-0 max-w-full items-center gap-2 rounded-[14px] border border-tavern-border px-2 py-1.5">
        <span className="session-toolbar__backdrop" aria-hidden="true" />
        <div className="relative flex min-w-0 items-center gap-3">
        {/* 角色选择下拉 */}
        <Dropdown
          open={showCharMenu}
          onOpenChange={setShowCharMenu}
          panelClassName="w-64 max-h-80 overflow-y-auto"
          trigger={
            <button className="session-control session-control--identity min-w-0 transition-colors">
              <CharacterAvatar
                avatar={currentCharacter.avatar || charAssetUrl(currentCharacter.id, 'avatar', currentCharacter.updatedAt)}
                name={getDisplayName(currentCharacter)}
                size="md"
                fallbackClassName="bg-tavern-assistant/20 text-tavern-assistant"
              />
              <div className="min-w-0 text-left">
                <div className="max-w-[8.5rem] truncate text-sm font-medium text-tavern-text">{getDisplayName(currentCharacter)}</div>
                <div className="whitespace-nowrap text-xs text-tavern-text-muted">
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
        <span className="mx-1 h-4 w-px bg-tavern-border" aria-hidden="true" />
        <Dropdown
          open={showPersonaMenu}
          onOpenChange={setShowPersonaMenu}
          panelClassName="w-48 max-h-60 overflow-y-auto"
          trigger={
            <button
              className="session-control"
              title={narrativeMode === 'omniscient' ? `旁白（身份：${(() => {
                const s = sessions.find(s => s.id === currentSessionId)
                return getPersona(s?.personaId)?.name ?? '未使用身份'
              })()}）` : '切换身份'}
            >
              {(() => {
                // 全局叙事下我方以“旁白”身份参与，头部显示旁白标识而非所选身份
                if (narrativeMode === 'omniscient') {
                  return (
                    <span className="session-control__avatar grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-full text-indigo-500 dark:text-indigo-300">
                      <Globe2 aria-label="旁白" />
                    </span>
                  )
                }
                const session = sessions.find(s => s.id === currentSessionId)
                const persona = getPersona(session?.personaId)
                return (
                  <span className="session-control__avatar grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-full text-tavern-text-muted">
                    {persona?.avatar
                      ? <img src={persona.avatar} alt="" className="h-full w-full object-cover" />
                      : <UserCircle />}
                  </span>
                )
              })()}
              <span className="max-w-[80px] truncate text-sm font-medium text-tavern-text-soft">
                {(() => {
                  if (narrativeMode === 'omniscient') return '旁白'
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

        {/* 会话级叙事模式：紧邻身份切换，便于在对话中即时调整视角 */}
        <NarrativeModeSwitcher
          characterId={currentCharacter.id}
          isStreaming={isStreaming}
        />

        {narrativeMode === 'omniscient' && (
          <WorldStatePanel
            open={showWorldStatePanel}
            onToggle={() => {
              setShowMemoryPanel(false)
              setShowWorldStatePanel((value) => !value)
            }}
            session={currentSession}
            onSaveWorldState={(value) => {
              if (!currentSessionId) return Promise.resolve()
              return updateSessionField(currentCharacter.id, currentSessionId, 'memoryCurrentState', value)
            }}
            isStreaming={isStreaming}
          />
        )}

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
              className="session-control session-control--icon"
              title="新建会话"
            >
              <Plus className="w-4 h-4" />
            </button>
            <MemoryPanel
              open={showMemoryPanel}
              onToggle={async () => {
                setShowWorldStatePanel(false)
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
              onTriggerSummary={() =>
                (currentCharacter ? triggerMemorySummary(currentCharacter) : Promise.resolve(null))
              }
              summaryError={memorySummaryError
                && currentCharacter && currentSessionId
                && memorySummaryError.key === `${currentCharacter.id}:${currentSessionId}`
                ? memorySummaryError.message
                : null}
              isSummarizing={Boolean(
                currentCharacter && currentSessionId
                && summarizingMemoryKey === `${currentCharacter.id}:${currentSessionId}`
              )}
              isStreaming={isStreaming}
              memoryStats={memoryStats}
            />
          </>}
        />
      </div>

      <span className="relative mx-0.5 h-4 w-px shrink-0 bg-tavern-border" aria-hidden="true" />

        {/* 当前会话画板与快捷设置 */}
        <div className="relative flex shrink-0 items-center gap-1">
          <span className="session-token mr-1 hidden lg:inline"><TokenUsage chars={totalChars} /></span>
          <button
            type="button"
            aria-label={showSpatialBoard ? '返回对话' : '打开空间画板'}
            aria-pressed={showSpatialBoard}
            onClick={onShowSpatialBoard}
            disabled={!currentSessionId}
            className={cn(
              'session-control session-control--icon',
              currentSession?.spatialBoardEnabled === true && 'session-control--accent',
            )}
            title={currentSessionId ? '当前会话的空间画板' : '先创建会话'}
          >
            <Compass className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="快捷设置"
            aria-expanded={showQuickSettings}
            onClick={onShowQuickSettings}
            className={cn(
              'session-control session-control--icon',
              showQuickSettings && 'session-control--accent',
            )}
            title="快捷设置"
          >
            <Sliders className="w-5 h-5" />
          </button>
        </div>
      </div>
    </header>
  )
}
