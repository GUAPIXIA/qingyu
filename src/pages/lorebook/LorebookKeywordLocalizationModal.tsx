import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Check, Languages, Loader2, RefreshCw, Sparkles } from 'lucide-react'
import type { Lorebook } from '../../../shared/types'
import type { LorebookKeywordEnrichmentMode, LorebookKeywordLocalizationSuggestion } from '../../../shared/ipc-api'
import type { ActiveProfile } from '../../store/useSettingsStore'
import { Modal } from '../../components/common/Modal'
import { cn } from '../../lib/utils'
import { isEnglishLoreEntry } from '../../utils/lorebookLocalization'

interface LorebookKeywordLocalizationModalProps {
  lorebook: Lorebook
  profile: ActiveProfile | null
  model: string
  /** localize = 英文条目生成中文触发词（默认）；enrich = 通用扩词（全部条目，多语言）。阶段4 enrichment 管线。 */
  mode?: LorebookKeywordEnrichmentMode
  onApply: (suggestions: LorebookKeywordLocalizationSuggestion[]) => Promise<void>
  onClose: () => void
}

type Status = 'generating' | 'ready' | 'error'

const BATCH_SIZE = 10
const MAX_CONCURRENT_BATCHES = 2

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`
}

export function LorebookKeywordLocalizationModal({
  lorebook,
  profile,
  model,
  mode = 'localize',
  onApply,
  onClose,
}: LorebookKeywordLocalizationModalProps) {
  // localize 只处理含英文线索的条目；enrich 处理全部有正文的条目（通用扩词，不限语言方向）。
  const candidates = useMemo(
    () => mode === 'enrich'
      ? lorebook.entries.filter((entry) => entry.content.trim().length > 0)
      : lorebook.entries.filter(isEnglishLoreEntry),
    [lorebook.entries, mode],
  )
  const [status, setStatus] = useState<Status>('generating')
  const [suggestions, setSuggestions] = useState<LorebookKeywordLocalizationSuggestion[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [processed, setProcessed] = useState(0)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const activeRequestIdsRef = useRef<Set<string>>(new Set())
  const cancelledRef = useRef(false)
  const elapsedTimerRef = useRef<number | null>(null)

  const stopElapsedTimer = () => {
    if (elapsedTimerRef.current !== null) window.clearInterval(elapsedTimerRef.current)
    elapsedTimerRef.current = null
  }

  const startElapsedTimer = () => {
    stopElapsedTimer()
    setElapsedSeconds(0)
    const startedAt = Date.now()
    elapsedTimerRef.current = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)
  }

  const abortActiveRequests = () => {
    const requestIds = [...activeRequestIdsRef.current]
    activeRequestIdsRef.current.clear()
    for (const requestId of requestIds) window.api.ai.cancelChat(requestId).catch(() => {})
  }

  const cancelCurrent = () => {
    cancelledRef.current = true
    stopElapsedTimer()
    abortActiveRequests()
  }

  const close = () => {
    cancelCurrent()
    onClose()
  }

  const generate = async () => {
    cancelledRef.current = false
    setStatus('generating')
    setSuggestions([])
    setSelectedIds(new Set())
    setProcessed(0)
    setError('')
    startElapsedTimer()

    if (!profile) {
      setError('请先在“模型”页面选择可用的聊天连接。该功能使用普通聊天模型，不需要语义索引。')
      setStatus('error')
      stopElapsedTimer()
      return
    }
    if (candidates.length === 0) {
      setError(mode === 'enrich'
        ? '这本世界书没有可处理的条目（需要有正文的条目）。'
        : '这本世界书没有检测到需要本地化的英文关键词或英文正文。')
      setStatus('error')
      stopElapsedTimer()
      return
    }

    try {
      const collected: LorebookKeywordLocalizationSuggestion[] = []
      const batches = Array.from(
        { length: Math.ceil(candidates.length / BATCH_SIZE) },
        (_, index) => candidates.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE),
      )
      let nextBatchIndex = 0

      const runWorker = async () => {
        while (!cancelledRef.current) {
          const batchIndex = nextBatchIndex++
          if (batchIndex >= batches.length) return
          const batch = batches[batchIndex]
          const requestId = `lorebook-keywords-${lorebook.id}-${Date.now()}-${batchIndex}`
          activeRequestIdsRef.current.add(requestId)
          let result
          try {
            result = await window.api.ai.localizeLorebookKeywords({
              requestId,
              entries: batch.map((entry) => ({
                id: entry.id,
                keywords: entry.keywords,
                content: entry.content,
              })),
              mode,
              provider: profile.provider,
              apiKey: profile.apiKey,
              baseUrl: profile.baseUrl,
              model: model || profile.model,
            })
          } finally {
            activeRequestIdsRef.current.delete(requestId)
          }
          if (cancelledRef.current || result.cancelled) return
          collected.push(...result.suggestions)
          setSuggestions([...collected])
          setSelectedIds(new Set(collected.map((item) => item.entryId)))
          setProcessed((current) => Math.min(current + batch.length, candidates.length))
        }
      }

      await Promise.all(Array.from(
        { length: Math.min(MAX_CONCURRENT_BATCHES, batches.length) },
        () => runWorker(),
      ))
      stopElapsedTimer()
      if (collected.length === 0) {
        setError(mode === 'enrich'
          ? '模型没有生成可用的新触发词。可以重试，或换用指令遵循能力更强的模型。'
          : '模型没有生成可用的新中文触发词。可以重试，或换用指令遵循能力更强的模型。')
        setStatus('error')
      } else {
        setStatus('ready')
      }
    } catch (e) {
      if (cancelledRef.current) return
      cancelledRef.current = true
      stopElapsedTimer()
      abortActiveRequests()
      setError((e as Error).message || '生成中文触发词失败')
      setStatus('error')
    }
  }

  useEffect(() => {
    // 延后到当前任务结束后启动：StrictMode 的首轮测试性 setup/cleanup
    // 会先清理 timer，第二轮真正挂载再启动，不会误取消唯一请求。
    const timer = window.setTimeout(() => {
      void generate()
    }, 0)
    return () => {
      window.clearTimeout(timer)
      cancelCurrent()
    }
    // 弹窗以当前世界书快照启动一次；重试由按钮显式触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectedSuggestions = suggestions.filter((item) => selectedIds.has(item.entryId))
  const selectedAliasCount = selectedSuggestions.reduce((sum, item) => sum + item.aliases.length, 0)
  const progress = candidates.length > 0 ? Math.round((processed / candidates.length) * 100) : 0

  const handleApply = async () => {
    if (selectedSuggestions.length === 0 || saving) return
    setSaving(true)
    try {
      await onApply(selectedSuggestions)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={close}
      title={mode === 'enrich' ? 'AI 扩词（关键词补充）' : '生成中文触发词'}
      width="custom"
      widthClassName="max-w-4xl"
      contentClassName="bg-tavern-bg-soft/35"
      footer={status === 'ready' ? (
        <>
          <button className="btn-secondary" onClick={close}>取消</button>
          <button className="btn-secondary" onClick={() => void generate()} disabled={saving}>
            <RefreshCw className="h-4 w-4" />重新生成
          </button>
          <button className="btn-primary" onClick={() => void handleApply()} disabled={saving || selectedAliasCount === 0}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            追加 {selectedAliasCount} 个触发词
          </button>
        </>
      ) : status === 'error' ? (
        <>
          <button className="btn-secondary" onClick={close}>关闭</button>
          <button className="btn-primary" onClick={() => void generate()}>
            <RefreshCw className="h-4 w-4" />重试
          </button>
        </>
      ) : (
        <button className="btn-secondary" onClick={close}>取消生成</button>
      )}
    >
      <div className="space-y-4">
        <div className="overflow-hidden rounded-2xl border border-tavern-accent/20 bg-tavern-bg">
          <div className="flex items-start gap-3 px-4 py-3.5">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-tavern-accent-soft text-tavern-accent">
              <Languages className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-tavern-text">{lorebook.name}</h3>
                <span className="rounded-full bg-tavern-bg-soft px-2 py-0.5 text-[10px] text-tavern-text-muted">
                  {mode === 'enrich' ? `共 ${candidates.length} 个条目` : `检测到 ${candidates.length} 个英文条目`}
                </span>
              </div>
              <p className="mt-1 text-xs leading-5 text-tavern-text-muted">
                {mode === 'enrich'
                  ? '模型会从正文提取实体、别名、同义表达与跨语言关键词。新词只会追加到关键词列表，不覆盖原关键词，也不修改正文；生成来源（模型与时间）会记录在条目上以便追溯。'
                  : '中文词只会追加到关键词列表，不覆盖英文原词，也不会修改正文。确认保存后即可直接参与关键词匹配。'}
              </p>
            </div>
          </div>
          {status === 'generating' && (
            <div className="border-t border-tavern-border-soft px-4 py-3">
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="flex items-center gap-2 text-tavern-text-soft">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-tavern-accent" />
                  {mode === 'enrich' ? '正在分批提取触发词' : '正在分批生成中文别名'}
                </span>
                <span className="font-mono text-tavern-text-muted">{processed} / {candidates.length}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-tavern-border-soft">
                <div className="h-full rounded-full bg-tavern-accent transition-all" style={{ width: `${progress}%` }} />
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-1.5 text-[11px] text-tavern-text-muted">
                <span>已用 {formatDuration(elapsedSeconds)}</span>
                <span>最多同时处理 {MAX_CONCURRENT_BATCHES} 批 · 单批超时 60 秒</span>
              </div>
            </div>
          )}
        </div>

        {status === 'error' && (
          <div className="flex items-start gap-2 rounded-xl border border-tavern-danger/25 bg-tavern-danger/10 px-4 py-3 text-sm text-tavern-danger">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {suggestions.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between px-1">
              <div>
                <h3 className="text-sm font-medium text-tavern-text">生成结果</h3>
                <p className="mt-0.5 text-[11px] text-tavern-text-muted">取消勾选可排除不合适的条目。</p>
              </div>
              <button
                type="button"
                className="btn-ghost text-xs"
                onClick={() => setSelectedIds(
                  selectedIds.size === suggestions.length
                    ? new Set()
                    : new Set(suggestions.map((item) => item.entryId)),
                )}
              >
                {selectedIds.size === suggestions.length ? '取消全选' : '全选'}
              </button>
            </div>
            <div className="max-h-[48vh] space-y-2 overflow-y-auto pr-1">
              {suggestions.map((suggestion) => {
                const entry = lorebook.entries.find((item) => item.id === suggestion.entryId)
                const checked = selectedIds.has(suggestion.entryId)
                return (
                  <label
                    key={suggestion.entryId}
                    className={cn(
                      'block cursor-pointer rounded-xl border bg-tavern-bg px-3.5 py-3 transition-colors',
                      checked ? 'border-tavern-accent/35' : 'border-tavern-border-soft opacity-60',
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => setSelectedIds((current) => {
                          const next = new Set(current)
                          if (next.has(suggestion.entryId)) next.delete(suggestion.entryId)
                          else next.add(suggestion.entryId)
                          return next
                        })}
                        className="mt-1 accent-tavern-accent"
                        aria-label={`选择条目 ${suggestion.entryId}`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="line-clamp-1 text-xs text-tavern-text-soft">
                          {entry?.content || entry?.keywords.join(', ') || suggestion.entryId}
                        </div>
                        {suggestion.source && (
                          <div className="mt-1 text-[10px] text-tavern-text-muted">
                            由 {suggestion.source.model || suggestion.source.provider} 生成 · {new Date(suggestion.source.generatedAt).toLocaleString()}
                          </div>
                        )}
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          {(entry?.keywords ?? []).slice(0, 6).map((keyword) => (
                            <span key={keyword} className="rounded-md bg-tavern-bg-soft px-1.5 py-0.5 text-[10px] text-tavern-text-muted">{keyword}</span>
                          ))}
                          <Sparkles className="mx-0.5 h-3 w-3 text-tavern-accent" />
                          {suggestion.aliases.map((alias) => (
                            <span key={alias} className="rounded-md bg-tavern-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-tavern-accent">+ {alias}</span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </label>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
