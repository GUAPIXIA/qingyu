import { useState } from 'react'
import { FileQuestion } from 'lucide-react'
import type { LorebookFormatChoicePending } from '../../../shared/ipc-api'
import { Modal } from '../../components/common/Modal'
import { cn } from '../../lib/utils'

interface Props {
  choice: LorebookFormatChoicePending
  onConfirm: (adapterId: string) => void
  onCancel: () => void
}

/** 方案 §6.1：检测到多个相近格式时不静默猜测，由用户确认实际格式后再导入。 */
export function LorebookFormatChoiceModal({ choice, onConfirm, onCancel }: Props) {
  const [selected, setSelected] = useState(choice.candidates[0]?.adapterId ?? '')

  return (
    <Modal
      open
      onClose={onCancel}
      title="请确认世界书格式"
      width="md"
      footer={(
        <>
          <button className="btn-secondary px-4 py-2" onClick={onCancel}>取消</button>
          <button
            className="btn-primary px-4 py-2"
            disabled={!selected}
            onClick={() => onConfirm(selected)}
          >
            导入
          </button>
        </>
      )}
    >
      <div className="space-y-3">
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-100">
          <FileQuestion className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            「{choice.fileName}」的特征同时接近多种世界书格式。为避免误判导致字段错位，请确认文件的实际格式：
          </span>
        </div>
        <div className="space-y-2">
          {choice.candidates.map((candidate) => (
            <label
              key={candidate.adapterId}
              className={cn(
                'flex cursor-pointer items-center justify-between gap-3 rounded-xl border p-3 text-sm transition-colors',
                selected === candidate.adapterId
                  ? 'border-sky-400/60 bg-tavern-bg-hover/60'
                  : 'border-tavern-border-soft hover:bg-tavern-bg-hover/30',
              )}
            >
              <span className="flex items-center gap-3">
                <input
                  type="radio"
                  name="lorebook-format-choice"
                  className="h-4 w-4 accent-sky-400"
                  checked={selected === candidate.adapterId}
                  onChange={() => setSelected(candidate.adapterId)}
                />
                <span className="font-medium text-tavern-text">{candidate.formatLabel}</span>
              </span>
              <span className="text-xs text-tavern-text-muted">置信度 {candidate.confidence}%</span>
            </label>
          ))}
        </div>
        <p className="text-xs text-tavern-text-muted">
          如果都不是，可取消后改用「映射向导导入」手动指定字段路径。
        </p>
      </div>
    </Modal>
  )
}
