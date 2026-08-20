import { useMemo, useState } from 'react'
import { Brain, History, Search } from 'lucide-react'
import { cn } from '../../lib/utils'
import { memoryFactToText } from '../../utils/memory'
import type { MemoryFact, MemoryFactRecord } from '../../../shared/types'

interface Session {
  id: string
  memoryEnabled?: boolean
  memoryMode?: 'manual' | 'auto'
  autoMemoryInterval?: number
  memory?: string
  memoryFacts?: MemoryFactRecord[]
  memoryFactHistory?: MemoryFact[]
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
  const [historySearch, setHistorySearch] = useState('')
  const [historyFilter, setHistoryFilter] = useState<'all' | 'inactive' | 'superseded'>('all')
  const [showHistory, setShowHistory] = useState(false)

  const filteredHistory = useMemo(() => {
    const list = currentSession?.memoryFactHistory ?? []
    const q = historySearch.trim().toLowerCase()
    return list.filter((h) => {
      if (historyFilter !== 'all' && h.status !== historyFilter) return false
      if (!q) return true
      const text = `${h.subject} ${h.predicate} ${h.value}`.toLowerCase()
      return text.includes(q)
    })
  }, [currentSession?.memoryFactHistory, historySearch, historyFilter])

  const groupedHistory = useMemo(() => {
    const groups: Record<string, MemoryFact[]> = { inactive: [], superseded: [] }
    for (const h of filteredHistory) {
      const k = h.status === 'superseded' ? 'superseded' : 'inactive'
      groups[k].push(h)
    }
    return groups
  }, [filteredHistory])

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

            {currentSession?.memoryFacts && currentSession.memoryFacts.length > 0 && (
              <div className="mt-2 p-2 rounded bg-tavern-bg-hover text-xs text-tavern-text-muted max-h-24 overflow-y-auto space-y-0.5">
                <div className="text-tavern-text-soft font-medium">关键事实（{currentSession.memoryFacts.length}）：</div>
                {currentSession.memoryFacts.slice(0, 8).map((f, i) => (
                  <div key={typeof f === 'string' ? `${i}-${f}` : f.id} className="truncate">• {memoryFactToText(f)}</div>
                ))}
                {currentSession.memoryFacts.length > 8 && (
                  <div className="text-tavern-text-muted/60">…共 {currentSession.memoryFacts.length} 条</div>
                )}
              </div>
            )}

            {/* 历史归档（只读，不参与注入） */}
            {currentSession?.memoryFactHistory !== undefined && (
              <div className="mt-2 rounded bg-tavern-bg-hover text-xs">
                <button
                  onClick={() => setShowHistory(!showHistory)}
                  className="w-full flex items-center justify-between p-2 text-tavern-text-soft hover:text-tavern-text font-medium"
                >
                  <span className="flex items-center gap-1.5"><History className="w-3.5 h-3.5" />历史归档（{currentSession.memoryFactHistory.length}）</span>
                  <span className="text-tavern-text-muted">{showHistory ? '收起' : '展开'}</span>
                </button>
                {showHistory && (
                  <div className="px-2 pb-2 space-y-2">
                    <div className="flex gap-1.5">
                      <div className="flex-1 relative">
                        <Search className="absolute left-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-tavern-text-muted" />
                        <input
                          value={historySearch}
                          onChange={(e) => setHistorySearch(e.target.value)}
                          placeholder="搜索 主体/属性/值"
                          className="w-full pl-6 pr-2 py-1 rounded bg-tavern-bg-card border border-tavern-border text-xs"
                        />
                      </div>
                      <select
                        value={historyFilter}
                        onChange={(e) => setHistoryFilter(e.target.value as typeof historyFilter)}
                        className="input text-xs py-1 px-1.5"
                      >
                        <option value="all">全部</option>
                        <option value="inactive">inactive</option>
                        <option value="superseded">superseded</option>
                      </select>
                    </div>
                    {filteredHistory.length === 0 ? (
                      <div className="text-tavern-text-muted text-center py-2">无匹配历史</div>
                    ) : (
                      <div className="max-h-36 overflow-y-auto space-y-2 pr-0.5">
                        {(historyFilter === 'all' || historyFilter === 'superseded') && groupedHistory.superseded.length > 0 && (
                          <div>
                            <div className="text-[10px] tracking-wide text-tavern-text-muted mb-1">SUPERSEDED · 已替代（{groupedHistory.superseded.length}）</div>
                            <div className="space-y-1">
                              {groupedHistory.superseded.slice(0, 20).map((h) => (
                                <div key={h.id} className="p-1.5 rounded bg-tavern-bg-card border border-tavern-border-soft">
                                  <div className="truncate text-tavern-text-soft">{h.subject}的{h.predicate}：{h.value}</div>
                                  <div className="flex items-center gap-1.5 text-[10px] text-tavern-text-muted mt-0.5">
                                    <span className="px-1 py-0.5 rounded bg-amber-500/15 text-amber-600">superseded</span>
                                    <span>★{h.importance}</span>
                                    <span>{new Date(h.updatedAt).toLocaleDateString()}</span>
                                    {h.sourceMessageIds?.length ? <span>源:{h.sourceMessageIds.length}</span> : null}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {(historyFilter === 'all' || historyFilter === 'inactive') && groupedHistory.inactive.length > 0 && (
                          <div>
                            <div className="text-[10px] tracking-wide text-tavern-text-muted mb-1">INACTIVE · 已失效（{groupedHistory.inactive.length}）</div>
                            <div className="space-y-1">
                              {groupedHistory.inactive.slice(0, 20).map((h) => (
                                <div key={h.id} className="p-1.5 rounded bg-tavern-bg-card border border-tavern-border-soft opacity-80">
                                  <div className="truncate text-tavern-text-soft">{h.subject}的{h.predicate}：{h.value}</div>
                                  <div className="flex items-center gap-1.5 text-[10px] text-tavern-text-muted mt-0.5">
                                    <span className="px-1 py-0.5 rounded bg-zinc-500/15 text-zinc-500">inactive</span>
                                    <span>★{h.importance}</span>
                                    <span>{new Date(h.updatedAt).toLocaleDateString()}</span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {filteredHistory.length > 20 && <div className="text-[10px] text-tavern-text-muted text-center">…仅展示前 20 条，共 {filteredHistory.length} 条</div>}
                      </div>
                    )}
                  </div>
                )}
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
