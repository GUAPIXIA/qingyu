import { CircleAlert, HeartPulse, Loader2 } from 'lucide-react'
import { Modal } from '../../components/common/Modal'
import { cn } from '../../lib/utils'
import type { LorebookHealthIssue, LorebookHealthIssueKind, LorebookHealthReport } from '../../../shared/lorebook/health'
import { LOREBOOK_HEALTH_KIND_LABELS } from '../../../shared/lorebook/health'

const KIND_ORDER: LorebookHealthIssueKind[] = ['duplicate_id', 'invalid_regex', 'dead_entry', 'unexecutable_position', 'stale_index']

const KIND_STYLES: Record<LorebookHealthIssueKind, string> = {
  duplicate_id: 'bg-tavern-danger/10 text-tavern-danger',
  invalid_regex: 'bg-tavern-danger/10 text-tavern-danger',
  dead_entry: 'bg-amber-500/10 text-amber-600',
  unexecutable_position: 'bg-tavern-text-muted/10 text-tavern-text-muted',
  stale_index: 'bg-sky-500/10 text-sky-600',
}

/**
 * 阶段 7：一次性世界书数据健康检查报告。
 * 只读展示；发现问题不自动修改数据，由用户按 detail 自行处理。
 */
export function LorebookHealthReportModal({ report, onClose }: { report: LorebookHealthReport | 'loading'; onClose: () => void }) {
  if (report === 'loading') {
    return (
      <Modal open onClose={onClose} title="世界书健康检查" width="md"
        footer={<button className="btn-secondary px-4 py-2" onClick={onClose}>关闭</button>}>
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-tavern-text-muted">
          <Loader2 className="w-4 h-4 animate-spin" /> 正在扫描全部世界书…
        </div>
      </Modal>
    )
  }

  const grouped = new Map<string, LorebookHealthIssue[]>()
  for (const item of report.issues) {
    const key = `${item.bookId}\u0000${item.bookName}`
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push(item)
  }

  return (
    <Modal open onClose={onClose} title="世界书健康检查" width="md"
      footer={<button className="btn-primary px-4 py-2" onClick={onClose}>知道了</button>}>
      <div className="space-y-4">
        <div className={cn('rounded-lg p-3 text-sm flex items-center gap-2', report.ok ? 'bg-tavern-success/10 text-tavern-success' : 'bg-amber-500/10 text-amber-600')}>
          <HeartPulse className="w-4 h-4" />
          {report.ok
            ? `全部 ${report.bookCount} 本世界书（${report.entryCount} 条）检查通过，没有发现问题。`
            : `发现 ${report.issues.length} 个问题，涉及 ${grouped.size} 本世界书。`}
        </div>

        {!report.ok && (
          <div className="flex flex-wrap gap-1.5 text-xs">
            {KIND_ORDER.filter((kind) => report.summary[kind] > 0).map((kind) => (
              <span key={kind} className={cn('rounded-full px-2 py-0.5', KIND_STYLES[kind])}>
                {LOREBOOK_HEALTH_KIND_LABELS[kind]} {report.summary[kind]}
              </span>
            ))}
          </div>
        )}

        <div className="max-h-80 overflow-auto space-y-3">
          {[...grouped.entries()].map(([key, items]) => {
            const [, bookName] = key.split('\u0000')
            return (
              <div key={key} className="rounded-lg border border-tavern-border-soft p-3 space-y-2">
                <h4 className="text-sm font-medium">{bookName}</h4>
                {items.map((item, index) => (
                  <div key={`${item.entryId ?? 'book'}-${index}`} className="text-xs space-y-0.5">
                    <div className="flex items-center gap-1.5">
                      <span className={cn('rounded px-1.5 py-0.5 text-[10px] shrink-0', KIND_STYLES[item.kind])}>
                        {LOREBOOK_HEALTH_KIND_LABELS[item.kind]}
                      </span>
                      {item.entryId && <code className="text-tavern-text-muted">{item.entryId}</code>}
                    </div>
                    <p className="text-tavern-text-soft leading-relaxed"><CircleAlert className="inline w-3 h-3 mr-1 opacity-60" />{item.detail}</p>
                  </div>
                ))}
              </div>
            )
          })}
        </div>

        {!report.ok && (
          <p className="text-xs text-tavern-text-muted">
            健康检查只报告问题，不会修改数据。重复 ID 与非法正则需在条目编辑器中修正；
            stale 索引可通过重建索引消除；无法执行的位置会在运行时回退到提示词末尾并记录诊断。
          </p>
        )}
      </div>
    </Modal>
  )
}
