import { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, FlaskConical, Play, XCircle } from 'lucide-react'
import type { Lorebook, LoreEntry } from '../../../shared/types'
import { useSettingsStore } from '../../store/useSettingsStore'
import { executeLorebookRuntime } from '../../utils/lorebook'
import { cn } from '../../lib/utils'
import { LORE_TRIGGER_REASON_LABELS } from '../../components/chat/lorebookDebugLabels'

interface LorebookEntryTriggerTesterProps {
  lorebook: Lorebook
  entry: LoreEntry
}

type GenerationType = NonNullable<LoreEntry['generationTriggers']>[number]

const generationLabels: Record<GenerationType, string> = {
  normal: '正常发送',
  continue: '续写',
  impersonate: '代写用户',
  swipe: '切换回复',
  regenerate: '重新生成',
  quiet: '静默生成',
}

export function LorebookEntryTriggerTester({ lorebook, entry }: LorebookEntryTriggerTesterProps) {
  const [open, setOpen] = useState(false)
  const [scanText, setScanText] = useState('')
  const [generationType, setGenerationType] = useState<GenerationType>('normal')
  const [characterName, setCharacterName] = useState('角色')
  const [characterTags, setCharacterTags] = useState('')
  const [runVersion, setRunVersion] = useState(0)
  const settings = useSettingsStore((state) => state.settings)

  const report = useMemo(() => {
    if (runVersion === 0) return null
    const semanticEnabled = !!(
      settings.semanticTrigger?.enabled
      && settings.semanticTrigger.baseUrl?.trim()
      && settings.semanticTrigger.model?.trim()
    )
    return executeLorebookRuntime({
      lorebooks: [{ ...lorebook, entries: [entry] }],
      scanText,
      scanMessages: [scanText],
      userName: settings.userName || '用户',
      charName: characterName.trim() || '角色',
      characterNames: [characterName.trim() || '角色'],
      characterTags: characterTags.split(',').map((tag) => tag.trim()).filter(Boolean),
      generationType,
      budget: 100_000,
      model: settings.activeModel || 'gpt-4o-mini',
      semanticEnabled,
      diagnosticsMode: 'preview',
    }).diagnostics ?? null
  }, [characterName, characterTags, entry, generationType, lorebook, runVersion, scanText, settings])

  const detail = report?.entries[0]
  const injected = detail?.outcome.startsWith('injected') ?? false
  const unavailable = !detail

  return (
    <div className="overflow-hidden rounded-xl border border-tavern-border-soft bg-tavern-bg/70 lg:col-span-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-tavern-bg-hover"
        aria-expanded={open}
      >
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-tavern-accent-soft text-tavern-accent">
          <FlaskConical className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-tavern-text">测试此条目</div>
          <div className="mt-0.5 text-[10px] text-tavern-text-muted">在单条目沙盒中检查匹配、过滤和概率结果</div>
        </div>
        <ChevronDown className={cn('h-4 w-4 text-tavern-text-muted transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="space-y-3 border-t border-tavern-border-soft bg-tavern-bg-soft/40 p-3">
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-tavern-text-soft">模拟对话文本</span>
            <textarea
              value={scanText}
              onChange={(event) => setScanText(event.target.value)}
              className="textarea h-20 font-mono text-xs"
              placeholder="输入任意对话，例如：我们终于抵达王城。"
              aria-label="模拟对话文本"
            />
          </label>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label>
              <span className="mb-1 block text-[10px] text-tavern-text-muted">生成类型</span>
              <select className="select text-xs" value={generationType} onChange={(event) => setGenerationType(event.target.value as GenerationType)}>
                {(Object.keys(generationLabels) as GenerationType[]).map((value) => <option key={value} value={value}>{generationLabels[value]}</option>)}
              </select>
            </label>
            <label>
              <span className="mb-1 block text-[10px] text-tavern-text-muted">角色名称</span>
              <input className="input text-xs" value={characterName} onChange={(event) => setCharacterName(event.target.value)} aria-label="测试角色名称" />
            </label>
            <label>
              <span className="mb-1 block text-[10px] text-tavern-text-muted">角色标签（逗号分隔）</span>
              <input className="input text-xs" value={characterTags} onChange={(event) => setCharacterTags(event.target.value)} aria-label="测试角色标签" />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-secondary text-xs" onClick={() => setRunVersion((value) => value + 1)}>
              <Play className="h-3.5 w-3.5" />运行测试
            </button>
            <span className="text-[10px] text-tavern-text-muted">使用稳定随机数；不会保存条目、写入会话或消耗 API。</span>
          </div>

          {runVersion > 0 && (
            <div className={cn(
              'rounded-lg border p-3',
              injected && 'border-emerald-500/25 bg-emerald-500/5',
              !injected && !unavailable && 'border-amber-500/25 bg-amber-500/5',
              unavailable && 'border-tavern-border-soft bg-tavern-bg',
            )}>
              <div className="flex items-center gap-2">
                {injected ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : unavailable ? <AlertTriangle className="h-4 w-4 text-amber-500" /> : <XCircle className="h-4 w-4 text-amber-500" />}
                <span className="text-xs font-medium text-tavern-text">
                  {injected ? '测试通过：该条目会进入上下文' : unavailable ? '无法测试：世界书或条目当前未启用' : '本次条件下未触发'}
                </span>
                {detail?.score !== undefined && <span className="ml-auto font-mono text-[11px] text-tavern-text-muted">score {detail.score.toFixed(3)}</span>}
              </div>

              {detail && (
                <div className="mt-2 space-y-2 text-[11px] text-tavern-text-soft">
                  {detail.reason && <div className="text-amber-700 dark:text-amber-300">原因：{LORE_TRIGGER_REASON_LABELS[detail.reason]}{detail.reason === 'probability' && detail.probabilityRoll !== undefined ? `（概率 ${detail.probability}% / 掷骰 ${detail.probabilityRoll.toFixed(1)}）` : ''}</div>}
                  {!!detail.matchedKeywords?.length && (
                    <div className="flex flex-wrap gap-1">
                      <span className="text-tavern-text-muted">命中：</span>
                      {detail.matchedKeywords.map((item) => <span key={`${item.channel}:${item.keyword}`} className="rounded bg-tavern-accent-soft px-1.5 py-0.5 text-tavern-accent">{item.keyword} ×{item.count}</span>)}
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <ResultValue label="关键词分" value={detail.keywordHits?.toFixed(3) ?? '—'} />
                    <ResultValue label="语义分" value={detail.semanticScore !== undefined ? `${detail.semanticScore.toFixed(3)} · ${detail.semanticSource === 'real' ? '真实' : detail.semanticSource === 'approx' ? '近似' : '无'}` : '—'} />
                    <ResultValue label="扫描深度" value={detail.effectiveScanDepth?.toString() ?? '默认'} />
                    <ResultValue label="注入位置" value={detail.renderTarget ?? detail.position} />
                  </div>
                  {detail.renderStatus === 'fallback' && detail.renderReason && (
                    <div className="rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-1.5 text-amber-700 dark:text-amber-300">
                      渲染降级：{detail.renderReason}
                    </div>
                  )}
                  <details className="group rounded-md border border-tavern-border-soft bg-tavern-bg">
                    <summary className="flex cursor-pointer list-none items-center px-2 py-1.5 text-tavern-text-muted">实际扫描文本<ChevronDown className="ml-auto h-3.5 w-3.5 transition-transform group-open:rotate-180" /></summary>
                    <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words border-t border-tavern-border-soft px-2 py-2 font-mono leading-5">{detail.scanText || '（扫描文本为空）'}</pre>
                  </details>
                </div>
              )}
            </div>
          )}

          {(entry.matchMode === 'semantic' || (entry.matchMode ?? 'both') === 'both') && (
            <p className="flex items-start gap-1.5 text-[10px] leading-4 text-tavern-text-muted">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              单条目沙盒不执行向量检索；真实语义命中请查看聊天中的“上一轮发送”诊断。本测试仍会展示无向量时的词面近似评分。
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function ResultValue({ label, value }: { label: string; value: string }) {
  return <div><div className="text-[10px] text-tavern-text-muted">{label}</div><div className="mt-0.5 font-mono">{value}</div></div>
}
