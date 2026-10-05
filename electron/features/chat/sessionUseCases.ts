/**
 * 主进程聊天会话用例（阶段 3A-2：从 electron/ipc/chat.ts 的 handler 与数据门面原样迁出）。
 *
 * 职责：会话列表/创建/重命名/更新/删除/清空、长记忆字段维护与历史归档、
 * 空间绑定与画板助手会话关联。删除与会话生命周期通知仍通过现有 `chatLifecycle` 协作。
 *
 * 迁移约束（方案 §4 阶段 3）：先原样搬移、保持调用时序——锁范围、事务/journal、
 * 缓存失效时机与旧实现一致。参数边界（safeId、对象形状校验）由 IPC handler 与
 * `chatData` 门面负责，本层信任调用方；`withSessionsLock` 等内部仍保留原有校验。
 */
import { join } from 'node:path'
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { nanoid } from 'nanoid'
import { DIRS, withFileLock } from '../../services/storage'
import { notifyChatSpatialSourceChanged, prepareChatSessionDeletion } from '../../services/chatLifecycle'
import { createLogger } from '../../services/logger'
import { commitThroughDomain } from '../../domain/syncDomainService'
import type { ChatSession, MemoryFactRecord, SessionPreview } from '../../../shared/types'
import {
  cleanSessionUpdates,
  computeMessageMetaCached,
  createDefaultSession,
  getChatDir,
  getDefaultMemoryConfig,
  getDefaultNarrativeMode,
  getDefaultPersonaId,
  getSessionFile,
  journalTrashedChatData,
  loadSessions,
  mergeSessionUpdates,
  messagesCacheInvalidate,
  migrateOldData,
  readMessages,
  saveSessions,
  withSessionFileLock,
  withSessionsLock,
} from './chatRepository'

const log = createLogger('chat')

/**
 * 会话列表（含消息数与最后消息摘要；无会话时自动创建默认会话）。
 *
 * `sortByUpdatedAt`：IPC handler 路径按 updatedAt 倒序（渲染层列表语义）；
 * `chatData` 门面沿袭原有未排序行为（干净目录迁移不做行为改写，
 * 其消费者按 id 查找，仅 mainContextProvider 的 `sessions[0]` 回退依赖文件序）。
 */
export async function listSessions(
  characterId: string,
  opts?: { sortByUpdatedAt?: boolean },
): Promise<SessionPreview[]> {
  return withSessionsLock(characterId, () => {
    // 迁移旧数据（NEW-M3：在锁内执行，避免与并发会话写操作竞态）
    migrateOldData(characterId)
    const sessions = loadSessions(characterId)

    // 如果没有会话，自动创建一个默认会话
    if (sessions.length === 0) {
      const defaultSession = createDefaultSession(characterId)
      sessions.push(defaultSession)
      saveSessions(characterId, sessions)
    }

    // 优化：只读 messages 文件统计 count 和 lastMessage
    // P2 修复：mtime+size 缓存复用，文件未变时不再全量字节扫描
    const previews = sessions.map(s => {
      const meta = computeMessageMetaCached(characterId, s.id)
      return {
        ...s,
        messageCount: meta.count,
        lastMessage: meta.lastMessage,
      } as SessionPreview
    })
    return opts?.sortByUpdatedAt ? previews.sort((a, b) => b.updatedAt - a.updatedAt) : previews
  })
}

export async function createSession(
  characterId: string,
  title?: string,
  personaId?: string | null,
  lorebookIds?: string[],
): Promise<ChatSession> {
  return withSessionsLock(characterId, () => {
    const sessions = loadSessions(characterId)
    const now = Date.now()
    // 未指定 personaId 时继承默认身份
    const effectivePersonaId = personaId !== undefined ? personaId : getDefaultPersonaId()
    const session: ChatSession = {
      id: nanoid(),
      characterId,
      title: title || `新对话 ${sessions.length + 1}`,
      createdAt: now,
      updatedAt: now,
      ...getDefaultMemoryConfig(characterId),
      memory: '',
      memoryUpdatedAt: 0,
      personaId: effectivePersonaId,
      lorebookIds,
      narrativeMode: getDefaultNarrativeMode(characterId),
    }
    sessions.push(session)
    saveSessions(characterId, sessions)
    log.info('会话已创建', { characterId, sessionId: session.id, title: session.title })
    return session
  })
}

