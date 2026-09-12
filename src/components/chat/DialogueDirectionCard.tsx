import { useState } from 'react'
import { Loader2, RefreshCw, Sparkles } from 'lucide-react'
import type { DialogueDirection } from '../../../shared/types'
import { cn } from '../../lib/utils'
import { getDraftText, applyDirectionToDraft, type DraftScope } from './draftBridge'

interface DialogueDirectionCardProps {
  directions: DialogueDirection[]
  /** 是否为最新一条消息；仅最新一条允许“换一批”（方案 §3.1）。 */
  canRegenerate: boolean
  /** 触发“换一批”；生成期间按钮显示加载态。 */
  onRegenerate: () => void | Promise<void>
  /** 生成失败的可见反馈（保留已生成方向时不展示）。 */
  error?: string | null
  /** 回填目标输入框：单聊或群聊（默认单聊）。 */
  scope?: DraftScope
}

/**
 * 气泡外的“下一步方向”卡片：点选只回填输入框，不自动发送。
 * 草稿非空时先内联确认，避免覆盖用户正在编辑的内容。
 */
export function DialogueDirectionCard({
  directions,
  canRegenerate,
  onRegenerate,
  error,
  scope = 'single',
}: DialogueDirectionCardProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pendingDirection, setPendingDirection] = useState<DialogueDirection | null>(null)
  const [regenerating, setRegenerating] = useState(false)

  const commit = (direction: DialogueDirection) => {
    applyDirectionToDraft(scope, direction.content)
    setSelectedId(direction.id)
    setPendingDirection(null)
  }

  const handleSelect = (direction: DialogueDirection) => {
    const current = getDraftText(scope).trim()
    // 草稿为空或本来就来自同一个方向：直接替换
    if (!current || current === direction.content.trim()) {
      commit(direction)
      return
    }
    setPendingDirection(direction)
  }

  const handleRegenerate = async () => {
    if (regenerating) return
    setRegenerating(true)
    setSelectedId(null)
    setPendingDirection(null)
    try {
      await onRegenerate()
    } finally {
      setRegenerating(false)
    }
  }

  return (
    <div
      data-testid="dialogue-direction-card"
      className="mt-2 rounded-xl border border-tavern-border bg-tavern-bg-card p-3 shadow-[0_6px_20px_rgba(26,22,37,0.12)]"
    >
      <div
        data-testid="dialogue-direction-header"
        className="mb-2 flex items-center justify-between gap-2 px-0.5"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-tavern-accent" aria-hidden />
          <span className="truncate text-xs font-semibold text-tavern-text">选择下一步方向</span>
        </span>

        {canRegenerate && (
          <button
            type="button"
            onClick={() => void handleRegenerate()}
            disabled={regenerating}
            className={cn(
              'flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors',
              regenerating
                ? 'cursor-not-allowed text-tavern-text-muted opacity-70'
                : 'text-tavern-text-soft hover:bg-tavern-bg-hover hover:text-tavern-accent',
            )}
          >
            {regenerating ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            换一批
          </button>
        )}
      </div>

      <div className="space-y-1.5">
        {directions.map((direction) => (
          <button
            key={direction.id}
            type="button"
            onClick={() => handleSelect(direction)}
            aria-pressed={selectedId === direction.id}
            className={cn(
              'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tavern-accent/40',
              selectedId === direction.id
                ? 'border-tavern-accent bg-tavern-accent-soft'
                : 'border-tavern-border bg-tavern-bg-soft hover:border-tavern-accent/60 hover:bg-tavern-bg-hover',
            )}
          >
            <span
              className={cn(
                'mt-px shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold',
                selectedId === direction.id
                  ? 'border-tavern-accent/35 bg-tavern-bg-card text-tavern-accent'
                  : 'border-tavern-border bg-tavern-bg-card text-tavern-text-soft',
              )}
            >
              {direction.label}
            </span>
            <span className="min-w-0 flex-1 text-xs leading-relaxed text-tavern-text-soft">{direction.content}</span>
          </button>
        ))}
      </div>

      {pendingDirection && (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-tavern-warning/25 bg-tavern-warning/10 px-2.5 py-1.5">
          <span className="text-[11px] font-medium text-tavern-text-soft">将覆盖当前草稿</span>
          <span className="flex items-center gap-1">
            <button
              type="button"
              className="rounded-md px-2 py-0.5 text-[11px] text-tavern-text-soft transition-colors hover:bg-tavern-bg-hover hover:text-tavern-text"
              onClick={() => setPendingDirection(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="rounded-md bg-tavern-accent px-2 py-0.5 text-[11px] font-medium text-white transition-opacity hover:opacity-90"
              onClick={() => pendingDirection && commit(pendingDirection)}
            >
              替换
            </button>
          </span>
        </div>
      )}

      {error && directions.length === 0 && (
        <p className="mt-1.5 px-0.5 text-[10px] text-tavern-danger">{error}</p>
      )}

    </div>
  )
}
