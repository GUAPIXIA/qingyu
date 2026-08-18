/**
 * 桥接层会话索引：跨角色扫描会话，建立 sessionId -> characterId 映射。
 * 数据源为 DIRS.chats() 下各角色目录的 sessions.json（与渲染层 IPC 同一存储）。
 */
import { readdirSync } from 'node:fs'
import { DIRS } from '../services/storage'
import { chatData } from '../ipc/chat'
import type { SessionPreview } from '../../shared/types'

/** 携带所属角色的会话预览 */
export interface SessionWithCharacter extends SessionPreview {
  characterId: string
}

/** 内存索引：sessionId -> characterId（listAllSessions 时刷新） */
const sessionIndex = new Map<string, string>()

/** 扫描全部角色的会话（含消息统计），并刷新内存索引 */
export async function listAllSessions(): Promise<SessionWithCharacter[]> {
  const chatRoot = DIRS.chats()
  let dirs: string[] = []
  try {
    dirs = readdirSync(chatRoot)
  } catch {
    return []
  }
  const result: SessionWithCharacter[] = []
  sessionIndex.clear()
  for (const dir of dirs) {
    // 角色目录名 = characterId（仅安全字符）
    if (!/^[a-zA-Z0-9_-]+$/.test(dir)) continue
    try {
      const sessions = await chatData.listSessions(dir)
      for (const s of sessions) {
        result.push({ ...s, characterId: dir })
        sessionIndex.set(s.id, dir)
      }
    } catch {
      // 跳过坏目录（无 sessions.json 等）
    }
  }
  return result
}

/** 按会话 id 反查所属角色 */
export async function findSessionById(sessionId: string): Promise<SessionWithCharacter | null> {
  const characterId = sessionIndex.get(sessionId)
  if (characterId) {
    const sessions = await chatData.listSessions(characterId)
    const session = sessions.find((s) => s.id === sessionId)
    if (session) return { ...session, characterId }
  }
  const all = await listAllSessions()
  return all.find((s) => s.id === sessionId) ?? null
}

/** 按角色 + 会话 ID 精确定位；供客户端传入 characterId 消除旧数据同名会话的歧义。 */
export async function findSessionByCharacterId(
  characterId: string,
  sessionId: string,
): Promise<SessionWithCharacter | null> {
  const sessions = await chatData.listSessions(characterId)
  const session = sessions.find((item) => item.id === sessionId)
  return session ? { ...session, characterId } : null
}