export async function deleteSession(characterId: string, sessionId: string): Promise<void> {
  await prepareChatSessionDeletion({ characterId, sessionId })
  // R1 修复：删除消息文件前先获取消息文件锁（与 saveMessage/deleteMessage 锁序一致：
  // 消息锁 → sessions 锁），避免与并发写入竞态导致"删除后文件被重建/读到半删状态"
  await withSessionFileLock(characterId, sessionId, () => {
    const filePath = getSessionFile(characterId, sessionId)
    if (existsSync(filePath)) {
      // 阶段 2 S2-04：删除会话文件前先为其中每条消息写 tombstone（同一事务内删文件）
      const messages = readMessages(characterId, sessionId, true)
      commitThroughDomain({
        domain: 'message',
        entityType: 'message',
        puts: [],
        deletes: messages.map((m) => ({ entityId: m.id, parentId: sessionId })),
        files: [{ path: filePath, content: null }],
      })
    }
    // P-6：失效该会话的读取缓存
    messagesCacheInvalidate(characterId, sessionId)
  })
  // 从 sessions.json 中移除
  return withSessionsLock(characterId, () => {
    const sessions = loadSessions(characterId).filter(s => s.id !== sessionId)
    saveSessions(characterId, sessions)
    log.info('会话已删除', { characterId, sessionId })
  })
}

export async function renameSession(characterId: string, sessionId: string, title: string): Promise<void> {
  // F2 修复：会话不存在时必须报错。此前 `if (session)` 无 else，外部调用方会拿到“成功”却什么都没发生。
  if (typeof title !== 'string') throw new Error('参数无效：title 必须为字符串')
  return withSessionsLock(characterId, () => {
    const sessions = loadSessions(characterId)
    const session = sessions.find(s => s.id === sessionId)
    if (!session) throw new Error('会话不存在')
    session.title = title
    session.titleRevision = (session.titleRevision ?? 0) + 1
    session.updatedAt = Date.now()
    saveSessions(characterId, sessions)
  })
}

/** 更新会话字段（白名单过滤；与旧 chatData.updateSession 同一路径） */
export async function updateSession(
  characterId: string,
  sessionId: string,
  updates: Partial<ChatSession>,
): Promise<ChatSession> {
  const clean = cleanSessionUpdates(updates)
  const updated = await withSessionsLock(characterId, () => {
    const sessions = loadSessions(characterId)
    const idx = sessions.findIndex((s) => s.id === sessionId)
    if (idx === -1) throw new Error('会话不存在')
    sessions[idx] = mergeSessionUpdates(sessions[idx]!, clean)
    saveSessions(characterId, sessions)
    return sessions[idx]
  })
  notifyChatSpatialSourceChanged({ characterId, sessionId })
  return updated
}

export async function updateMemory(characterId: string, sessionId: string, memory: string): Promise<void> {
  await withSessionsLock(characterId, () => {
    const sessions = loadSessions(characterId)
    const session = sessions.find((s) => s.id === sessionId)
    if (session) {
      session.memory = memory
      session.memoryUpdatedAt = Date.now()
      session.updatedAt = Date.now()
      saveSessions(characterId, sessions)
    }
  })
}

export async function toggleMemory(characterId: string, sessionId: string, enabled: boolean): Promise<void> {
  await withSessionsLock(characterId, () => {
    const sessions = loadSessions(characterId)
    const session = sessions.find((s) => s.id === sessionId)
    if (session) {
      session.memoryEnabled = enabled
      session.updatedAt = Date.now()
      saveSessions(characterId, sessions)
    }
  })
}

export async function setMemoryMode(
  characterId: string,
  sessionId: string,
  mode: 'manual' | 'auto',
  interval?: number,
): Promise<void> {
  await withSessionsLock(characterId, () => {
    const sessions = loadSessions(characterId)
    const session = sessions.find((s) => s.id === sessionId)
    if (session) {
      session.memoryMode = mode
      if (interval !== undefined) session.autoMemoryInterval = interval
      session.updatedAt = Date.now()
      saveSessions(characterId, sessions)
    }
  })
}

export async function getMemoryHistory(
  characterId: string,
  sessionId: string,
  opts?: { limit?: number; offset?: number; status?: string },
): Promise<{ history: MemoryFactRecord[]; total: number }> {
  const limit = Math.min(Math.max(Number(opts?.limit) || 50, 1), 200)
  const offset = Math.max(Number(opts?.offset) || 0, 0)
  const status = typeof opts?.status === 'string' ? opts?.status : 'all'
  return withSessionsLock(characterId, () => {
    const sessions = loadSessions(characterId)
    const session = sessions.find((s) => s.id === sessionId)
    if (!session) throw new Error('会话不存在')
    let history = session.memoryFactHistory ?? []
    if (status !== 'all') {
      history = history.filter((h) => h.status === status)
    }
    const total = history.length
    const sliced = history.slice(offset, offset + limit)
    return { history: sliced, total }
  })
}

/**
 * 清空对话（IPC handler 路径）：删除消息文件 + 同步重置 session 元数据
 * 修复 #48: 删除消息文件后，session 仍存在但 messageCount 应为 0。
 * 未指定 sessionId 时清空整个角色的全部对话。
 */
