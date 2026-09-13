/**
 * 生成收尾状态 → 消息提示字段的映射（阶段3「结构化完成事件」）。
 *
 * 纯函数，供渲染层（单聊/群聊/续写）与 Bridge 共用：口径一致后，
 * PC 与 Android 对同一条消息显示同义的「已恢复/已补尾/已停止/中断」提示。
 */

import type { AIFinishReason } from './types'

/** 收尾提示类型（与 shared/assistantOutputFinalizer 的 FinalizedNotice 同集） */
export type GenerationNoticeKind =
  | 'trimmed_to_boundary'
  | 'tail_repaired'
  | 'partial_network_output'

/** 一次生成的结束元数据（渲染层 GenerationOutcomeMeta 的纯数据子集） */
export interface GenerationOutcomeNoticeInput {
  finishReason: AIFinishReason
  notice?: GenerationNoticeKind
  /** 用户手动停止 */
  stopped?: boolean
  /** 补尾失败：已保留稳定前缀，展示可重试提示 */
  repairFailed?: boolean
}

/** 把收尾元数据映射为消息提示字段——"已恢复"走中性提示，失败走 generationError */
export function finalizeNoticeFields(
  meta: GenerationOutcomeNoticeInput,
): { generationNotice?: string; generationError?: string } {
  if (meta.stopped) return { generationNotice: '已停止生成' }
  if (meta.repairFailed) return { generationError: '生成中断，已保留完整部分' }
  if (meta.notice === 'tail_repaired') return { generationNotice: '已自动补全结尾' }
  if (meta.notice === 'trimmed_to_boundary') {
    return meta.finishReason === 'network_error'
      ? { generationNotice: '生成中断，已在完整句处收束' }
      : { generationNotice: '内容已在完整句处收束' }
  }
  if (meta.notice === 'partial_network_output') return { generationNotice: '生成中断，已保留完整部分' }
  return {}
}
