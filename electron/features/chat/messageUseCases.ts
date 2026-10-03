/**
 * 主进程聊天消息用例（阶段 3A-2：从 electron/ipc/chat.ts 的 handler 与数据门面原样迁出）。
 *
 * 职责：消息读取/保存/删除、导出、统计，以及功能 AI 结果（翻译、对话方向、
 * 标题、世界书压缩、长记忆压缩）的原子提交与来源围栏。
 *
 * 迁移约束（方案 §4 阶段 3）：先原样搬移、保持调用时序——锁范围、
 * `commitThroughDomain` journal、缓存失效时机与来源围栏与旧实现一致。
 * 参数边界由 IPC handler 与 `chatData` 门面负责；`commitFeatureResult` 沿用
 * 原有的内部校验（safeId + assertFeatureCommit）。
 */
import { upsertCompressionCache } from '../../../shared/chat-core/lorebook'
import { isFeatureTaskCancelled } from '../../services/featureTaskLifecycle'
import { assertFeatureCommit, matchesFeatureSource, compressionVersion, type FeatureCommit } from '../../../shared/featureSource'
import { exportSessionJson, exportSessionMarkdown } from '../../../shared/chat-core/sessionExport'
import { withMessageIdentity } from '../../../shared/messageIdentity'
import { readJson } from '../../services/storage'
import { notifyChatSpatialSourceChanged } from '../../services/chatLifecycle'
import { safeId } from '../../utils/pathGuard'
import type { Message, Settings } from '../../../shared/types'
import {
  SETTINGS_FILE,
  compactSessionFile,
  consumePendingCompaction,
  loadSessions,
  messagesCacheSet,
  migrateOldData,
  readMessages,
  resetAppendCount,
  saveSessions,
  updateMessage,
  withSessionFileLock,
  withSessionsLock,
  writeMessages,
} from './chatRepository'

export async function listMessages(characterId: string, sessionId?: string): Promise<Message[]> {
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
}

/**
 * 保存消息（新增或更新）
 * 优化：仅更新 session 的 updatedAt，不每次都计算 messageCount
 *      messageCount 在 listSessions 时按需计算
 */
export async function saveMessage(message: Message): Promise<void> {
  const sid = message.sessionId || 'default'

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
}

/** 删除单条消息（读-改-写整体持锁，避免全量重写覆盖并发追加的消息） */
export async function deleteMessage(characterId: string, messageId: string, sessionId?: string): Promise<void> {
  const sid = sessionId || 'default'
  // BUG-10 修复：读-改-写整体持锁，避免全量重写覆盖并发追加的消息
  await withSessionFileLock(characterId, sid, () => {
    const messages = readMessages(characterId, sid)
    const filtered = messages.filter((m) => m.id !== messageId)
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
}

/** 导出对话（md/json） */
export async function exportChat(characterId: string, sessionId: string, format: 'md' | 'json'): Promise<string> {
  const messages = readMessages(characterId, sessionId)
  // 导出逻辑已抽到 shared/chat-core/sessionExport.ts：Android 侧消费**同一份**实现，
  // 保证同一会话在两端导出得到同一个文件（阶段 4 S4-04）。
  if (format === 'json') {
    return exportSessionJson(messages as unknown as Array<Record<string, unknown>>)
  }
  return exportSessionMarkdown(messages)
}

/** 会话统计（消息数、字符数、首尾时间与时长文案） */
export async function getStats(characterId: string, sessionId: string) {
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
}

/** 功能 AI 结果的原子提交（同一消息锁 + sessions 锁内核对来源与任务取消状态）。 */
export async function commitFeatureResult(characterId: string, sessionId: string, input: FeatureCommit): Promise<boolean> {
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