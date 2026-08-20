/**
 * V12-09 MessagePort 真实实现（对接 chatData JSONL 存储）
 */
import { nanoid } from 'nanoid'
import { chatData } from '../ipc/chat'
import type { MessagePort, PersistUserMessage, PersistAssistantMessage } from './ports'

export const chatMessagePort: MessagePort = {
  async findSession(sessionId, characterId) {
    const { findSessionById, findSessionByCharacterId } = await import('../bridge/sessionsIndex')
    const s = characterId ? await findSessionByCharacterId(characterId, sessionId) : await findSessionById(sessionId)
    if (!s) return null
    return { id: s.id, sessionId: s.id, characterId: s.characterId }
  },

  async findByRequestId(sessionId, requestId) {
    // 扫描该会话的消息，查找 requestId 匹配（Message.requestId 为可选字段，0.12 后写入）
    const { listAllSessions } = await import('../bridge/sessionsIndex')
    const all = await listAllSessions()
    const target = all.find((s) => s.id === sessionId)
    if (!target) return null
    const msgs = chatData.readMessages(target.characterId, sessionId)
    const found = msgs.find((m) => (m as unknown as { requestId?: string }).requestId === requestId)
    return found ? { id: found.id } : null
  },

  async appendUserMessage(input: PersistUserMessage) {
    chatData.saveMessage(input.characterId, {
      id: input.id,
      sessionId: input.sessionId,
      characterId: input.characterId,
      role: 'user',
      content: input.content,
      images: input.images ?? [],
      isEditing: false,
      timestamp: Date.now(),
      replyToId: input.replyToId,
      requestId: input.requestId,
    } as unknown as Parameters<typeof chatData.saveMessage>[1])
    return { id: input.id }
  },

  async commitAssistantMessage(input: PersistAssistantMessage) {
    chatData.saveMessage(input.characterId, {
      id: input.id,
      sessionId: input.sessionId,
      characterId: input.characterId,
      role: 'assistant',
      content: input.content,
      images: input.images ?? [],
      isEditing: false,
      timestamp: Date.now(),
      generationTaskId: input.generationTaskId,
      requestId: input.requestId,
    } as unknown as Parameters<typeof chatData.saveMessage>[1])
    return { id: input.id }
  },

  async updateAssistantMessage(messageId, patch) {
    // 暂未用于 v2 主路径，保留接口兼容
    void messageId
    void patch
  },
}
