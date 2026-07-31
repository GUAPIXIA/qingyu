/**
 * 快捷回复工具（纯函数）
 *
 * 负责 global + 角色级合并、排序、快捷键查找。
 * 宏展开在调用方（ChatInput）通过 expandMacros 完成。
 */

import type { QuickReply, QuickReplyStore } from '../../shared/types'

/** 获取角色有效快捷回复：global + 角色专属合并，按 order 排序 */
export function getEffectiveQuickReplies(store: QuickReplyStore, characterId: string | null | undefined): QuickReply[] {
  const global = store?.global ?? []
  const char = characterId ? (store?.byCharacter?.[characterId] ?? []) : []
  return [...global, ...char]
    .filter((q) => q.enabled)
    .sort((a, b) => a.order - b.order)
}

/** 按快捷键查找（1-9），无匹配返回 undefined */
export function findQuickReplyByHotkey(replies: QuickReply[], hotkey: number): QuickReply | undefined {
  return replies.find((q) => q.hotkey === hotkey)
}

/** 新建快捷回复 */
export function createQuickReply(partial: Partial<QuickReply> = {}): QuickReply {
  return {
    id: Math.random().toString(36).slice(2, 10),
    label: '快捷回复',
    content: '',
    action: 'text',
    sendWithAI: true,
    order: 0,
    enabled: true,
    ...partial,
  }
}
