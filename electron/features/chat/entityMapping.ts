/**
 * 主进程聊天同步实体映射（阶段 3A：从 electron/ipc/chat.ts 原样迁出）。
 *
 * 这些 payload 构造函数同时是跨端 sync-payload golden 的 oracle
 * （shared/__tests__/syncPayloadGolden.test.ts），字段口径变更必须两端同步评估。
 */
import type { Message, ChatSession } from '../../../shared/types'

/**
 * 消息实体的规范 payload（shared/contracts/schemas/message-payload.schema.json，
 * additionalProperties=false，因此只放 schema 允许的字段）。
 *
 * 为可测性加 `export`（**不改任何行为**）：跨端 sync-payload golden 直接以这个函数为 oracle，
 * 否则 Android 侧只能对着抄一份规则，抄错了也没人发现——阶段 5 给其余 payload 构造函数
 * 加 export 是同一个理由。
 */
export function messageEntityPayload(message: Message): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    sessionId: message.sessionId,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
  }
  if (typeof message.characterId === 'string' || message.characterId === null) {
    payload.characterId = message.characterId
  }
  for (const key of ['speakerKind', 'generationKind', 'narrativeMode'] as const) {
    if (typeof message[key] === 'string') payload[key] = message[key]
  }
  if (Array.isArray(message.swipes)) payload.swipes = message.swipes
  if (typeof message.swipeIndex === 'number') payload.swipeIndex = message.swipeIndex
  if (typeof message.replyToId === 'string' || message.replyToId === null) {
    payload.replyToId = message.replyToId
  }
  return payload
}

/** 会话实体的规范 payload（与阶段 1 冻结的 session 契约字段一致） */
export function sessionEntityPayload(characterId: string, session: ChatSession): Record<string, unknown> {
  return {
    characterId,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    personaId: session.personaId ?? null,
    lorebookIds: session.lorebookIds ?? [],
    narrativeMode: session.narrativeMode ?? null,
  }
}