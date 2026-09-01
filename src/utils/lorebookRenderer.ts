import type { JsonValue, LorebookInsertionV2, LorebookRetrievalMode } from '../../shared/lorebook/domain/v2'

export interface LorebookRenderItem {
  content: string
  order: number
  insertion: LorebookInsertionV2
  key?: string
  adapterId?: string
  retrievalMode?: LorebookRetrievalMode
}

export interface LorebookChatRenderItem {
  content: string
  order: number
  depth: number
  role?: 'system' | 'user' | 'assistant'
}

export interface LorebookRenderFallback {
  key?: string
  source: 'outlet' | 'custom'
  target: string
  value?: JsonValue
  reason: string
}

export interface LorebookRenderDecision {
  key?: string
  status: 'exact' | 'fallback'
  target: string
  reason?: string
}

export interface LorebookRenderPlan {
  beforeCharacter: string[]
  afterCharacter: string[]
  beforeExamples: string[]
  afterExamples: string[]
  authorsNoteTop: string[]
  authorsNoteBottom: string[]
  promptEnd: string[]
  chat: LorebookChatRenderItem[]
  outlets: Record<string, string[]>
  fallbacks: LorebookRenderFallback[]
  decisions: LorebookRenderDecision[]
}

export function emptyLorebookRenderPlan(): LorebookRenderPlan {
  return {
    beforeCharacter: [],
    afterCharacter: [],
    beforeExamples: [],
    afterExamples: [],
    authorsNoteTop: [],
    authorsNoteBottom: [],
    promptEnd: [],
    chat: [],
    outlets: {},
    fallbacks: [],
    decisions: [],
  }
}

/**
 * 将已完成触发、调度与预算裁剪的条目渲染到稳定锚点。
 * outlet/custom 在普通聊天消息协议中没有原生槽位，因此保留独立输出通道，
 * 同时明确回退到 prompt_end，保证内容不会静默消失。
 */
export function renderLorebookItems(items: LorebookRenderItem[]): LorebookRenderPlan {
  const plan = emptyLorebookRenderPlan()
  for (const item of items) {
    const insertion = item.insertion
    if (insertion.kind === 'chat') {
      plan.chat.push({
        content: item.content,
        order: item.order,
        depth: Math.max(0, Math.floor(insertion.depth)),
        ...(insertion.role ? { role: insertion.role } : {}),
      })
      plan.decisions.push({ key: item.key, status: 'exact', target: `chat:${Math.max(0, Math.floor(insertion.depth))}` })
      continue
    }
    if (insertion.kind === 'prompt') {
      const buckets = {
        before_character: plan.beforeCharacter,
        after_character: plan.afterCharacter,
        before_examples: plan.beforeExamples,
        after_examples: plan.afterExamples,
        authors_note_top: plan.authorsNoteTop,
        authors_note_bottom: plan.authorsNoteBottom,
        prompt_end: plan.promptEnd,
      }
      buckets[insertion.anchor].push(item.content)
      plan.decisions.push({ key: item.key, status: 'exact', target: insertion.anchor })
      continue
    }
    if (insertion.kind === 'outlet') {
      const name = insertion.name.trim() || 'default'
      const outlet = plan.outlets[name] ?? []
      outlet.push(item.content)
      plan.outlets[name] = outlet
      plan.promptEnd.push(item.content)
      const reason = `当前聊天协议没有命名 outlet「${name}」，已回退到 prompt_end`
      plan.fallbacks.push({ key: item.key, source: 'outlet', target: `outlet:${name}`, reason })
      plan.decisions.push({ key: item.key, status: 'fallback', target: `outlet:${name} → prompt_end`, reason })
      continue
    }

    plan.promptEnd.push(item.content)
    const reason = `当前 renderer 不认识 ${insertion.source} 的 custom insertion，已回退到 prompt_end`
    plan.fallbacks.push({
      key: item.key,
      source: 'custom',
      target: insertion.source,
      value: insertion.value,
      reason,
    })
    plan.decisions.push({ key: item.key, status: 'fallback', target: `${insertion.source} → prompt_end`, reason })
  }
  return plan
}
