import type { LoreTriggerReason } from '../../utils/lorebook'

export const LORE_TRIGGER_REASON_LABELS: Record<LoreTriggerReason, string> = {
  primary_miss: '主关键词未命中',
  secondary_miss: '二级关键词拦截',
  semantic_unavailable: '仅依赖语义，但语义触发不可用',
  semantic_miss: '语义触发可用，但本轮未命中',
  retrieval_miss: '所有检索通道均未召回',
  character_filter: '角色名称或标签过滤',
  generation_filter: '当前生成类型不允许触发',
  delay: '尚未达到延迟轮次',
  cooldown: '仍处于冷却期',
  recursion_delay: '尚未达到递归层级',
  exclude_recursion: '条目禁止递归触发',
  inclusion_group_lost: '包含组仲裁未选中',
  probability: '概率判定未通过',
  duplicate_content: '内容与已保留条目重复',
  book_budget: '书级预算不足',
  priority_budget: '世界书总预算不足',
}
