/**
 * 会话查找辅助（本地 PC 聊天）。
 *
 * 从旧 bridge/sessionsIndex.ts 抽出：仅保留 messagePort.ts 使用的
 * findSessionById / findSessionByCharacterId / listAllSessions。
 * 旧伴侣 /api/v1 会话索引已随 S9-07 删除。
 */
import { chatData } from '../features/chat/chatData'
import { listCharacters } from '../services/charCard'
import type { SessionPreview } from '../../shared/types'

export async function listAllSessions(): Promise<SessionPreview[]> {
  const characters = await listCharacters()
  const all: SessionPreview[] = []
  for (const c of characters) {
    const sessions = await chatData.listSessions(c.id)
    all.push(...sessions)
  }
  return all
}

export async function findSessionById(sessionId: string): Promise<SessionPreview | null> {
  const all = await listAllSessions()
  return all.find((s) => s.id === sessionId) ?? null
}

export async function findSessionByCharacterId(characterId: string, sessionId: string): Promise<SessionPreview | null> {
  const sessions = await chatData.listSessions(characterId)
  return sessions.find((s) => s.id === sessionId) ?? null
}
