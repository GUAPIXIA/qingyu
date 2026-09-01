import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  CircleSlash2,
  Clock3,
  Database,
  Search,
  TextSearch,
} from 'lucide-react'
import type {
  LorebookDiagnostics,
  LoreTriggerDetail,
} from '../../utils/lorebook'
import { cn } from '../../lib/utils'
import { LORE_TRIGGER_REASON_LABELS } from './lorebookDebugLabels'

interface LorebookDebugPanelProps {
  live: LorebookDiagnostics | null
  preview: LorebookDiagnostics | null
}

type Filter = 'all' | 'injected' | 'dropped' | 'not_triggered'

const activationLabels: Record<NonNullable<LoreTriggerDetail['activationSource']>, string> = {
  always: '常驻',
  sticky: '黏性',
  keyword: '关键词',
  lexical: '词法',
  vector: '向量',
  hybrid: '混合',
  recursive: '递归',
}

/** 阶段4：词法兜底语义的可解释标签（方案 7.3 / 14.4）。 */
const fallbackReasonLabels: Record<NonNullable<LoreTriggerDetail['fallbackReason']>, string> = {
  lexical_fallback: '本地词法兜底（embeddings 不可用）',
  vector_miss_lexical_fallback: '本地词法兜底（向量未召回）',
}

function isInjected(detail: LoreTriggerDetail): boolean {
  return detail.outcome.startsWith('injected')
}

function outcomeLabel(detail: LoreTriggerDetail): string {
  if (detail.outcome === 'injected_summary') return '摘要注入'
  if (detail.outcome === 'injected_compression') return '压缩注入'
  if (detail.outcome === 'injected') return '已注入'
  if (detail.outcome === 'dropped') return '被裁剪'
  return '未触发'
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(timestamp)
}

