import type { SpatialAiSession } from '../../../shared/spatial-ai'

export const SPATIAL_DISABLED_REASON = '空间画布已关闭'

/** 必须在会话中明确开启；历史全局设置不再开启其他会话。 */
export function isSpatialBoardEnabled(session: { spatialBoardEnabled?: boolean }): boolean {
  return session.spatialBoardEnabled === true
}

export function assertSpatialBoardEnabled(session: { spatialBoardEnabled?: boolean }): void {
  if (!isSpatialBoardEnabled(session)) throw new Error(SPATIAL_DISABLED_REASON)
}

/** 停止旧任务和未完成的正文登记，重新开启后仅同步新的剧情。 */
export function cancelSpatialWork<T extends SpatialAiSession<unknown>>(state: T): T {
  for (const task of state.tasks) if (task.state === 'queued' || task.state === 'running') {
    task.state = 'cancelled'; task.error = SPATIAL_DISABLED_REASON; task.completedAt = Date.now()
  }
  for (const generation of state.dialogueGenerations ?? []) if (generation.state === 'awaiting_body') generation.state = 'ignored'
  for (const batch of state.groupDialogueBatches ?? []) {
    batch.closed = true
    for (const generation of batch.generations) if (generation.state === 'awaiting_body') generation.state = 'ignored'
  }
  for (const proposal of state.proposals) if (proposal.mode === 'dialogue_sync' && ['pending', 'stale'].includes(proposal.status)) {
    proposal.status = 'stale'; proposal.staleReason = SPATIAL_DISABLED_REASON; proposal.canReview = false
    if (proposal.automatic?.status === 'applying') proposal.automatic = { status: 'confirmation', reason: SPATIAL_DISABLED_REASON }
  }
  return state
}
