import { AlertTriangle, CheckCircle2, Info } from 'lucide-react'
import type { LorebookImportResult } from '../../../shared/ipc-api'
import { Modal } from '../../components/common/Modal'
import { cn } from '../../lib/utils'

interface Props {
  result: LorebookImportResult
  onClose: () => void
}

const STATUS_LABELS = {
  exact: '完整兼容',
  preserved: '已保留扩展字段',
  approximated: '包含运行时近似',
  rejected: '无法导入',
} as const

export function LorebookImportReportModal({ result, onClose }: Props) {
  const { detection, report, lorebook } = result
  return (
    <Modal
      open
      onClose={onClose}
      title="世界书导入报告"
      width="lg"
      footer={(
        <button className="btn-primary px-4 py-2" onClick={onClose}>完成</button>
      )}
    >
      <div className="space-y-4">
        <div className="rounded-xl border border-tavern-border-soft bg-tavern-bg-hover/40 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="font-semibold text-tavern-text">{lorebook.name}</div>
              <div className="mt-1 text-sm text-tavern-text-muted">
                识别为 {detection.formatLabel} · 置信度 {detection.confidence}% · {lorebook.entries.length} 条
              </div>
            </div>
            <span className={cn(
              'rounded-full px-2.5 py-1 text-xs font-medium',
              report.status === 'exact' || report.status === 'preserved'
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'bg-amber-500/15 text-amber-300',
            )}>
              {STATUS_LABELS[report.status]}
            </span>
          </div>
          {detection.reasons.length > 0 && (
            <div className="mt-3 text-xs text-tavern-text-soft">
              识别依据：{detection.reasons.join('；')}
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <Metric label="保留字段" value={report.summary.preserved} />
          <Metric label="运行时近似" value={report.summary.approximated} />
          <Metric label="忽略字段" value={report.summary.dropped} />
          <Metric label="警告" value={report.summary.warnings} />
        </div>

        {report.issues.length === 0 ? (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm text-emerald-200">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            所有已知字段均可直接映射，没有检测到兼容性问题。
          </div>
        ) : (
          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {report.issues.map((item, index) => (
              <div
                key={`${item.code}-${item.path}-${index}`}
                className={cn(
                  'flex items-start gap-2 rounded-lg border p-3 text-sm',
                  item.severity === 'error'
                    ? 'border-red-500/20 bg-red-500/10'
                    : item.severity === 'warning'
                      ? 'border-amber-500/20 bg-amber-500/10'
                      : 'border-tavern-border-soft bg-tavern-bg-hover/30',
                )}
              >
                {item.severity === 'info'
                  ? <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-300" />
                  : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />}
                <div className="min-w-0">
                  <div className="text-tavern-text">{item.message}</div>
                  <code className="mt-1 block break-all text-xs text-tavern-text-muted">{item.path}</code>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-tavern-border-soft bg-tavern-bg-hover/30 p-2.5">
      <div className="text-xs text-tavern-text-muted">{label}</div>
      <div className="mt-1 font-semibold text-tavern-text">{value}</div>
    </div>
  )
}