export function LorebookDebugPanel({ live, preview }: LorebookDebugPanelProps) {
  const [source, setSource] = useState<'live' | 'preview'>(live ? 'live' : 'preview')
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [expandedKey, setExpandedKey] = useState<string | null>(null)

  useEffect(() => {
    if (!live && preview) setSource('preview')
  }, [live, preview])

  const diagnostics = source === 'live' ? live : preview
  const entries = useMemo(() => {
    if (!diagnostics) return []
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return diagnostics.entries.filter((detail) => {
      const filterMatched = filter === 'all'
        || (filter === 'injected' && isInjected(detail))
        || (filter === 'dropped' && detail.outcome === 'dropped')
        || (filter === 'not_triggered' && detail.outcome === 'not_triggered')
      if (!filterMatched) return false
      if (!normalizedQuery) return true
      return `${detail.bookName} ${detail.name} ${detail.key}`.toLocaleLowerCase().includes(normalizedQuery)
    })
  }, [diagnostics, filter, query])

  if (!diagnostics) {
    return (
      <div className="min-h-64 grid place-items-center rounded-xl border border-dashed border-tavern-border bg-tavern-bg-soft/50 px-6 text-center">
        <div>
          <BookOpen className="mx-auto mb-3 h-8 w-8 text-tavern-text-muted" />
          <p className="text-sm font-medium text-tavern-text">暂无世界书诊断数据</p>
          <p className="mt-1 text-xs leading-5 text-tavern-text-muted">当前会话没有激活世界书，或尚未构建上下文。</p>
        </div>
      </div>
    )
  }

  const { summary } = diagnostics
  const budgetPercent = summary.budget > 0
    ? Math.min(100, Math.round((summary.usedTokens / summary.budget) * 100))
    : summary.usedTokens > 0 ? 100 : 0

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-tavern-border-soft bg-tavern-bg-soft p-1.5">
        <button
          type="button"
          disabled={!live}
          onClick={() => setSource('live')}
          className={cn(
            'flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors',
            source === 'live' ? 'bg-tavern-bg text-tavern-accent shadow-sm' : 'text-tavern-text-muted hover:text-tavern-text',
            !live && 'cursor-not-allowed opacity-40',
          )}
        >
          <Activity className="h-3.5 w-3.5" />
          上一轮发送
        </button>
        <button
          type="button"
          disabled={!preview}
          onClick={() => setSource('preview')}
          className={cn(
            'flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors',
            source === 'preview' ? 'bg-tavern-bg text-tavern-accent shadow-sm' : 'text-tavern-text-muted hover:text-tavern-text',
            !preview && 'cursor-not-allowed opacity-40',
          )}
        >
          <TextSearch className="h-3.5 w-3.5" />
          当前模拟
        </button>
        <div className="ml-auto flex items-center gap-2 px-2 text-[11px] text-tavern-text-muted">
          <Clock3 className="h-3.5 w-3.5" />
          {formatTime(diagnostics.createdAt)} · {diagnostics.generationType}
        </div>
      </div>

      {source === 'preview' && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          当前模拟使用稳定随机数，并读取当前语义候选缓存；它用于排查配置，不代表下一次发送一定得到相同结果。
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <MetricCard icon={BookOpen} label="激活范围" value={`${summary.activeBooks} 本 / ${summary.enabledEntries} 条`} hint="启用世界书与条目" />
        <MetricCard icon={Activity} label="条件命中" value={`${summary.matchedEntries}`} hint={`最终注入 ${summary.injectedEntries} 条`} tone="accent" />
        <MetricCard icon={CheckCircle2} label="注入方式" value={`${summary.injectedEntries}`} hint={`摘要 ${summary.summaryEntries} · 压缩 ${summary.compressionEntries}`} tone="success" />
        <MetricCard icon={CircleSlash2} label="未进入上下文" value={`${summary.droppedEntries + summary.untriggeredEntries}`} hint={`裁剪 ${summary.droppedEntries} · 未触发 ${summary.untriggeredEntries}`} tone={summary.droppedEntries ? 'warning' : 'neutral'} />
      </div>

      <div className="rounded-xl border border-tavern-border-soft bg-tavern-bg-soft/60 p-3">
        <div className="mb-2 flex items-center justify-between text-xs">
          <span className="font-medium text-tavern-text">世界书预算</span>
          <span className="font-mono text-tavern-text-soft">{summary.usedTokens} / {summary.budget} tokens</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-tavern-border-soft">
          <div className={cn('h-full rounded-full transition-all', budgetPercent >= 90 ? 'bg-amber-500' : 'bg-tavern-accent')} style={{ width: `${budgetPercent}%` }} />
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-tavern-text-muted">
          <span>书级裁剪 {summary.bookBudgetDropped}</span>
          <span>全局裁剪 {summary.globalBudgetDropped}</span>
          <span>不计预算 {summary.ignoredBudgetTokens} tokens</span>
          <span className={cn(summary.semanticDeadEntries > 0 && 'text-amber-600 dark:text-amber-300')}>语义死条目 {summary.semanticDeadEntries}</span>
          <span>语义候选 {diagnostics.semantic.candidateCount}</span>
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex gap-1 overflow-x-auto rounded-lg bg-tavern-bg-soft p-1">
          {([
            ['all', `全部 ${diagnostics.entries.length}`],
            ['injected', `已注入 ${summary.injectedEntries}`],
            ['dropped', `被裁剪 ${summary.droppedEntries}`],
            ['not_triggered', `未触发 ${summary.untriggeredEntries}`],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              className={cn(
                'shrink-0 rounded-md px-2.5 py-1.5 text-[11px] transition-colors',
                filter === value ? 'bg-tavern-bg text-tavern-text shadow-sm' : 'text-tavern-text-muted hover:text-tavern-text',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-tavern-text-muted" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索书名、条目或 key"
            className="w-full rounded-lg border border-tavern-border-soft bg-tavern-bg py-2 pl-8 pr-3 text-xs text-tavern-text outline-none transition-colors placeholder:text-tavern-text-muted focus:border-tavern-accent"
          />
        </label>
      </div>

      <div className="max-h-[43vh] space-y-1.5 overflow-y-auto pr-1">
        {entries.map((detail) => (
          <EntryTrace
            key={detail.key}
            detail={detail}
            expanded={expandedKey === detail.key}
            onToggle={() => setExpandedKey((current) => current === detail.key ? null : detail.key)}
          />
        ))}
        {entries.length === 0 && (
          <div className="rounded-lg border border-dashed border-tavern-border-soft py-8 text-center text-xs text-tavern-text-muted">没有符合筛选条件的条目</div>
        )}
      </div>

      <details className="group rounded-xl border border-tavern-border-soft bg-tavern-bg-soft/40">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-xs font-medium text-tavern-text">
          <Database className="h-3.5 w-3.5 text-tavern-accent" />
          全局扫描文本（去噪后）
          <span className="ml-auto text-[11px] font-normal text-tavern-text-muted">{diagnostics.scan.messageCount} 条消息</span>
          <ChevronDown className="h-3.5 w-3.5 text-tavern-text-muted transition-transform group-open:rotate-180" />
        </summary>
        <pre className="max-h-44 overflow-auto border-t border-tavern-border-soft px-3 py-3 whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-tavern-text-soft">{diagnostics.scan.cleanedText || '（扫描文本为空）'}</pre>
      </details>
    </div>
  )
}

function MetricCard({ icon: Icon, label, value, hint, tone = 'neutral' }: {
  icon: typeof Activity
  label: string
  value: string
  hint: string
  tone?: 'neutral' | 'accent' | 'success' | 'warning'
}) {
  return (
    <div className="rounded-xl border border-tavern-border-soft bg-tavern-bg p-3">
      <div className="flex items-center gap-1.5 text-[11px] text-tavern-text-muted"><Icon className="h-3.5 w-3.5" />{label}</div>
      <div className={cn(
        'mt-2 font-mono text-lg font-semibold tracking-tight text-tavern-text',
        tone === 'accent' && 'text-tavern-accent',
        tone === 'success' && 'text-emerald-600 dark:text-emerald-400',
        tone === 'warning' && 'text-amber-600 dark:text-amber-300',
      )}>{value}</div>
      <div className="mt-0.5 text-[10px] text-tavern-text-muted">{hint}</div>
    </div>
  )
}

function EntryTrace({ detail, expanded, onToggle }: { detail: LoreTriggerDetail; expanded: boolean; onToggle: () => void }) {
  const injected = isInjected(detail)
  const dropped = detail.outcome === 'dropped'
  return (
    <div className={cn(
      'overflow-hidden rounded-lg border bg-tavern-bg transition-colors',
      injected && 'border-emerald-500/25',
      dropped && 'border-amber-500/30',
      !injected && !dropped && 'border-tavern-border-soft',
    )}>
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-tavern-bg-soft/70">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', injected ? 'bg-emerald-500' : dropped ? 'bg-amber-500' : 'bg-tavern-text-muted/40')} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-xs font-medium text-tavern-text">{detail.name}</span>
            <span className="hidden truncate font-mono text-[10px] text-tavern-text-muted sm:block">{detail.key}</span>
          </div>
          <div className="mt-0.5 truncate text-[10px] text-tavern-text-muted">
            {detail.bookName} · {detail.reason ? LORE_TRIGGER_REASON_LABELS[detail.reason] : activationLabels[detail.activationSource ?? 'keyword']}
            {detail.fallbackReason && <span className="text-amber-600 dark:text-amber-400"> · 词法兜底</span>}
          </div>
        </div>
        {detail.score !== undefined && <span className="font-mono text-[11px] text-tavern-text-soft">{detail.score.toFixed(3)}</span>}
        <span className={cn(
          'rounded-full px-2 py-0.5 text-[10px] font-medium',
          injected && 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
          dropped && 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
          !injected && !dropped && 'bg-tavern-bg-soft text-tavern-text-muted',
        )}>{outcomeLabel(detail)}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-tavern-text-muted transition-transform', expanded && 'rotate-180')} />
      </button>

      {expanded && (
        <div className="border-t border-tavern-border-soft bg-tavern-bg-soft/35 px-3 py-3 text-[11px]">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-4">
            <TraceValue label="触发来源" value={detail.activationSource ? activationLabels[detail.activationSource] : '—'} />
            <TraceValue label="关键词分" value={detail.keywordHits?.toFixed(3) ?? '—'} />
            <TraceValue label="语义分" value={detail.semanticScore !== undefined ? `${detail.semanticScore.toFixed(3)} · ${detail.semanticSource === 'real' ? '真实' : detail.semanticSource === 'approx' ? '近似' : '无'}` : '—'} />
            <TraceValue label="实体 / 近因" value={`${detail.entityHit ? '+' : '−'} / ${detail.recencyHit ? '+' : '−'}`} />
            <TraceValue label="词法通道" value={detail.lexicalRank !== undefined ? `#${detail.lexicalRank} · ${detail.lexicalScore?.toFixed(3) ?? '—'}` : '—'} />
            <TraceValue label="向量通道" value={detail.vectorRank !== undefined ? `#${detail.vectorRank} · ${detail.vectorScore?.toFixed(3) ?? '—'}` : '—'} />
            <TraceValue label="融合分" value={detail.fusionScore?.toFixed(3) ?? '—'} />
            <TraceValue label="词法兜底" value={detail.fallbackReason ? fallbackReasonLabels[detail.fallbackReason] : '—'} />
            <TraceValue label="来源格式" value={detail.adapterId ?? '轻语 legacy'} />
            <TraceValue label="检索策略" value={detail.retrievalMode ?? '兼容模式'} />
            <TraceValue label="注入位置" value={detail.renderTarget ?? `${detail.position}${detail.position === 'at_depth' ? ` · depth ${detail.depth ?? 0}` : ''}`} />
            <TraceValue label="渲染状态" value={detail.renderStatus === 'fallback' ? '已降级' : detail.renderStatus === 'exact' ? '精确' : '—'} />
            <TraceValue label="扫描深度" value={detail.effectiveScanDepth?.toString() ?? '默认'} />
            <TraceValue label="Token" value={detail.injectedTokens !== undefined ? `${detail.injectedTokens} / 原 ${detail.originalTokens ?? 0}` : `${detail.originalTokens ?? 0}`} />
            <TraceValue label="预算排名" value={detail.budgetRank ? `#${detail.budgetRank}` : '—'} />
          </div>

          {detail.reason && (
            <div className="mt-3 rounded-md border border-amber-500/20 bg-amber-500/10 px-2.5 py-2 text-amber-700 dark:text-amber-300">
              {LORE_TRIGGER_REASON_LABELS[detail.reason]}
              {detail.reason === 'probability' && detail.probabilityRoll !== undefined && `：概率 ${detail.probability}% / 掷骰 ${detail.probabilityRoll.toFixed(1)}`}
              {detail.reason === 'priority_budget' && detail.remainingTokens !== undefined && `：剩余 ${detail.remainingTokens} tokens`}
              {detail.duplicateOf && `；保留条目 ${detail.duplicateOf}`}
            </div>
          )}

          {detail.renderStatus === 'fallback' && detail.renderReason && (
            <div className="mt-3 rounded-md border border-amber-500/20 bg-amber-500/10 px-2.5 py-2 text-amber-700 dark:text-amber-300">
              渲染降级：{detail.renderReason}
            </div>
          )}

          {!!detail.matchedKeywords?.length && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="text-tavern-text-muted">命中词：</span>
              {detail.matchedKeywords.map((item) => (
                <span key={`${item.channel}:${item.keyword}`} className="rounded bg-tavern-accent-soft px-1.5 py-0.5 text-tavern-accent">
                  {item.keyword} ×{item.count}{item.channel === 'secondary' ? ' · 次级' : ''}
                </span>
              ))}
            </div>
          )}

          <details className="group mt-3 rounded-md border border-tavern-border-soft bg-tavern-bg">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-2 text-tavern-text-soft">
              <TextSearch className="h-3.5 w-3.5" />该条目实际扫描文本
              <ChevronDown className="ml-auto h-3.5 w-3.5 transition-transform group-open:rotate-180" />
            </summary>
            <pre className="max-h-36 overflow-auto border-t border-tavern-border-soft px-2.5 py-2 whitespace-pre-wrap break-words font-mono leading-5 text-tavern-text-muted">{detail.scanText || '（扫描文本为空）'}</pre>
          </details>
        </div>
      )}
    </div>
  )
}

function TraceValue({ label, value }: { label: string; value: string }) {
  return <div><div className="text-[10px] text-tavern-text-muted">{label}</div><div className="mt-0.5 font-mono text-tavern-text-soft">{value}</div></div>
}
