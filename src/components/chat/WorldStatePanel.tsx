import { useEffect, useMemo, useState } from 'react'
import { Check, Database, Globe2, ListChecks, Save, X } from 'lucide-react'
import type { MemoryFact, MemoryFactRecord } from '../../../shared/types'
import { cn } from '../../lib/utils'
import { isMemoryFact, memoryFactToText } from '../../utils/memory'

interface WorldStateSession {
  id: string
  memoryEnabled?: boolean
  memoryCurrentState?: string
  memoryFacts?: MemoryFactRecord[]
  gameMasterMode?: boolean
}

interface WorldStatePanelProps {
  open: boolean
  onToggle: () => void
  session?: WorldStateSession
  onSaveWorldState: (value: string) => void | Promise<void>
  onSetGameMasterMode: (enabled: boolean) => void | Promise<void>
  isStreaming: boolean
}

/** 全局叙事专属的轻量控制台：复用长记忆状态，不创建第二份世界数据源。 */
export function WorldStatePanel({
  open,
  onToggle,
  session,
  onSaveWorldState,
  onSetGameMasterMode,
  isStreaming,
}: WorldStatePanelProps) {
  const [draft, setDraft] = useState(session?.memoryCurrentState ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const gameMasterMode = session?.gameMasterMode ?? false

  useEffect(() => {
    setDraft(session?.memoryCurrentState ?? '')
    setError(null)
  }, [session?.id, session?.memoryCurrentState])

  useEffect(() => {
    if (!open) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onToggle()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onToggle, open])

  const activeFacts = useMemo(() => (session?.memoryFacts ?? [])
    .filter((fact) => !isMemoryFact(fact) || fact.status === 'active')
    .slice(0, 6), [session?.memoryFacts])

  const saveState = async () => {
    if (!session) return
    setSaving(true)
    setError(null)
    try {
      await onSaveWorldState(draft.trim())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '世界状态保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        aria-label="世界状态"
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn(
          'relative flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors',
          open || draft
            ? 'border-tavern-accent/30 bg-tavern-accent-soft text-tavern-accent'
            : 'border-tavern-border-soft bg-tavern-bg-card/70 text-tavern-text-muted hover:border-tavern-accent/30 hover:text-tavern-accent',
        )}
        title="世界状态与游戏主持设置"
      >
        <Globe2 className="h-3.5 w-3.5" />
        <span className="hidden xl:inline">世界状态</span>
        {gameMasterMode && <span className="h-1.5 w-1.5 rounded-full bg-tavern-accent" aria-label="游戏主持已开启" />}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10 bg-black/10" onClick={onToggle} aria-hidden="true" />
          <div
            role="dialog"
            aria-label="世界状态"
            className="absolute left-0 top-full z-20 mt-2 flex max-h-[calc(100vh-5rem)] w-[min(26rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-2xl border border-tavern-border bg-tavern-bg-card text-sm shadow-2xl"
          >
            <div className="flex items-start justify-between gap-3 border-b border-tavern-border-soft bg-gradient-to-r from-tavern-accent-soft/80 to-transparent px-4 py-3.5">
              <div className="flex items-center gap-3">
                <div className="grid h-9 w-9 place-items-center rounded-xl border border-tavern-accent/25 bg-tavern-bg-card text-tavern-accent shadow-sm">
                  <Globe2 className="h-4.5 w-4.5" />
                </div>
                <div>
                  <h4 className="font-display font-semibold text-tavern-text">世界状态</h4>
                  <p className="mt-0.5 text-xs text-tavern-text-muted">供旁白持续追踪场景、势力与因果</p>
                </div>
              </div>
              <button type="button" onClick={onToggle} className="rounded-lg p-1.5 text-tavern-text-muted hover:bg-tavern-bg-hover hover:text-tavern-text" aria-label="关闭世界状态">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="overflow-y-auto p-4">
              <section>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <label htmlFor="world-state-editor" className="flex items-center gap-1.5 text-xs font-medium text-tavern-text-soft">
                    <Database className="h-3.5 w-3.5 text-tavern-accent" />当前局势
                  </label>
                  <span className="text-[10px] tabular-nums text-tavern-text-muted">{draft.length}/6000</span>
                </div>
                <textarea
                  id="world-state-editor"
                  value={draft}
                  maxLength={6000}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="例：地点与时间、各势力动向、未解决危机、正在推进的事件……"
                  className="min-h-32 w-full resize-y rounded-xl border border-tavern-border-soft bg-tavern-bg/60 px-3 py-2.5 text-xs leading-relaxed text-tavern-text outline-none transition-colors placeholder:text-tavern-text-muted/60 focus:border-tavern-accent"
                />
                {!session?.memoryEnabled && (
                  <p className="mt-2 rounded-lg border border-tavern-warning/20 bg-tavern-warning/10 px-2.5 py-2 text-[11px] leading-relaxed text-tavern-text-muted">
                    状态可以保存；开启长记忆后，它才会持续注入 AI 上下文并由摘要自动更新。
                  </p>
                )}
                {error && <p className="mt-2 text-xs text-tavern-danger">{error}</p>}
                <button
                  type="button"
                  onClick={() => void saveState()}
                  disabled={!session || saving || isStreaming || draft.trim() === (session.memoryCurrentState ?? '').trim()}
                  className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-xl bg-tavern-accent px-3 py-2.5 text-xs font-medium text-white shadow-sm transition-all hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {saving ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Save className="h-3.5 w-3.5" />}
                  {saving ? '保存中…' : '保存世界状态'}
                </button>
              </section>

              <section className="mt-4 rounded-xl border border-tavern-border-soft bg-tavern-bg/50 p-3">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="flex items-center gap-1.5 font-medium text-tavern-text"><ListChecks className="h-3.5 w-3.5 text-tavern-accent" />游戏主持格式</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-tavern-text-muted">需要判定时显示依据与结果，并在决策点给出行动选项</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-label="游戏主持格式"
                    aria-checked={gameMasterMode}
                    disabled={!session || isStreaming}
                    onClick={() => void onSetGameMasterMode(!gameMasterMode)}
                    className={cn('relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-40', gameMasterMode ? 'bg-tavern-accent' : 'bg-tavern-bg-hover')}
                  >
                    <span className={cn('inline-flex h-5 w-5 items-center justify-center rounded-full bg-white text-tavern-accent shadow-sm transition-transform', gameMasterMode ? 'translate-x-5' : 'translate-x-0.5')}>
                      {gameMasterMode && <Check className="h-3 w-3" />}
                    </span>
                  </button>
                </div>
              </section>

              <section className="mt-4">
                <div className="mb-2 flex items-center justify-between gap-3 text-xs font-medium text-tavern-text-soft">
                  <span>活跃事实</span>
                  <span className="text-[10px] font-normal text-tavern-text-muted">{activeFacts.length > 0 ? `显示前 ${activeFacts.length} 条` : '暂无'}</span>
                </div>
                {activeFacts.length > 0 ? (
                  <div className="space-y-1.5">
                    {activeFacts.map((fact, index) => (
                      <div key={isMemoryFact(fact) ? fact.id : `${index}-${fact}`} className="rounded-lg border border-tavern-border-soft bg-tavern-bg-hover/50 px-2.5 py-2 text-[11px] leading-relaxed text-tavern-text-muted">
                        {isMemoryFact(fact) ? memoryFactToText(fact as MemoryFact) : fact}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="rounded-lg border border-dashed border-tavern-border-soft px-3 py-4 text-center text-[11px] text-tavern-text-muted">长记忆总结后，关键事实会显示在这里。</p>
                )}
              </section>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
