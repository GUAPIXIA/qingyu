import { upsertCompressionCache } from '../../shared/chat-core/lorebook'
import { isFeatureTaskCancelled } from '../services/featureTaskLifecycle'
import { assertFeatureCommit, matchesFeatureSource, compressionVersion, type FeatureCommit, type FeatureSource } from '../../shared/featureSource'
import type { IpcMain } from 'electron'
import { join } from 'node:path'
import { existsSync, readdirSync, renameSync, rmSync, unlinkSync } from 'node:fs'
import { DIRS, readJson, withFileLock } from '../services/storage'
import { prepareChatSessionDeletion, notifyChatSpatialSourceChanged } from '../services/chatLifecycle'
import { exportSessionJson, exportSessionMarkdown } from '../../shared/chat-core/sessionExport'
import type { Message, ChatSession, SessionPreview } from '../../shared/types'
import type { Settings } from '../../shared/types'
import { nanoid } from 'nanoid'
import { safeId } from '../utils/pathGuard'
import { safeHandle } from '../utils/safeHandle'
import { withMessageIdentity } from '../../shared/messageIdentity'
import { commitThroughDomain } from '../domain/syncDomainService'
import { createLogger } from '../services/logger'
import {
  SETTINGS_FILE,
  appendMessage,
  cleanSessionUpdates,
  compactSessionFile,
  computeMessageMetaCached,
  consumePendingCompaction,
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
  messagesCacheSet,
  migrateOldData,
  readMessages,
  resetAppendCount,
  saveSessions,
  updateMessage,
  updateSessionIfMemoryVersion,
  withChatMessageLock,
  withSessionFileLock,
  withSessionsLock,
  writeMessages,
} from '../features/chat/chatRepository'

const log = createLogger('chat')

async function commitFeatureResult(characterId: string, sessionId: string, input: FeatureCommit): Promise<boolean> {
  safeId(characterId); safeId(sessionId); assertFeatureCommit(input)
  return withSessionFileLock(characterId, sessionId, () => withSessionsLock(characterId, () => {
    if (isFeatureTaskCancelled(input.taskId)) return false
    const sessions = loadSessions(characterId)
    const session = sessions.find(item => item.id === sessionId)
    if (!session) return false

    if (input.feature === 'lorebook_compression') {
      session.lorebookCompressionCache = upsertCompressionCache(session.lorebookCompressionCache, input.cacheKey, input.entry)
      saveSessions(characterId, sessions)
      return true
    }
    const messages = readMessages(characterId, sessionId)
    if (!matchesFeatureSource(input.source, messages, session)) return false
    if (input.feature === 'translation' || input.feature === 'direction') {
      const message = messages.find(item => item.id === input.messageId)
      if (!message || !input.source.messages.some(ref => ref.id === message.id)) return false
      if (message.featureTaskIds?.[input.feature] === input.taskId) return true
      if (input.feature === 'translation') {
        const language = readJson<Settings>(SETTINGS_FILE())?.translationTargetLang || '中文'
        if (language !== input.language) return false
        updateMessage(characterId, sessionId, { ...message, translation: input.text, translationLanguage: input.language,
          translationSource: input.source, featureTaskIds: { ...message.featureTaskIds, translation: input.taskId },
           })
      } else {
        updateMessage(characterId, sessionId, { ...message, dialogueDirections: input.directions,
          dialogueDirectionsGeneratedAt: Date.now(), dialogueDirectionsSource: input.directions.length ? input.source : null, featureTaskIds: { ...message.featureTaskIds, direction: input.taskId } })
      }
      return true
    }
    if (session.featureTaskIds?.[input.feature] === input.taskId) return true
    if (input.feature === 'title') {
      if (session.title !== input.expectedTitle || session.titleGenerated) return false
      session.title = input.text.trim().slice(0, 20)
      session.titleRevision = (session.titleRevision ?? 0) + 1
      session.titleGenerated = true
    } else {
      if (compressionVersion(session) !== input.expectedCompression || !input.source.range || JSON.stringify(input.range) !== JSON.stringify(input.source.range)) return false
      session.compressedSummary = input.text
      session.compressedRange = input.range
      session.compressedSource = input.source
    }
    session.featureTaskIds = { ...session.featureTaskIds, [input.feature]: input.taskId }
    session.updatedAt = Date.now()
    saveSessions(characterId, sessions)
    return true
  }))
}

