import { useEffect, useMemo, useState } from 'react'
import {
  Brain,
  Check,
  ChevronDown,
  Clock3,
  Database,
  History,
  Loader2,
  MessageSquareText,
  Pencil,
  Play,
  Plus,
  Search,
  Save,
  Type,
  X,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { isMemoryFact, memoryFactToText } from '../../utils/memory'
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
  onUpdateMemoryFacts: (facts: MemoryFactRecord[]) => void | Promise<void>
  /** 返回本次总结产出的摘要文本；显式 null 表示未产出可写入内容（调用方据此给出反馈） */
  onTriggerSummary: () => void | Promise<string | null>
  /** 最近一次总结的失败原因（store 通道，按会话 key 过滤后传入）；总结按钮下方的可见反馈 */
  summaryError?: string | null
  isStreaming: boolean
  /** 长记忆总结进行中：按钮显示加载态并禁用 */
  isSummarizing?: boolean
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
  onUpdateMemoryFacts,
  onTriggerSummary,
  summaryError = null,
  isStreaming,
  isSummarizing = false,
  memoryStats,
}: MemoryPanelProps) {
  const currentSession = sessions.find(s => s.id === currentSessionId)
  const [historySearch, setHistorySearch] = useState('')
  const [historyFilter, setHistoryFilter] = useState<'all' | 'inactive' | 'superseded'>('all')
  const [showHistory, setShowHistory] = useState(false)
  const [isAddingFact, setIsAddingFact] = useState(false)
  const [newFact, setNewFact] = useState('')
  const [factEditor, setFactEditor] = useState<
    | { index: number; kind: 'text'; text: string }
    | { index: number; kind: 'structured'; subject: string; predicate: string; value: string }
    | null
  >(null)
  const [factSaving, setFactSaving] = useState(false)
  const [factError, setFactError] = useState<string | null>(null)
  const hasSession = Boolean(currentCharacterId && currentSessionId && currentSession)
  const memoryEnabled = currentSession?.memoryEnabled ?? false
  const memoryMode = currentSession?.memoryMode ?? 'manual'

  useEffect(() => {
    if (!open) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onToggle()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onToggle, open])

  useEffect(() => {
    setIsAddingFact(false)
    setNewFact('')
    setFactEditor(null)
    setFactError(null)
  }, [currentSessionId])

  const persistFacts = async (facts: MemoryFactRecord[]): Promise<boolean> => {
    setFactSaving(true)
    setFactError(null)
    try {
      await onUpdateMemoryFacts(facts)
      return true
    } catch (error) {
      setFactError(error instanceof Error ? error.message : '保存失败，请重试')
      return false
    } finally {
      setFactSaving(false)
    }
  }

  const handleAddFact = async () => {
    const value = newFact.trim()
    if (!value || !currentSession) return
    const saved = await persistFacts([...(currentSession.memoryFacts ?? []), value])
    if (saved) {
      setNewFact('')
      setIsAddingFact(false)
    }
  }

  const beginEditFact = (fact: MemoryFactRecord, index: number) => {
    setFactError(null)
    setIsAddingFact(false)
    if (isMemoryFact(fact)) {
      setFactEditor({
        index,
        kind: 'structured',
        subject: fact.subject,
        predicate: fact.predicate,
        value: fact.value,
      })
    } else {
      setFactEditor({ index, kind: 'text', text: fact })
    }
  }

  const handleSaveFact = async () => {
    if (!currentSession || !factEditor) return
    const facts = [...(currentSession.memoryFacts ?? [])]
    const original = facts[factEditor.index]
    if (original === undefined) return

    if (factEditor.kind === 'text') {
      const value = factEditor.text.trim()
      if (!value) {
        setFactError('关键事实不能为空')
        return
      }
      facts[factEditor.index] = value
    } else {
      const subject = factEditor.subject.trim()
      const predicate = factEditor.predicate.trim()
      const value = factEditor.value.trim()
      if (!subject || !predicate || !value) {
        setFactError('主体、属性和内容都不能为空')
        return
      }
      if (!isMemoryFact(original)) return
      facts[factEditor.index] = { ...original, subject, predicate, value, updatedAt: Date.now() }
    }

    if (await persistFacts(facts)) setFactEditor(null)
  }

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
        type="button"
        onClick={onToggle}
        aria-label="长记忆设置"
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn(
          'relative p-1.5 rounded-lg hover:bg-tavern-bg-hover transition-colors',
          memoryEnabled ? 'text-tavern-accent' : 'text-tavern-text-muted hover:text-tavern-accent',
          open && 'text-tavern-accent bg-tavern-bg-hover'
        )}
        title={memoryEnabled ? '长记忆（已开启）' : '长记忆'}
      >
        <Brain className="w-4 h-4" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10 bg-black/5" onClick={onToggle} aria-hidden="true" />
          <div
            role="dialog"
            aria-label="长记忆设置"
            className="absolute top-full right-0 z-20 mt-2 flex max-h-[calc(100vh-5rem)] w-[min(26rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-2xl border border-tavern-border bg-tavern-bg-card text-sm shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4 border-b border-tavern-border-soft px-4 py-3.5">
              <div className="flex min-w-0 items-center gap-3">
                <div className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border',
                  memoryEnabled
                    ? 'border-tavern-accent/25 bg-tavern-accent-soft text-tavern-accent'
                    : 'border-tavern-border-soft bg-tavern-bg-hover text-tavern-text-muted'
                )}>
                  <Brain className="h-4.5 w-4.5" />
                </div>
                <div className="min-w-0">
                  <h4 className="font-display font-semibold text-tavern-text">长记忆</h4>
                  <p className="mt-0.5 truncate text-xs text-tavern-text-muted">
                    {!hasSession ? '请先选择一个会话' : memoryEnabled ? (memoryMode === 'auto' ? `自动 · 每 ${memoryInterval} 条总结` : '手动总结') : '当前会话未启用'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onToggle}
                className="-mr-1 rounded-lg p-1.5 text-tavern-text-muted transition-colors hover:bg-tavern-bg-hover hover:text-tavern-text"
                aria-label="关闭长记忆设置"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="overflow-y-auto px-4 py-4">
              <section className="rounded-xl border border-tavern-border-soft bg-tavern-bg/50 p-3">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="font-medium text-tavern-text">启用长记忆</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-tavern-text-muted">将摘要和关键事实持续注入后续对话</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-label="启用长记忆"
                    aria-checked={memoryEnabled}
                    disabled={!hasSession}
                    onClick={() => onToggleMemory(!memoryEnabled)}
                    className={cn(
                      'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                      memoryEnabled ? 'bg-tavern-accent' : 'bg-tavern-bg-hover'
                    )}
                  >
                    <span className={cn(
                      'inline-flex h-5 w-5 items-center justify-center rounded-full bg-white text-tavern-accent shadow-sm transition-transform',
                      memoryEnabled ? 'translate-x-5' : 'translate-x-0.5'
                    )}>
                      {memoryEnabled && <Check className="h-3 w-3" />}
                    </span>
                  </button>
                </div>

                <div className={cn('mt-3 border-t border-tavern-border-soft pt-3 transition-opacity', !memoryEnabled && 'pointer-events-none opacity-45')}>
                  <p className="mb-2 text-xs font-medium text-tavern-text-soft">总结方式</p>
                  <div className="grid grid-cols-2 gap-1 rounded-lg bg-tavern-bg-hover p-1">
                    {([
                      { value: 'manual' as const, label: '手动', desc: '需要时总结' },
                      { value: 'auto' as const, label: '自动', desc: '按消息间隔' },
                    ]).map((option) => (
                      <button
                        type="button"
                        key={option.value}
                        aria-pressed={memoryMode === option.value}
                        onClick={() => onSetMemoryMode(option.value, memoryInterval)}
                        className={cn(
                          'rounded-md px-2 py-2 text-left transition-colors',
                          memoryMode === option.value
                            ? 'bg-tavern-bg-card text-tavern-text shadow-sm ring-1 ring-tavern-border-soft'
                            : 'text-tavern-text-muted hover:text-tavern-text-soft'
                        )}
                      >
                        <span className="block text-xs font-medium">{option.label}</span>
                        <span className="mt-0.5 block text-[10px]">{option.desc}</span>
                      </button>
                    ))}
                  </div>

                  {memoryMode === 'auto' && (
                    <div className="mt-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-xs font-medium text-tavern-text-soft">自动总结间隔</p>
                        <label className="flex items-center gap-1.5 text-xs text-tavern-text-muted">
                          每
                          <input
                            aria-label="自动总结间隔"
                            type="number"
                            value={memoryInterval}
                            min={4}
                            max={50}
                            onChange={(e) => {
                              const v = Math.max(4, Math.min(50, parseInt(e.target.value) || 10))
                              onMemoryIntervalChange(v)
                              onSetMemoryMode('auto', v)
                            }}
                            className="input w-14 px-2 py-1 text-center text-xs"
                          />
                          条
                        </label>
                      </div>
                      <div className="mt-2 grid grid-cols-4 gap-1.5">
                        {[6, 10, 20, 30].map((value) => (
                          <button
                            type="button"
                            key={value}
                            onClick={() => {
                              onMemoryIntervalChange(value)
                              onSetMemoryMode('auto', value)
                            }}
                            className={cn(
                              'rounded-md border px-2 py-1 text-[11px] transition-colors',
                              memoryInterval === value
                                ? 'border-tavern-accent/40 bg-tavern-accent-soft text-tavern-accent'
                                : 'border-tavern-border-soft text-tavern-text-muted hover:border-tavern-border hover:text-tavern-text-soft'
                            )}
                          >
                            {value} 条
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </section>

              <button
                type="button"
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-tavern-accent px-3 py-2.5 text-xs font-medium text-white shadow-sm transition-all hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
                onClick={() => { void onTriggerSummary() }}
                disabled={!hasSession || !memoryEnabled || isStreaming || isSummarizing}
                aria-busy={isSummarizing || undefined}
              >
                {isSummarizing
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <Play className="h-3.5 w-3.5 fill-current" />}
                {isSummarizing ? '正在总结…' : isStreaming ? '回复完成后可总结' : '立即总结当前对话'}
              </button>

              {summaryError && (
                <p role="alert" className="mt-2 text-[11px] text-tavern-danger">{summaryError}</p>
              )}

              {memoryStats && (
                <section aria-label="对话统计" className="mt-4 grid grid-cols-3 divide-x divide-tavern-border-soft rounded-xl border border-tavern-border-soft py-2.5">
                  {[
                    { icon: MessageSquareText, label: '消息', value: memoryStats.totalMessages.toLocaleString() },
                    { icon: Type, label: '文字', value: memoryStats.totalChars.toLocaleString() },
                    { icon: Clock3, label: '时长', value: memoryStats.durationStr },
                  ].map(({ icon: Icon, label, value }) => (
                    <div key={label} className="min-w-0 px-2 text-center">
                      <Icon className="mx-auto mb-1 h-3.5 w-3.5 text-tavern-text-muted" />
                      <div className="truncate text-xs font-medium text-tavern-text-soft" title={value}>{value}</div>
                      <div className="mt-0.5 text-[10px] text-tavern-text-muted">{label}</div>
                    </div>
                  ))}
                </section>
              )}

              {currentSession?.memory && (
                <section className="mt-4">
                  <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-tavern-text-soft">
                    <MessageSquareText className="h-3.5 w-3.5 text-tavern-accent" />
                    当前摘要
                  </div>
                  <div className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-xl border border-tavern-border-soft bg-tavern-bg-hover/60 p-3 text-xs leading-relaxed text-tavern-text-muted">
                    {currentSession.memory}
                  </div>
                </section>
              )}

              {hasSession && (
                <section className="mt-4">
                  <div className="mb-1.5 flex items-center justify-between gap-3 text-xs font-medium text-tavern-text-soft">
                    <span className="flex items-center gap-1.5">
                      <Database className="h-3.5 w-3.5 text-tavern-accent" />
                      关键事实
                      <span className="font-normal text-tavern-text-muted">{currentSession?.memoryFacts?.length ?? 0}</span>
                    </span>
                    <button
                      type="button"
                      aria-label="添加关键事实"
                      disabled={isStreaming || factSaving}
                      title={isStreaming ? '回复完成后可编辑事实' : '添加关键事实'}
                      onClick={() => {
                        setFactEditor(null)
                        setFactError(null)
                        setIsAddingFact(true)
                      }}
                      className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-tavern-accent transition-colors hover:bg-tavern-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      添加
                    </button>
                  </div>

                  <div className="max-h-64 space-y-1 overflow-y-auto rounded-xl border border-tavern-border-soft p-2">
                    {isAddingFact && (
                      <form
                        onSubmit={(event) => {
                          event.preventDefault()
                          void handleAddFact()
                        }}
                        className="mb-2 rounded-lg border border-tavern-accent/30 bg-tavern-accent-soft/40 p-2"
                      >
                        <label className="mb-1 block text-[10px] font-medium text-tavern-text-soft">新增事实</label>
                        <textarea
                          autoFocus
                          aria-label="新增关键事实"
                          value={newFact}
                          onChange={(event) => setNewFact(event.target.value)}
                          placeholder="例如：用户害怕密闭空间"
                          rows={2}
                          className="input w-full resize-none px-2 py-1.5 text-xs leading-relaxed"
                        />
                        <div className="mt-2 flex justify-end gap-1.5">
                          <button
                            type="button"
                            aria-label="取消添加"
                            onClick={() => {
                              setIsAddingFact(false)
                              setNewFact('')
                              setFactError(null)
                            }}
                            className="rounded-md px-2 py-1 text-[11px] text-tavern-text-muted hover:bg-tavern-bg-hover hover:text-tavern-text"
                          >
                            取消
                          </button>
                          <button
                            type="submit"
                            aria-label="保存事实"
                            disabled={!newFact.trim() || factSaving}
                            className="inline-flex items-center gap-1 rounded-md bg-tavern-accent px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-40"
                          >
                            <Save className="h-3 w-3" />
                            {factSaving ? '保存中' : '保存'}
                          </button>
                        </div>
                      </form>
                    )}

                    {(currentSession?.memoryFacts ?? []).map((fact, index) => {
                      const editing = factEditor?.index === index
                      if (editing && factEditor) {
                        return (
                          <form
                            key={isMemoryFact(fact) ? fact.id : `fact-${index}`}
                            onSubmit={(event) => {
                              event.preventDefault()
                              void handleSaveFact()
                            }}
                            className="rounded-lg border border-tavern-accent/30 bg-tavern-accent-soft/40 p-2"
                          >
                            {factEditor.kind === 'structured' ? (
                              <div className="grid grid-cols-2 gap-1.5">
                                <input
                                  autoFocus
                                  aria-label="事实主体"
                                  value={factEditor.subject}
                                  onChange={(event) => setFactEditor({ ...factEditor, subject: event.target.value })}
                                  placeholder="主体"
                                  className="input px-2 py-1.5 text-xs"
                                />
                                <input
                                  aria-label="事实属性"
                                  value={factEditor.predicate}
                                  onChange={(event) => setFactEditor({ ...factEditor, predicate: event.target.value })}
                                  placeholder="属性"
                                  className="input px-2 py-1.5 text-xs"
                                />
                                <textarea
                                  aria-label="事实内容"
                                  value={factEditor.value}
                                  onChange={(event) => setFactEditor({ ...factEditor, value: event.target.value })}
                                  placeholder="内容"
                                  rows={2}
                                  className="input col-span-2 resize-none px-2 py-1.5 text-xs leading-relaxed"
                                />
                              </div>
                            ) : (
                              <textarea
                                autoFocus
                                aria-label="编辑关键事实"
                                value={factEditor.text}
                                onChange={(event) => setFactEditor({ ...factEditor, text: event.target.value })}
                                rows={2}
                                className="input w-full resize-none px-2 py-1.5 text-xs leading-relaxed"
                              />
                            )}
                            <div className="mt-2 flex justify-end gap-1.5">
                              <button
                                type="button"
                                aria-label="取消修改"
                                onClick={() => {
                                  setFactEditor(null)
                                  setFactError(null)
                                }}
                                className="rounded-md px-2 py-1 text-[11px] text-tavern-text-muted hover:bg-tavern-bg-hover hover:text-tavern-text"
                              >
                                取消
                              </button>
                              <button
                                type="submit"
                                aria-label="保存修改"
                                disabled={factSaving}
                                className="inline-flex items-center gap-1 rounded-md bg-tavern-accent px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-40"
                              >
                                <Save className="h-3 w-3" />
                                {factSaving ? '保存中' : '保存'}
                              </button>
                            </div>
                          </form>
                        )
                      }

                      return (
                        <div key={isMemoryFact(fact) ? fact.id : `fact-${index}`} className="group flex items-start gap-2 rounded-lg px-2 py-1.5 text-xs text-tavern-text-muted hover:bg-tavern-bg-hover">
                          <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-tavern-accent/70" />
                          <span className="min-w-0 flex-1 break-words leading-relaxed">{memoryFactToText(fact)}</span>
                          <button
                            type="button"
                            aria-label={`编辑事实 ${index + 1}`}
                            disabled={isStreaming || factSaving}
                            onClick={() => beginEditFact(fact, index)}
                            className="shrink-0 rounded p-1 text-tavern-text-muted opacity-0 transition-all hover:bg-tavern-bg-card hover:text-tavern-accent focus:opacity-100 disabled:cursor-not-allowed group-hover:opacity-100"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                        </div>
                      )
                    })}

                    {!isAddingFact && (currentSession?.memoryFacts?.length ?? 0) === 0 && (
                      <div className="px-3 py-5 text-center">
                        <Database className="mx-auto h-4 w-4 text-tavern-text-muted/60" />
                        <p className="mt-1.5 text-xs text-tavern-text-soft">暂无关键事实</p>
                        <p className="mt-0.5 text-[10px] text-tavern-text-muted">可手动添加，也会在总结时自动提取</p>
                      </div>
                    )}
                  </div>

                  {factError && (
                    <p role="alert" className="mt-1.5 text-[11px] text-tavern-danger">{factError}</p>
                  )}
                </section>
              )}

              {/* 历史归档（只读，不参与注入） */}
              {currentSession?.memoryFactHistory !== undefined && (
                <div className="mt-4 overflow-hidden rounded-xl border border-tavern-border-soft text-xs">
                <button
                  type="button"
                  onClick={() => setShowHistory(!showHistory)}
                  aria-expanded={showHistory}
                  className="flex w-full items-center justify-between p-3 font-medium text-tavern-text-soft transition-colors hover:bg-tavern-bg-hover hover:text-tavern-text"
                >
                  <span className="flex items-center gap-1.5"><History className="h-3.5 w-3.5" />历史归档 <span className="font-normal text-tavern-text-muted">{currentSession.memoryFactHistory.length}</span></span>
                  <ChevronDown className={cn('h-3.5 w-3.5 text-tavern-text-muted transition-transform', showHistory && 'rotate-180')} />
                </button>
                {showHistory && (
                  <div className="space-y-2 border-t border-tavern-border-soft px-2 pb-2 pt-2">
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
                        <option value="inactive">已失效</option>
                        <option value="superseded">已替代</option>
                      </select>
                    </div>
                    {filteredHistory.length === 0 ? (
                      <div className="text-tavern-text-muted text-center py-2">无匹配历史</div>
                    ) : (
                      <div className="max-h-36 overflow-y-auto space-y-2 pr-0.5">
                        {(historyFilter === 'all' || historyFilter === 'superseded') && groupedHistory.superseded.length > 0 && (
                          <div>
                            <div className="text-[10px] tracking-wide text-tavern-text-muted mb-1">已替代 · {groupedHistory.superseded.length}</div>
                            <div className="space-y-1">
                              {groupedHistory.superseded.slice(0, 20).map((h) => (
                                <div key={h.id} className="p-1.5 rounded bg-tavern-bg-card border border-tavern-border-soft">
                                  <div className="truncate text-tavern-text-soft">{h.subject}的{h.predicate}：{h.value}</div>
                                  <div className="flex items-center gap-1.5 text-[10px] text-tavern-text-muted mt-0.5">
                                    <span className="px-1 py-0.5 rounded bg-amber-500/15 text-amber-600">已替代</span>
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
                            <div className="text-[10px] tracking-wide text-tavern-text-muted mb-1">已失效 · {groupedHistory.inactive.length}</div>
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
            </div>
          </div>
        </>
      )}
    </div>
  )
}
