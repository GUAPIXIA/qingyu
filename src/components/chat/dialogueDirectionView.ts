import type { Character, DialogueDirection, GroupMessage, Message } from '../../../shared/types'

type SingleDirectionMessage = Pick<Message, 'id' | 'role' | 'content' | 'dialogueDirections'>
type GroupDirectionMessage = Pick<GroupMessage, 'id' | 'characterId' | 'content' | 'dialogueDirections'>

/**
 * 找到单聊中当前仍可操作的方向消息。
 *
 * 系统消息不代表新的对话回合，因此不会让其前面的最新 AI 回复失去“换一批”；
 * 但一旦已有更新的用户消息或 AI 回复，就不能回退到更旧的方向。
 */
export function findLatestActionableSingleDirectionMessageId(
  messages: readonly SingleDirectionMessage[],
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'system') continue
    if (message.role !== 'assistant' || !(message.content || '').trim()) return null
    return (message.dialogueDirections?.length ?? 0) > 0 ? message.id : null
  }
  return null
}

/**
 * 找到群聊中当前仍可操作的方向消息。
 * __free__ 是不会渲染的自由模式占位，忽略它；其余规则与单聊一致。
 */
export function findLatestActionableGroupDirectionMessageId(
  messages: readonly GroupDirectionMessage[],
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.characterId === '__free__') continue
    if (message.characterId === '__user__' || !(message.content || '').trim()) return null
    return (message.dialogueDirections?.length ?? 0) > 0 ? message.id : null
  }
  return null
}

/**
 * 判断某条消息是否应展示方向区域。
 * 历史消息保留展示已有方向（仅最新一条可“换一批”），流式生成中一律隐藏，
 * 避免在等待用户输入的节点之外出现选项（方案 §3.1 / §4.4）。
 */
export function shouldShowDialogueDirections(opts: {
  message: { role: string; content: string; dialogueDirections?: DialogueDirection[] }
  character: Character | null
  isStreaming: boolean
  isSystem: boolean
  enabled: boolean
}): boolean {
  const { message, character, isStreaming, isSystem, enabled } = opts
  if (!enabled || !character || isStreaming || isSystem) return false
  if (message.role !== 'assistant') return false
  if (!(message.content || '').trim()) return false
  return (message.dialogueDirections?.length ?? 0) > 0
}