export function registerChatIPC(ipcMain: IpcMain): void {
  safeHandle(ipcMain, 'chat:commitFeatureResult', async (_e, characterId: string, sessionId: string, input: FeatureCommit) => commitFeatureResult(characterId, sessionId, input))
  // ===== 会话管理 =====

  safeHandle(ipcMain, 'chat:listSessions', async (_e, characterId: string) => {
    safeId(characterId)

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
      return sessions.map(s => {
        const meta = computeMessageMetaCached(characterId, s.id)
        return {
          ...s,
          messageCount: meta.count,
          lastMessage: meta.lastMessage,
        } as SessionPreview
      }).sort((a, b) => b.updatedAt - a.updatedAt)
    })
  })

  safeHandle(ipcMain, 'chat:createSession', async (_e, characterId: string, title?: string, personaId?: string | null, lorebookIds?: string[]) => {
    safeId(characterId)
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
  })

  safeHandle(ipcMain, 'chat:deleteSession', async (_e, characterId: string, sessionId: string) => {
    safeId(characterId)
    safeId(sessionId)
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
  })

  safeHandle(ipcMain, 'chat:renameSession', async (_e, characterId: string, sessionId: string, title: string) => {
    safeId(characterId)
    safeId(sessionId)
    return withSessionsLock(characterId, () => {
      const sessions = loadSessions(characterId)
      const session = sessions.find(s => s.id === sessionId)
      if (session) {
        session.title = title
        session.titleRevision = (session.titleRevision ?? 0) + 1
        session.updatedAt = Date.now()
        saveSessions(characterId, sessions)
      }
    })
  })

  safeHandle(ipcMain, 'chat:updateSession', async (_e, characterId: string, sessionId: string, updates: Partial<ChatSession>) => {
    safeId(characterId)
    safeId(sessionId)
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      throw new Error('参数无效：updates 必须为对象')
    }
    return chatData.updateSession(characterId, sessionId, updates)
  })

  safeHandle(ipcMain, 'chat:updateSessionIfMemoryVersion', async (_e, characterId: string, sessionId: string, expectedVersion: number, updates: Partial<ChatSession>, source?: FeatureSource) =>
    updateSessionIfMemoryVersion(characterId, sessionId, expectedVersion, updates, source))

  // ===== 消息管理 =====

  safeHandle(ipcMain, 'chat:listMessages', async (_e, characterId: string, sessionId?: string) => {
    safeId(characterId)
    if (sessionId) safeId(sessionId)
    // 迁移旧数据（NEW-M3：持锁执行，避免与并发会话写操作竞态）
    await withSessionsLock(characterId, () => { migrateOldData(characterId) })

    // 确定 sessionId
    let sid = sessionId
    if (!sid) {
      const sessions = loadSessions(characterId)
      sid = sessions[0]?.id ?? 'default'
    }

    // P-8 compact：追加覆盖次数超阈值时，在消息文件锁内去重重写
    // （锁序：sessions 锁已释放 → 再拿消息锁，与 saveMessage 的"消息锁→sessions 锁"不冲突）
    if (consumePendingCompaction(characterId, sid)) {
      await compactSessionFile(characterId, sid)
    }
    return readMessages(characterId, sid)
  })

  /**
   * 保存消息（新增或更新）
   * 优化：仅更新 session 的 updatedAt，不每次都计算 messageCount
   *      messageCount 在 listSessions 时按需计算
   */
  safeHandle(ipcMain, 'chat:saveMessage', async (_e, message: Message) => {
    safeId(message.characterId)
    const sid = message.sessionId || 'default'
    safeId(sid)

    // L-05 修复：updateMessage 返回是否为新消息，消除重复读取
    // BUG-10 修复：消息文件写入与删除等操作通过 per-file 锁串行化
    const normalizedMessage = withMessageIdentity(message)
    await withSessionFileLock(message.characterId, sid, () => {
      updateMessage(message.characterId, sid, normalizedMessage)
    })

    // 增量更新 session 的 updatedAt（只重写 sessions.json，不重读 messages）
    await withSessionsLock(message.characterId, () => {
      const sessions = loadSessions(message.characterId)
      const session = sessions.find(s => s.id === sid)
      if (session) {
        session.updatedAt = Date.now()
        saveSessions(message.characterId, sessions)
      }
    })
  })

  safeHandle(ipcMain, 'chat:deleteMessage', async (_e, { id, characterId, sessionId }: { id: string; characterId: string; sessionId?: string }) => {
    safeId(characterId)
    const sid = sessionId || 'default'
    safeId(sid)
    safeId(id)
    // BUG-10 修复：读-改-写整体持锁，避免全量重写覆盖并发追加的消息
    await withSessionFileLock(characterId, sid, () => {
      const messages = readMessages(characterId, sid)
      const filtered = messages.filter((m) => m.id !== id)
      writeMessages(characterId, sid, filtered)
      // P-6：同步更新读取缓存（readMessages 已保证缓存存在）
      messagesCacheSet(characterId, sid, filtered)
      notifyChatSpatialSourceChanged({ characterId, sessionId: sid })
      // P-8：全量重写后重置追加计数
      resetAppendCount(characterId, sid)
    })
    // 同步 session updatedAt
    await withSessionsLock(characterId, () => {
      const sessions = loadSessions(characterId)
      const session = sessions.find(s => s.id === sid)
      if (session) {
        session.updatedAt = Date.now()
        saveSessions(characterId, sessions)
      }
    })
  })

  /**
   * 清空对话：删除消息文件 + 同步重置 session 元数据
   * 修复 #48: 删除消息文件后，session 仍存在但 messageCount 应为 0
   */
  safeHandle(ipcMain, 'chat:clearChat', async (_e, characterId: string, sessionId?: string) => {
    safeId(characterId)
    if (sessionId) {
      safeId(sessionId)
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
    } else {
      // 清空整个角色的所有对话
      const dir = getChatDir(characterId)
      if (existsSync(dir)) {
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
    }
  })

  // 导出对话
  safeHandle(ipcMain, 'chat:exportChat', async (_e, characterId: string, sessionId: string, format: 'md' | 'json') => {
    safeId(characterId)
    safeId(sessionId)
    const messages = readMessages(characterId, sessionId)
    // 导出逻辑已抽到 shared/chat-core/sessionExport.ts：Android 侧消费**同一份**实现，
    // 保证同一会话在两端导出得到同一个文件（阶段 4 S4-04）。
    if (format === 'json') {
      return exportSessionJson(messages as unknown as Array<Record<string, unknown>>)
    }
    return exportSessionMarkdown(messages)
  })

  // ===== 长记忆 =====

  safeHandle(ipcMain, 'chat:updateMemory', async (_e, characterId: string, sessionId: string, memory: string) => {
    safeId(characterId)
    safeId(sessionId)
    return withSessionsLock(characterId, () => {
      const sessions = loadSessions(characterId)
      const session = sessions.find(s => s.id === sessionId)
      if (session) {
        session.memory = memory
        session.memoryUpdatedAt = Date.now()
        session.updatedAt = Date.now()
        saveSessions(characterId, sessions)
      }
    })
  })

  safeHandle(ipcMain, 'chat:toggleMemory', async (_e, characterId: string, sessionId: string, enabled: boolean) => {
    safeId(characterId)
    safeId(sessionId)
    return withSessionsLock(characterId, () => {
      const sessions = loadSessions(characterId)
      const session = sessions.find(s => s.id === sessionId)
      if (session) {
        session.memoryEnabled = enabled
        session.updatedAt = Date.now()
        saveSessions(characterId, sessions)
      }
    })
  })

  safeHandle(ipcMain, 'chat:setMemoryMode', async (_e, characterId: string, sessionId: string, mode: 'manual' | 'auto', interval?: number) => {
    safeId(characterId)
    safeId(sessionId)
    return withSessionsLock(characterId, () => {
      const sessions = loadSessions(characterId)
      const session = sessions.find(s => s.id === sessionId)
      if (session) {
        session.memoryMode = mode
        if (interval !== undefined) session.autoMemoryInterval = interval
        session.updatedAt = Date.now()
        saveSessions(characterId, sessions)
      }
    })
  })

  safeHandle(ipcMain, 'chat:getStats', async (_e, characterId: string, sessionId: string) => {
    safeId(characterId)
    safeId(sessionId)
    const messages = readMessages(characterId, sessionId)
    let totalChars = 0
    let userMsgs = 0
    let assistantMsgs = 0
    let firstTime = 0
    let lastTime = 0

    for (const msg of messages) {
      totalChars += (msg.content || '').length
      if (msg.role === 'user') userMsgs++
      else if (msg.role === 'assistant') assistantMsgs++
      if (!firstTime || msg.timestamp < firstTime) firstTime = msg.timestamp
      if (!lastTime || msg.timestamp > lastTime) lastTime = msg.timestamp
    }

    const durationMs = lastTime - firstTime
    const durationMinutes = Math.floor(durationMs / 60000)
    const durationStr = durationMinutes >= 60
      ? `${Math.floor(durationMinutes / 60)}小时${durationMinutes % 60}分钟`
      : `${durationMinutes}分钟`

    return {
      totalMessages: messages.length,
      userMessages: userMsgs,
      assistantMessages: assistantMsgs,
      totalChars,
      firstMessageTime: firstTime,
      lastMessageTime: lastTime,
      durationMs,
      durationStr,
    }
  })

  // ===== 长记忆历史归档（只读，不参与上下文注入） =====
  safeHandle(ipcMain, 'chat:getMemoryHistory', async (_e, characterId: string, sessionId: string, opts?: { limit?: number; offset?: number; status?: string }) => {
    safeId(characterId)
    safeId(sessionId)
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
  })
}

