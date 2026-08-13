/**
 * 世界书共享常量（P-8 从 LorebookPage 拆分，与组件分离避免 fast-refresh 警告）
 */
import type { LoreEntry } from '../../../shared/types'

export const POSITION_LABELS: Record<LoreEntry['position'], string> = {
  before_char: '角色定义前',
  after_char: '角色定义后',
  at_depth: '历史消息中（按深度）',
  at_end: '消息末尾',
}

export const MATCH_MODE_LABELS: Record<NonNullable<LoreEntry['matchMode']>, string> = {
  keyword: '关键词',
  semantic: '语义（向量）',
  both: '关键词 + 语义',
}
