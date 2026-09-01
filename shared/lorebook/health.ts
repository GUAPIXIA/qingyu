/**
 * 阶段 7：一次性世界书数据健康检查。
 * 检查项与方案阶段 7 清单一致：重复 ID、非法正则、死条目、无法执行的位置、stale 索引。
 * 类型定义放在 shared 供渲染进程展示；分析逻辑在 electron/services/lorebookHealthCheck.ts。
 */

export type LorebookHealthIssueKind =
  | 'duplicate_id'
  | 'invalid_regex'
  | 'dead_entry'
  | 'unexecutable_position'
  | 'stale_index'

export interface LorebookHealthIssue {
  kind: LorebookHealthIssueKind
  bookId: string
  bookName: string
  entryId?: string
  detail: string
}

export interface LorebookHealthReport {
  checkedAt: number
  bookCount: number
  entryCount: number
  issues: LorebookHealthIssue[]
  summary: Record<LorebookHealthIssueKind, number>
  /** 没有任何问题时为 true。 */
  ok: boolean
}

export const LOREBOOK_HEALTH_KIND_LABELS: Record<LorebookHealthIssueKind, string> = {
  duplicate_id: '重复 ID',
  invalid_regex: '非法正则',
  dead_entry: '死条目',
  unexecutable_position: '无法执行的位置',
  stale_index: 'stale 索引',
}
