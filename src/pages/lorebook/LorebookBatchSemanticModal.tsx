import { Brain, CheckCircle2, Loader2 } from 'lucide-react'
import { Modal } from '../../components/common/Modal'

interface Props {
  open: boolean
  affectedCount: number
  busy: boolean
  onClose: () => void
  onConfirm: () => void | Promise<void>
}

/** 将大量关键词条目安全升级为混合匹配，并紧接着建立向量索引。 */
export function LorebookBatchSemanticModal({ open, affectedCount, busy, onClose, onConfirm }: Props) {
  return (
    <Modal
      open={open}
      onClose={() => { if (!busy) onClose() }}
      title="批量启用语义匹配"
      width="sm"
    >
      <div className="space-y-4">
        <p className="text-sm leading-6 text-tavern-text-soft">
          将当前世界书中所有已启用的“仅关键词”条目改为“关键词 + 语义”。
        </p>

        <div className="flex items-center gap-3 rounded-xl border border-tavern-accent/30 bg-tavern-accent-soft px-4 py-3">
          <Brain className="h-5 w-5 shrink-0 text-tavern-accent" />
          <div>
            <p className="text-xs text-tavern-text-muted">本次影响</p>
            <p className="mt-0.5 font-display text-lg font-semibold text-tavern-text">{affectedCount} 个条目</p>
          </div>
        </div>

        <div className="space-y-2 text-xs leading-5 text-tavern-text-muted">
          <p className="flex items-start gap-2"><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-tavern-accent" />原有关键词和正则匹配保持不变。</p>
          <p className="flex items-start gap-2"><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-tavern-accent" />不会修改已禁用、正文为空或已经包含语义的条目。</p>
          <p className="flex items-start gap-2"><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-tavern-accent" />修改保存成功后，立即为当前世界书生成语义索引。</p>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button className="btn-secondary" disabled={busy} onClick={onClose}>取消</button>
          <button className="btn-primary" disabled={busy || affectedCount === 0} onClick={() => void onConfirm()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Brain className="h-4 w-4" />}
            {busy ? '正在修改...' : '修改并生成索引'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
