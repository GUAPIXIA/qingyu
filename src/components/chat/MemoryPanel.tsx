import { Brain } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { Message } from '../../../shared/types'

interface Session {
  id: string
  memoryEnabled?: boolean
  memoryMode?: 'manual' | 'auto'
  autoMemoryInterval?: number
  memory?: string
}

interface MemoryPanelProps {
  open: boolean
  onToggle: () => void
  sessions: Session[]
  currentSessionId: string | null
  currentCharacterId: string | null
  memoryInterval: number
  onMemoryIntervalChange: (v: number) => void
  onToggleMemory: (enabled: boolean) => void
  onSetMemoryMode: (mode: 'manual' | 'auto', interval: number) => void
  onTriggerSummary: () => void
  isStreaming: boolean
  memoryStats: { totalMessages: number; totalChars: number; durationStr: string } | null
}

/**
 * 长记忆设置面板。
 * 从 ChatPage 中抽取，包含长记忆开关、模式选择、间隔设置、总结按钮和统计信息。
 */
export function MemoryPanel({
  open,
  onToggle,
  sessions,
  currentSessionId,
  currentCharacterId,
  memoryInterval,
  onMemoryIntervalChange,
  onToggleMemory,
  onSetMemoryMode,
  onTriggerSummary,
  isStreaming,
  memoryStats,
}: MemoryPanelProps) {
  const currentSession = sessions.find(s => s.id === currentSessionId)

  return (
    <div className="relative">
      <button
        onClick={onToggle}
        className={cn(
          'p-1 rounded-lg text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-bg-hover transition-colors',
          open && 'text-tavern-accent bg-tavern-bg-hover'
        )}
        title="长记忆"
      >
        <Brain className="w-4 h-4" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={onToggle} />
          <div className="absolute top-full right-0 mt-1 w-72 bg-tavern-bg-card border border-tavern-border rounded-xl shadow-xl z-20 py-2 px-3 text-sm">
            <h4 className="font-medium text-tavern-text mb-2">长记忆设置</h4>

            <label className="flex items-center justify-between py-1.5 cursor-pointer">
              <span className="text-tavern-text-soft">启用长记忆</span>
              <input
                type="checkbox"
                checked={currentSession?.memoryEnabled ?? false}
                onChange={(e) => {
                  if (currentCharacterId && currentSessionId) onToggleMemory(e.target.checked)
                }}
                className="toggle"
              />
            </label>

            <div className="flex items-center justify-between py-1.5">
              <span className="text-tavern-text-soft">总结模式</span>
              <select
                value={currentSession?.memoryMode ?? 'manual'}
                onChange={(e) => {
                  if (currentCharacterId && currentSessionId) {
                    onSetMemoryMode(e.target.value as 'manual' | 'auto', memoryInterval)
                  }
                }}
                className="input text-xs py-1 px-2 w-24"
              >
                <option value="manual">手动</option>
                <option value="auto">自动</option>
              </select>
            </div>

            {currentSession?.memoryMode === 'auto' && (
              <div className="flex items-center justify-between py-1.5">
                <span className="text-tavern-text-soft">自动间隔</span>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    value={memoryInterval}
                    min={4}
                    max={50}
                    onChange={(e) => {
                      const v = Math.max(4, Math.min(50, parseInt(e.target.value) || 10))
                      onMemoryIntervalChange(v)
                      if (currentCharacterId && currentSessionId) {
                        onSetMemoryMode('auto', v)
                      }
                    }}
                    className="input text-xs py-1 px-2 w-16 text-center"
                  />
                  <span className="text-xs text-tavern-text-muted">条</span>
                </div>
              </div>
            )}

            <button
              className="btn-secondary w-full mt-2 text-xs"
              onClick={onTriggerSummary}
              disabled={isStreaming}
            >
              立即总结
            </button>

            {currentSession?.memory && (
              <div className="mt-2 p-2 rounded bg-tavern-bg-hover text-xs text-tavern-text-muted max-h-20 overflow-y-auto">
                <span className="text-tavern-text-soft font-medium">当前摘要：</span>
                {currentSession.memory.slice(0, 200)}{currentSession.memory.length > 200 ? '...' : ''}
              </div>
            )}

            {memoryStats && (
              <div className="mt-2 pt-2 border-t border-tavern-border-soft text-xs text-tavern-text-muted space-y-0.5">
                <div className="flex justify-between">
                  <span>总消息数</span>
                  <span className="text-tavern-text-soft">{memoryStats.totalMessages}</span>
                </div>
                <div className="flex justify-between">
                  <span>总文字量</span>
                  <span className="text-tavern-text-soft">{memoryStats.totalChars.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span>对话时长</span>
                  <span className="text-tavern-text-soft">{memoryStats.durationStr}</span>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