// ============================================================================
// 数据层门面（阶段 0a：ContextDataWriter 与桥接层复用，方案「安卓伴侣端方案」§7）
// ============================================================================
// 与上方 IPC handler 共用同一底层存储函数与锁（appendMessage / loadSessions /
// saveSessions / withSessionFileLock / withSessionsLock / writeMessages /
// messagesCacheSet / resetAppendCount / migrateOldData / createDefaultSession /
// computeMessageMetaCached / consumePendingCompaction / compactSessionFile），
// 保证 JSONL 格式与版本号字段一致（双端写入互操作，方案 §7 0a 验收）。

/** 消息删除结果（供上层判断会话是否存在） */
export interface ChatDataResult {
  ok: boolean
}

/** 数据层门面：主进程侧读写会话/消息的统一入口（不含任何 IPC 依赖） */
export const chatData = {
  commitFeatureResult,
  readMessages,

  /** 会话列表（含消息数与最后消息摘要；无会话时自动创建默认会话） */
  listSessions: async (characterId: string): Promise<SessionPreview[]> => {
    safeId(characterId)
    return withSessionsLock(characterId, () => {
      migrateOldData(characterId)
      const sessions = loadSessions(characterId)
      if (sessions.length === 0) {
        const defaultSession = createDefaultSession(characterId)
        sessions.push(defaultSession)
        saveSessions(characterId, sessions)
      }
      return sessions.map((s) => {
        const meta = computeMessageMetaCached(characterId, s.id)
        return { ...s, messageCount: meta.count, lastMessage: meta.lastMessage }
      })
    })
  },

  /** 追加/覆盖单条消息（与渲染层 saveMessage 同一落盘路径） */
  saveMessage: (characterId: string, message: Message): void => {
    appendMessage(characterId, message.sessionId, withMessageIdentity(message))
  },
  saveMessageLocked: (characterId: string, message: Message): Promise<void> =>
    withChatMessageLock({ characterId, sessionId: message.sessionId }, () => appendMessage(characterId, message.sessionId, withMessageIdentity(message))),

  /** 删除单条消息（与 IPC handler 相同的读-改-写锁路径） */
  deleteMessage: async (
    characterId: string,
    messageId: string,
    sessionId?: string,
  ): Promise<void> => {
    safeId(characterId)
    const sid = sessionId || 'default'
    safeId(sid)
    safeId(messageId)
    await withSessionFileLock(characterId, sid, () => {
      const messages = readMessages(characterId, sid)
      const filtered = messages.filter((m) => m.id !== messageId)
      writeMessages(characterId, sid, filtered)
      messagesCacheSet(characterId, sid, filtered)
      notifyChatSpatialSourceChanged({ characterId, sessionId: sid })
      resetAppendCount(characterId, sid)
    })
    await withSessionsLock(characterId, () => {
      const sessions = loadSessions(characterId)
      const session = sessions.find((s) => s.id === sid)
      if (session) {
        session.updatedAt = Date.now()
        saveSessions(characterId, sessions)
      }
    })
  },

  /** 重命名会话（与 IPC handler 同一路径） */
  renameSession: async (characterId: string, sessionId: string, title: string): Promise<void> => {
    safeId(characterId)
    safeId(sessionId)
    await withSessionsLock(characterId, () => {
      const sessions = loadSessions(characterId)
      const session = sessions.find((s) => s.id === sessionId)
      if (session) {
        session.title = title
        session.titleRevision = (session.titleRevision ?? 0) + 1
        session.updatedAt = Date.now()
        saveSessions(characterId, sessions)
      }
    })
  },

  /** 创建会话（与 IPC handler 同一路径，含默认身份继承） */
  createSession: async (
    characterId: string,
    title?: string,
    personaId?: string | null,
    lorebookIds?: string[],
  ): Promise<ChatSession> => {
    safeId(characterId)
    return withSessionsLock(characterId, () => {
      const sessions = loadSessions(characterId)
      const now = Date.now()
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
      log.info('会话已创建（数据层门面）', { characterId, sessionId: session.id })
      return session
    })
  },

  /** 更新记忆摘要（与 IPC handler 同一路径） */
  updateMemory: async (characterId: string, sessionId: string, memory: string): Promise<void> => {
    safeId(characterId)
    safeId(sessionId)
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
  },

  /** 开关长记忆（与 IPC handler 同一路径） */
  toggleMemory: async (characterId: string, sessionId: string, enabled: boolean): Promise<void> => {
    safeId(characterId)
    safeId(sessionId)
    await withSessionsLock(characterId, () => {
      const sessions = loadSessions(characterId)
      const session = sessions.find((s) => s.id === sessionId)
      if (session) {
        session.memoryEnabled = enabled
        session.updatedAt = Date.now()
        saveSessions(characterId, sessions)
      }
    })
  },

  /** 设置记忆模式（与 IPC handler 同一路径） */
  setMemoryMode: async (
    characterId: string,
    sessionId: string,
    mode: 'manual' | 'auto',
    interval?: number,
  ): Promise<void> => {
    safeId(characterId)
    safeId(sessionId)
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
  },

  /** 更新会话字段（白名单过滤，与 IPC handler chat:updateSession 同一路径） */
  updateSession: async (
    characterId: string,
    sessionId: string,
    updates: Partial<ChatSession>,
  ): Promise<ChatSession> => {
    safeId(characterId)
    safeId(sessionId)
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      throw new Error('参数无效：updates 必须为对象')
    }
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
  },

  /** 空间事务恢复只修改绑定，保留其他会话更新。 */
  updateSpatialBindingIfMatches: async (
    characterId: string, sessionId: string,
    before: { worldId: string | null; runtimeId: string | null },
    after: { worldId: string | null; runtimeId: string | null },
  ): Promise<void> => {
    safeId(characterId)
    safeId(sessionId)
    if (after.worldId) safeId(after.worldId)
    if (after.runtimeId) safeId(after.runtimeId)
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
  },

  /** 仅当磁盘中的 memoryVersion 仍等于 expectedVersion 时应用更新。 */
  attachSpatialAiSession: async (characterId: string, sessionId: string,
    expected: { worldId: string | null; runtimeId: string | null; aiSessionId: string | null }, aiSessionId: string): Promise<void> => {
    safeId(aiSessionId)
    await withSessionsLock(safeId(characterId), () => {
      const sessions = loadSessions(characterId)
      const session = sessions.find(item => item.id === safeId(sessionId))
      if (!session || (session.spatialWorldId ?? null) !== expected.worldId ||
        (session.spatialRuntimeId ?? null) !== expected.runtimeId || (session.spatialAiSessionId ?? null) !== expected.aiSessionId) {
        throw new Error('画板助手关联范围已改变')
      }
      session.spatialAiSessionId = aiSessionId
      saveSessions(characterId, sessions)
    })
  },

  updateSessionIfMemoryVersion,

  /** 清空指定会话消息（与 IPC handler chat:clearChat 同一路径：消息锁→sessions 锁） */
  clearChat: async (characterId: string, sessionId: string): Promise<void> => {
    safeId(characterId)
    safeId(sessionId)
    await withSessionFileLock(characterId, sessionId, () => {
      const filePath = getSessionFile(characterId, sessionId)
      if (existsSync(filePath)) unlinkSync(filePath)
      messagesCacheInvalidate(characterId, sessionId)
    })
    await withSessionsLock(characterId, () => {
      const sessions = loadSessions(characterId)
      const session = sessions.find((s) => s.id === sessionId)
      if (session) {
        session.updatedAt = Date.now()
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
  },

  /** 删除会话（与 IPC handler chat:deleteSession 同一路径：删消息文件 + 从 sessions.json 移除） */
  deleteSession: async (characterId: string, sessionId: string): Promise<void> => {
    safeId(characterId)
    safeId(sessionId)
    await prepareChatSessionDeletion({ characterId, sessionId })
    await withSessionFileLock(characterId, sessionId, () => {
      const filePath = getSessionFile(characterId, sessionId)
      if (existsSync(filePath)) {
        unlinkSync(filePath)
      }
      messagesCacheInvalidate(characterId, sessionId)
    })
    await withSessionsLock(characterId, () => {
      const sessions = loadSessions(characterId).filter((s) => s.id !== sessionId)
      saveSessions(characterId, sessions)
    })
  },
}

export type ChatData = typeof chatData