export async function clearChat(characterId: string, sessionId?: string): Promise<void> {
  if (sessionId) {
    // R1 修复：清空指定 session 前先获取消息文件锁（锁序与 saveMessage 一致），
    // 避免与并发写入竞态导致文件被重建或读到半删状态
    await withSessionFileLock(characterId, sessionId, () => {
      const filePath = getSessionFile(characterId, sessionId)
      if (existsSync(filePath)) {
        // 阶段 2 S2-04：清空对话同样要为消息写 tombstone
        const messages = readMessages(characterId, sessionId, true)
        commitThroughDomain({
          domain: 'message',
          entityType: 'message',
          puts: [],
          deletes: messages.map((m) => ({ entityId: m.id, parentId: sessionId })),
          files: [{ path: filePath, content: null }],
        })
      }
      // P-6：失效该会话的读取缓存
      messagesCacheInvalidate(characterId, sessionId)
    })
    // 重置 session 元数据
    return withSessionsLock(characterId, () => {
      const sessions = loadSessions(characterId)
      const session = sessions.find(s => s.id === sessionId)
      if (session) {
        session.updatedAt = Date.now()
        // 重置长记忆（清空对话时一并清除历史摘要）
        session.memory = ''
        session.memoryCurrentState = ''
        session.memoryUpdatedAt = 0
        session.memoryFacts = []
        session.memoryFactHistory = []
        session.memoryFactParseFailureCount = 0
        session.memoryFactRetryAfterVersion = 0
        session.factsVectors = []
        session.memoryLastMessageId = null
        session.memoryVersion = 0
        session.factsVectorVersion = 0
        session.compressedSummary = null
        session.compressedRange = null
        saveSessions(characterId, sessions)
      }
    })
  }
  // 清空整个角色的所有对话
  const dir = getChatDir(characterId)
  if (!existsSync(dir)) return
  // NEW-2 修复：先对目录下现有文件排队加锁（与 saveMessage/deleteMessage 等写操作互斥），
  // 再 rename 到临时目录后删除——rename 后新写入会重建目录，不会写入即将删除的目录
  const files = readdirSync(dir).map((f) => join(dir, f))
  await Promise.all(files.map((f) => withFileLock(f, () => {})))
  const trashDir = join(DIRS.chats(), `.deleting-${characterId}-${Date.now()}`)
  // sync-bypass-ok: 目录级回收站改名（不改变业务数据语义；实体 tombstone 由 journalTrashedChatData 记账）
  renameSync(dir, trashDir)
  // 阶段 2 S2-04：为回收站中的会话与消息写 tombstone，并删除对应文件
  journalTrashedChatData(characterId, trashDir)
  rmSync(trashDir, { recursive: true, force: true })
  // P-6：失效该角色的全部读取缓存
  messagesCacheInvalidate(characterId)
}

/** 空间事务恢复只修改绑定，保留其他会话更新。 */
export async function updateSpatialBindingIfMatches(
  characterId: string, sessionId: string,
  before: { worldId: string | null; runtimeId: string | null },
  after: { worldId: string | null; runtimeId: string | null },
): Promise<void> {
  await withSessionsLock(characterId, () => {
    const sessions = loadSessions(characterId)
    const session = sessions.find((item) => item.id === sessionId)
    if (!session) throw new Error('会话不存在')
    const worldId = session.spatialWorldId ?? null
    const runtimeId = session.spatialRuntimeId ?? null
    if (worldId === after.worldId && runtimeId === after.runtimeId) return
    if (worldId !== before.worldId || runtimeId !== before.runtimeId) throw new Error('空间绑定已改变，停止事务恢复')
    session.spatialWorldId = after.worldId
    session.spatialRuntimeId = after.runtimeId
    session.updatedAt = Date.now()
    saveSessions(characterId, sessions)
  })
}

/** 仅当磁盘中的 memoryVersion 仍等于 expectedVersion 时应用更新。 */
export async function attachSpatialAiSession(
  characterId: string, sessionId: string,
  expected: { worldId: string | null; runtimeId: string | null; aiSessionId: string | null }, aiSessionId: string,
): Promise<void> {
  await withSessionsLock(characterId, () => {
    const sessions = loadSessions(characterId)
    const session = sessions.find(item => item.id === sessionId)
    if (!session || (session.spatialWorldId ?? null) !== expected.worldId ||
      (session.spatialRuntimeId ?? null) !== expected.runtimeId || (session.spatialAiSessionId ?? null) !== expected.aiSessionId) {
      throw new Error('画板助手关联范围已改变')
    }
    session.spatialAiSessionId = aiSessionId
    saveSessions(characterId, sessions)
  })
}