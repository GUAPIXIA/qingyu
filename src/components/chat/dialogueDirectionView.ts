import type { Character, DialogueDirection } from '../../../shared/types'

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
