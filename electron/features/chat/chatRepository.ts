/**
 * 主进程聊天仓储（阶段 3A：从 electron/ipc/chat.ts 原样迁出）。
 *
 * 职责：会话/消息文件路径与读写、per-file 锁、消息读取缓存（LRU）与 compact、
 * 会话/消息元数据缓存、旧数据迁移，以及经 `commitThroughDomain` 的同步实体 journal 提交。
 *
 * 迁移约束（方案 §4 阶段 3）：先原样搬移、保持调用时序——锁范围、事务、
 * journal、缓存失效时机与旧实现一致；算法不在本批次改写。
 * IPC 传输层与 `chatData` 数据门面共用这里的同一套底层函数。
 */
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, readdirSync, openSync, readSync, closeSync, statSync, unlinkSync } from 'node:fs'
import { DIRS, readJson, withFileLock, serializeJson } from '../../services/storage'
import { createLogger } from '../../services/logger'
import { notifyChatSpatialSourceChanged } from '../../services/chatLifecycle'
import { getDefaultSettings } from '../../../shared/defaults'
import { isNarrativeMode, resolveNarrativeMode } from '../../../shared/narrativeMode'
import { DEFAULT_AUTO_MEMORY_INTERVAL, resolveDefaultMemoryConfig } from '../../../shared/defaultMemory'
import { nanoid } from 'nanoid'
import { safeId } from '../../utils/pathGuard'
import { onFeatureDataRestoring, isFeatureTaskCancelled } from '../../services/featureTaskLifecycle'
import { matchesFeatureSource, type FeatureSource } from '../../../shared/featureSource'
import { commitThroughDomain, type DomainWriteFile } from '../../domain/syncDomainService'
import { messageEntityPayload, sessionEntityPayload } from './entityMapping'
import type { Message, ChatSession, Settings, Character, NarrativeMode } from '../../../shared/types'

const log = createLogger('chat')

/** 解析已落盘 JSONL 的最终状态（同 id 行以最后一行为准），用于 diff 出变更实体 */function readMessageMapFromDisk(filePath: string): Map<string, Message> {
  const map = new Map<string, Message>()
  if (!existsSync(filePath)) return map
  const content = readFileSync(filePath, 'utf-8')
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as Message
      if (parsed && typeof parsed.id === 'string' && parsed.id) map.set(parsed.id, parsed)
    } catch {
      /* 损坏行忽略：compact/readMessages 会另行告警 */
    }
  }
  return map
}

/**
 * 清空某角色全部对话（S2-04）：对回收站中的 sessions.json 与各 .jsonl
 * 写 tombstone 并在同一事务内删除文件。消息与会话是不同实体类型，分两个事务提交。
 */
export function journalTrashedChatData(characterId: string, trashDir: string): void {
  const sessionsFile = join(trashDir, 'sessions.json')
  const sessions = existsSync(sessionsFile)
    ? (readJson<ChatSession[]>(sessionsFile, 'sessions') ?? [])
    : []

  const messageDeletes: Array<{ entityId: string; parentId: string }> = []
  const messageFiles: DomainWriteFile[] = []
  for (const name of readdirSync(trashDir)) {
    if (!name.endsWith('.jsonl')) continue
    const sessionId = name.replace(/\.jsonl$/, '')
    const filePath = join(trashDir, name)
    for (const m of readMessageMapFromDisk(filePath).values()) {
      messageDeletes.push({ entityId: m.id, parentId: sessionId })
    }
    messageFiles.push({ path: filePath, content: null })
  }
  if (messageFiles.length > 0) {
    commitThroughDomain({
      domain: 'message',
      entityType: 'message',
      puts: [],
      deletes: messageDeletes,
      files: messageFiles,
    })
  }
  if (existsSync(sessionsFile)) {
    commitThroughDomain({
      domain: 'session',
      entityType: 'session',
      puts: [],
      deletes: sessions.map((s) => ({ entityId: s.id, parentId: characterId })),
      files: [{ path: sessionsFile, content: null }],
    })
  }
}

/** chat:updateSession 允许更新的字段白名单（防止注入 id/characterId 等关键字段） */
const UPDATE_SESSION_FIELDS = new Set([
  'title',
  'spatialContextEnabled',
  'spatialBoardEnabled',
  'spatialNarrativeSyncPolicy',
  'memory',
  'memoryCurrentState',
  'memoryEnabled',
  'memoryMode',
  'autoMemoryInterval',
  'memoryUpdatedAt',
  'memoryFacts',
  'memoryFactHistory',
  'memoryFactParseFailureCount',
  'memoryFactRetryAfterVersion',
  'factsVectors',
  'memoryLastMessageId',
  'memoryVersion',
  'memorySource',
  'memoryTaskId',
  'factsVectorVersion',
  'compressedSummary',
  'compressedRange',
  'compressedSource',
  'titleGenerated',
  'lorebookIds',
  'personaId',
  'narrativeMode',
  'dialogueDirectionsEnabled',
  'recentTriggeredIds',
  'lorebookCompressionCache',
])

export const SETTINGS_FILE = () => join(DIRS.config(), 'settings.json')

export function getDefaultPersonaId(): string | null {
  const settings = readJson<Settings>(SETTINGS_FILE()) ?? getDefaultSettings()
  return settings.defaultPersonaId ?? null
}

/** 新会话固化角色默认值；角色无配置时回退全局，再回退 immersive。 */
export function getDefaultNarrativeMode(characterId: string): NarrativeMode {
  const settings = readJson<Settings>(SETTINGS_FILE()) ?? getDefaultSettings()
  const character = readJson<Character>(join(DIRS.characters(), `${characterId}.json`), 'characters')
  return resolveNarrativeMode(character?.defaultNarrativeMode, settings.defaultNarrativeMode)
}

/** 新建会话的默认长记忆配置：与渲染层 applyDefaultMemory 共用 shared/defaultMemory 唯一决策表 */
export function getDefaultMemoryConfig(characterId: string) {
  const settings = readJson<Settings>(SETTINGS_FILE()) ?? getDefaultSettings()
  const character = readJson<Character>(join(DIRS.characters(), `${characterId}.json`), 'characters')
  return resolveDefaultMemoryConfig(settings, character)
}

export function getChatDir(characterId: string): string {
  return join(DIRS.chats(), characterId)
}

function getSessionsFile(characterId: string): string {
  return join(getChatDir(characterId), 'sessions.json')
}

export function getSessionFile(characterId: string, sessionId: string): string {
  return join(getChatDir(characterId), `${sessionId}.jsonl`)
}

/** 读取/写入 sessions 元数据 */
export function loadSessions(characterId: string): ChatSession[] {
  const filePath = getSessionsFile(characterId)
  if (!existsSync(filePath)) return []
  return readJson<ChatSession[]>(filePath, 'sessions') ?? []
}

/**
 * 阶段 2 S2-04：sessions.json 与其 journal 在同一文件事务内提交。
 * 以磁盘旧状态为基准 diff 出新增/修改/删除的会话实体，
 * flag 关闭时退化为与旧实现完全一致的直接落盘。
 */
export function saveSessions(characterId: string, sessions: ChatSession[]): void {
  const dir = getChatDir(characterId)
  mkdirSync(dir, { recursive: true })
  const filePath = getSessionsFile(characterId)
  const previous = existsSync(filePath) ? (readJson<ChatSession[]>(filePath, 'sessions') ?? []) : []
  const previousById = new Map(previous.map((s) => [s.id, JSON.stringify(s)]))
  const nextIds = new Set(sessions.map((s) => s.id))

  const puts = sessions
    .filter((s) => previousById.get(s.id) !== JSON.stringify(s))
    .map((s) => ({
      entityId: s.id,
      payload: sessionEntityPayload(characterId, s),
      parentId: characterId,
      references: [characterId],
      schemaVersion: 1,
    }))
  const deletes = previous
    .filter((s) => !nextIds.has(s.id))
    .map((s) => ({ entityId: s.id, parentId: characterId }))

  commitThroughDomain({
    domain: 'session',
    entityType: 'session',
    puts,
    deletes,
    files: [{ path: filePath, content: serializeJson(sessions, 'sessions') }],
  })
}

// BUG-19 修复：sessions.json 的读-改-写操作统一走 per-file 锁，
// 串行化并发 IPC handler，避免后写入覆盖先写入的修改
export function withSessionsLock<T>(characterId: string, fn: () => T | Promise<T>): Promise<T> {
  return withFileLock(getSessionsFile(characterId), fn)
}

// BUG-10 修复：消息文件的读-改-写（deleteMessage）与追加写（saveMessage）
// 统一走 per-file 锁，避免全量重写覆盖并发追加的新消息
export function withSessionFileLock<T>(characterId: string, sessionId: string, fn: () => T | Promise<T>): Promise<T> {
  return withFileLock(getSessionFile(characterId, sessionId), fn)
}

/** 来源正文确认与消息保存共用锁，防止确认事务期间切换/改写正文。 */
export function withChatMessageLock<T>(scope: { characterId: string; sessionId: string }, fn: () => T | Promise<T>): Promise<T> {
  return withSessionFileLock(safeId(scope.characterId), safeId(scope.sessionId), fn)
}

export function cleanSessionUpdates(updates: Partial<ChatSession>): Partial<ChatSession> {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    throw new Error('参数无效：updates 必须为对象')
  }
  const clean: Partial<ChatSession> = {}
  for (const key of Object.keys(updates)) {
    if (!UPDATE_SESSION_FIELDS.has(key)) continue
    const value = (updates as Record<string, unknown>)[key]
    if (['spatialContextEnabled', 'spatialBoardEnabled'].includes(key) && typeof value !== 'boolean') throw new Error(`参数无效：${key}`)
    if (key === 'spatialNarrativeSyncPolicy' && !['off', 'suggest', 'auto'].includes(String(value))) throw new Error('参数无效：spatialNarrativeSyncPolicy')
    if (key === 'title' && typeof value === 'string' && value.length > 200) {
      throw new Error('标题长度不能超过 200 字符')
    }
    if (key === 'narrativeMode' && !isNarrativeMode(value)) {
      throw new Error('参数无效：narrativeMode')
    }
    if (key === 'dialogueDirectionsEnabled' && typeof value !== 'boolean') {
      throw new Error('参数无效：dialogueDirectionsEnabled')
    }
    ;(clean as Record<string, unknown>)[key] = value
  }
  return clean
}

export function mergeSessionUpdates(session: ChatSession, updates: Partial<ChatSession>): ChatSession {
  const changed = (updates.spatialNarrativeSyncPolicy !== undefined && updates.spatialNarrativeSyncPolicy !== (session.spatialNarrativeSyncPolicy ?? 'suggest')) ||
    (updates.spatialBoardEnabled !== undefined && updates.spatialBoardEnabled !== (session.spatialBoardEnabled === true)) ||
    (updates.spatialContextEnabled !== undefined && updates.spatialContextEnabled !== (session.spatialContextEnabled !== false))
  return { ...session, ...updates, ...(changed ? { spatialNarrativeSyncEpoch: nanoid() } : {}), updatedAt: Date.now() }
}

export async function updateSessionIfMemoryVersion(
  characterId: string,
  sessionId: string,
  expectedVersion: number,
  updates: Partial<ChatSession>,
  source?: FeatureSource,
): Promise<{ applied: boolean; currentVersion: number }> {
  safeId(characterId)
  safeId(sessionId)
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new Error('参数无效：expectedVersion')
  const clean = cleanSessionUpdates(updates)
  const apply = () => withSessionsLock(characterId, () => {
    const sessions = loadSessions(characterId)
    const idx = sessions.findIndex((session) => session.id === sessionId)
    if (idx === -1) { if (source) return { applied: false, currentVersion: 0 }; throw new Error('会话不存在') }
    const currentVersion = sessions[idx].memoryVersion ?? 0
    if (source && updates.memoryTaskId && isFeatureTaskCancelled(updates.memoryTaskId)) return { applied: false, currentVersion }
    if (source && !matchesFeatureSource(source, readMessages(characterId, sessionId), sessions[idx])) return { applied: false, currentVersion }
    if (currentVersion !== expectedVersion) return { applied: false, currentVersion }
    sessions[idx] = mergeSessionUpdates(sessions[idx]!, clean)
    saveSessions(characterId, sessions)
    return { applied: true, currentVersion: sessions[idx].memoryVersion ?? currentVersion }
  })
  return source ? withSessionFileLock(characterId, sessionId, apply) : apply()
}

/** 读取指定 session 的消息（含数据完整性检查） */

// ===================== 消息读取缓存（LRU） =====================
/**
 * P-6 修复：readMessages 全量解析结果缓存。
 * 长会话（数千条消息）切换会话时避免重复读盘 + JSON.parse + 排序。
 * 所有写入路径（appendMessage/deleteMessage/clearChat/deleteSession）同步更新或失效缓存，
 * 保证缓存与磁盘一致。
 */
const messagesCache = new Map<string, Message[]>()
const MESSAGES_CACHE_MAX = 30

function messagesCacheKey(characterId: string, sessionId: string): string {
  return `${characterId}/${sessionId}`
}

/** 读缓存（命中后移到末尾，实现 LRU） */
function messagesCacheGet(characterId: string, sessionId: string): Message[] | undefined {
  const key = messagesCacheKey(characterId, sessionId)
  const hit = messagesCache.get(key)
  if (!hit) return undefined
  messagesCache.delete(key)
  messagesCache.set(key, hit)
  return hit
}

/** 写缓存（超限时淘汰最早插入的条目） */
export function messagesCacheSet(characterId: string, sessionId: string, messages: Message[]): void {
  const key = messagesCacheKey(characterId, sessionId)
  messagesCache.delete(key)
  messagesCache.set(key, messages)
  while (messagesCache.size > MESSAGES_CACHE_MAX) {
    const oldest = messagesCache.keys().next().value
    if (oldest === undefined) break
    messagesCache.delete(oldest)
  }
}

/** 失效缓存：指定 session，或整个角色的全部会话。P-6 导出仅供测试。 */
export function messagesCacheInvalidate(characterId: string, sessionId?: string): void {
  if (sessionId) {
    messagesCache.delete(messagesCacheKey(characterId, sessionId))
    return
  }
  const prefix = `${characterId}/`
  for (const key of [...messagesCache.keys()]) {
    if (key.startsWith(prefix)) messagesCache.delete(key)
  }
}

// ===================== 消息文件 compact（P-8） =====================
/**
 * 消息文件采用"同 id 追加覆盖"策略（updateMessage 始终 append），
 * 频繁编辑/swipe 会让 JSONL 堆满旧版本行。
 * 设计：解析完成时重置计数；appendMessage 命中缓存时累计追加次数，
 * 超过阈值标记待压缩；chat:listMessages 在消息文件锁内去重重写。
 */
const sessionAppendCounts = new Map<string, number>()
const COMPACT_APPEND_THRESHOLD = 300
const pendingCompactions = new Set<string>()

/** 解析完成（或全量重写）后重置追加计数 */
export function resetAppendCount(characterId: string, sessionId: string): void {
  sessionAppendCounts.set(messagesCacheKey(characterId, sessionId), 0)
}

/** appendMessage 缓存命中时累计；超阈值标记待压缩 */
function bumpAppendCount(characterId: string, sessionId: string): void {
  const key = messagesCacheKey(characterId, sessionId)
  const next = (sessionAppendCounts.get(key) ?? 0) + 1
  sessionAppendCounts.set(key, next)
  if (next >= COMPACT_APPEND_THRESHOLD) {
    pendingCompactions.add(key)
  }
}

/** 消费待压缩标记；返回是否需要压缩 */
export function consumePendingCompaction(characterId: string, sessionId: string): boolean {
  const key = messagesCacheKey(characterId, sessionId)
  const hit = pendingCompactions.has(key)
  if (hit) pendingCompactions.delete(key)
  return hit
}

/** P-8：在消息文件锁内去重重写（compact）。导出仅供测试与 listMessages handler 复用。 */
export async function compactSessionFile(characterId: string, sessionId: string): Promise<void> {
  await withSessionFileLock(characterId, sessionId, () => {
    if (!existsSync(getSessionFile(characterId, sessionId))) return
    const fresh = readMessages(characterId, sessionId, true)
    writeMessages(characterId, sessionId, fresh)
    messagesCacheSet(characterId, sessionId, fresh)
    resetAppendCount(characterId, sessionId)
    log.info('消息文件已压缩去重', { characterId, sessionId, messageCount: fresh.length })
  })
}

/**
 * 同 ID 的多行通常是消息更新产生的历史版本；只有不可变身份发生变化时，
 * 才说明两个不同消息意外复用了同一个 ID。
 */
function hasConflictingMessageIdentity(previous: Message, next: Message): boolean {
  if (previous.role !== next.role) return true
  if (previous.characterId && next.characterId && previous.characterId !== next.characterId) return true
  if (previous.sessionId && next.sessionId && previous.sessionId !== next.sessionId) return true
  if (
    Number.isFinite(previous.timestamp)
    && Number.isFinite(next.timestamp)
    && previous.timestamp !== next.timestamp
  ) return true
  return false
}

/** 读取指定 session 的消息（含数据完整性检查，结果走 LRU 缓存）。P-6 导出仅供测试。
 *  bypassCache=true：绕过缓存直接读盘（compact 锁内重读用），不读写缓存。 */
export function readMessages(characterId: string, sessionId: string, bypassCache = false): Message[] {
  if (!bypassCache) {
    const cached = messagesCacheGet(characterId, sessionId)
    if (cached) return cached
  }
  const filePath = getSessionFile(characterId, sessionId)
  if (!existsSync(filePath)) {
    // 文件不存在也缓存空数组：保证后续 appendMessage 能命中缓存做增量更新
    if (!bypassCache) messagesCacheSet(characterId, sessionId, [])
    return []
  }
  const content = readFileSync(filePath, 'utf-8')
  const lines = content.split('\n').filter((line) => line.trim())
  const msgMap = new Map<string, Message>()
  const corruptLines: number[] = []

  lines.forEach((line, idx) => {
    try {
      const msg = JSON.parse(line) as Message
      // 必要字段校验
      if (!msg.id || !msg.role || typeof msg.content !== 'string') {
        corruptLines.push(idx + 1)
        return
      }
      // 兼容旧数据：assistant 消息自动初始化 swipes
      if (msg.role === 'assistant' && !msg.swipes) {
        msg.swipes = [msg.content]
        msg.swipeIndex = 0
      }
      const previous = msgMap.get(msg.id)
      if (previous && hasConflictingMessageIdentity(previous, msg)) {
        log.warn('检测到消息 ID 冲突（后写入覆盖先写入）', { characterId, sessionId, msgId: msg.id })
      }
      msgMap.set(msg.id, msg)
    } catch {
      corruptLines.push(idx + 1)
    }
  })

  if (corruptLines.length > 0) {
    log.warn('消息文件包含损坏行', { characterId, sessionId, lineCount: corruptLines.length, lines: corruptLines.slice(0, 5) })
  }

  const result = Array.from(msgMap.values())
  // P-8：文件按追加序存储（新消息 timestamp 递增），通常已有序；
  // 仅当检测到乱序（旧数据/时钟回拨）时才做 O(n log n) 排序
  let sorted = true
  for (let i = 1; i < result.length; i++) {
    if (result[i].timestamp < result[i - 1].timestamp) {
      sorted = false
      break
    }
  }
  if (!sorted) result.sort((a, b) => a.timestamp - b.timestamp)
  if (!bypassCache) {
    messagesCacheSet(characterId, sessionId, result)
    // 解析完成：重置追加计数，开始新一轮 compact 阈值统计
    resetAppendCount(characterId, sessionId)
  }
  return result
}

/**
 * 重写整个 session 文件（阶段 2 S2-04：文件与 message journal 同一事务提交）。
 * 以磁盘旧状态 diff 出新增/修改/删除的消息实体；flag 关闭时退化为旧的原子重写。
 */
export function writeMessages(characterId: string, sessionId: string, messages: Message[]): void {
  const dir = getChatDir(characterId)
  mkdirSync(dir, { recursive: true })
  const filePath = getSessionFile(characterId, sessionId)
  const serialized = messages.map((m) => JSON.stringify(m)).join('\n')
  const content = serialized ? serialized + '\n' : ''

  const previous = readMessageMapFromDisk(filePath)
  const nextIds = new Set(messages.map((m) => m.id))
  const puts = messages
    .filter((m) => {
      const before = previous.get(m.id)
      return !before || JSON.stringify(before) !== JSON.stringify(m)
    })
    .map((m) => ({
      entityId: m.id,
      payload: messageEntityPayload(m),
      parentId: sessionId,
      references: [sessionId],
      schemaVersion: 1,
    }))
  const deletes = [...previous.values()]
    .filter((m) => !nextIds.has(m.id))
    .map((m) => ({ entityId: m.id, parentId: sessionId }))

  commitThroughDomain({
    domain: 'message',
    entityType: 'message',
    puts,
    deletes,
    files: [{ path: filePath, content }],
  })
}

/**
 * 追加单条消息（阶段 2 S2-04：append 事务，保持 O(1) 追加语义，
 * 不因 journal 而整文件重写）。写入后同步更新读取缓存。
 */
export function appendMessage(characterId: string, sessionId: string, message: Message): void {
  const dir = getChatDir(characterId)
  mkdirSync(dir, { recursive: true })
  const filePath = getSessionFile(characterId, sessionId)

  commitThroughDomain({
    domain: 'message',
    entityType: 'message',
    puts: [
      {
        entityId: message.id,
        payload: messageEntityPayload(message),
        parentId: sessionId,
        references: [sessionId],
        schemaVersion: 1,
      },
    ],
    deletes: [],
    files: [{ path: filePath, content: JSON.stringify(message) + '\n', append: true }],
  })

  // P-6：缓存命中则增量更新（同 id 覆盖，与 readMessages 的 msgMap 去重语义一致）
  const key = messagesCacheKey(characterId, sessionId)
  const cached = messagesCache.get(key)
  if (cached) {
    const idx = cached.findIndex((m) => m.id === message.id)
    if (idx >= 0) {
      cached[idx] = message
    } else {
      cached.push(message)
    }
    // 视为近期访问，维持 LRU 顺序
    messagesCache.delete(key)
    messagesCache.set(key, cached)
    // P-8：磁盘上是追加写（旧版本行残留），累计追加次数供 compact 决策
    bumpAppendCount(characterId, sessionId)
  }
  notifyChatSpatialSourceChanged({ characterId, sessionId })
}

/**
 * 更新单条消息（不存在则追加）
 * 性能优化：始终追加，读取时通过 msgMap 按 id 去重取最新值
 * isNew 始终返回 false（lastMessage 在 listSessions 时按需计算）
 */
export function updateMessage(characterId: string, sessionId: string, message: Message): boolean {
  appendMessage(characterId, sessionId, message)
  return false
}

/** 计算物理文件统计与尾行摘要，尾行摘要仅作为异常数据的兼容回退。 */
// 正常预览由 computeChronologicalMessageMeta 按 timestamp 计算，避免编辑旧消息
// 后物理尾行覆盖真正的最后一条消息。
function computeMessageMeta(characterId: string, sessionId: string): { count: number; lastMessage: string } {
  const filePath = getSessionFile(characterId, sessionId)
  if (!existsSync(filePath)) return { count: 0, lastMessage: '' }

  let count = 0
  let lastMessage = ''

  try {
    const fd = openSync(filePath, 'r')
    try {
      const fileSize = statSync(filePath).size
      if (fileSize === 0) return { count: 0, lastMessage: '' }

      // 扫描全文统计行数（只读字节，不做 JSON 解析）
      // M-13 修复：仅统计以 { 开头的完整 JSON 消息行——消息 content 含真实换行/多行
      // pretty 历史数据时物理行数虚高，与 readMessages 按 id 去重语义不一致。
      const BUF_SIZE = 64 * 1024
      const buf = Buffer.alloc(BUF_SIZE)
      let totalRead = 0
      let lineStart = true
      let lineStartsWithBrace = false
      while (totalRead < fileSize) {
        const toRead = Math.min(BUF_SIZE, fileSize - totalRead)
        const bytesRead = readSync(fd, buf, 0, toRead, totalRead)
        if (bytesRead === 0) break
        for (let i = 0; i < bytesRead; i++) {
          const b = buf[i]
          if (b === 0x0A) {
            if (lineStartsWithBrace) count++
            lineStart = true
            lineStartsWithBrace = false
          } else {
            if (lineStart) {
              lineStart = false
              if (b === 0x7B) lineStartsWithBrace = true // '{'
            }
          }
        }
        totalRead += bytesRead
      }
      // 文件末尾无 \n 的末行（处于行中且以 { 开头）
      if (!lineStart && lineStartsWithBrace) count++

      // 读取尾部 4KB 解析最后一行
      if (count > 0) {
        const tailSize = Math.min(4096, fileSize)
        const tailBuf = Buffer.alloc(tailSize)
        readSync(fd, tailBuf, 0, tailSize, fileSize - tailSize)
        const tail = tailBuf.toString('utf-8')
        // 修复：消息文件以 \n 结尾（appendMessage 每行追加 \n），
        // 最后一个 \n 后是空行——需取倒数第二行作为最后一条消息
        const lastNewline = tail.lastIndexOf('\n')
        let lastLine = ''
        if (lastNewline >= 0) {
          lastLine = tail.slice(lastNewline + 1).trim()
          if (!lastLine) {
            const prevNewline = tail.lastIndexOf('\n', lastNewline - 1)
            lastLine = (prevNewline >= 0 ? tail.slice(prevNewline + 1, lastNewline) : tail.slice(0, lastNewline)).trim()
          }
        } else {
          lastLine = tail.trim()
        }
        if (lastLine) {
          try {
            const msg = JSON.parse(lastLine) as Message
            if (msg.content) lastMessage = msg.content.slice(0, 50)
          } catch { /* 忽略 */ }
        }
      }
    } finally {
      closeSync(fd)
    }
  } catch (err) {
    // BUG-35 修复：记录错误而非静默吞掉，便于排查消息文件读取异常
    log.warn('computeMessageMeta 读取消息文件失败', { characterId, sessionId, error: (err as Error).message })
  }

  return { count, lastMessage }
}

/** P2 修复：会话元数据缓存——文件 mtime+size 未变则复用统计结果，
 * 避免 listSessions 每次对每个会话文件全量字节扫描（阻塞主进程事件循环） */
interface MetaCacheEntry { mtimeMs: number; size: number; meta: { count: number; lastMessage: string } }
const sessionMetaCache = new Map<string, MetaCacheEntry>()
onFeatureDataRestoring(() => { messagesCache.clear(); sessionMetaCache.clear() })
const META_CACHE_MAX = 1000

/** 按时间顺序计算会话摘要；编辑旧消息时，JSONL 物理尾行不代表最后一条消息。 */
function computeChronologicalMessageMeta(characterId: string, sessionId: string): { count: number; lastMessage: string } {
  const physicalMeta = computeMessageMeta(characterId, sessionId)
  // 元数据层已有自己的 mtime+size 缓存；这里绕过消息 LRU，避免文件被外部追加后
  // 复用旧消息列表而得到旧的预览文本。
  const messages = readMessages(characterId, sessionId, true)
  const lastMessage = messages[messages.length - 1]?.content ?? physicalMeta.lastMessage
  return { count: physicalMeta.count, lastMessage: lastMessage.slice(0, 50) }
}

export function computeMessageMetaCached(characterId: string, sessionId: string): { count: number; lastMessage: string } {
  const filePath = getSessionFile(characterId, sessionId)
  if (!existsSync(filePath)) return { count: 0, lastMessage: '' }
  let st
  try {
    st = statSync(filePath)
  } catch {
    return { count: 0, lastMessage: '' }
  }
  const key = `${characterId}:${sessionId}`
  const cached = sessionMetaCache.get(key)
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.meta
  }
  const meta = computeChronologicalMessageMeta(characterId, sessionId)
  sessionMetaCache.set(key, { mtimeMs: st.mtimeMs, size: st.size, meta })
  // 超限时清除最早插入的一半条目（Map 迭代序 = 插入序）
  if (sessionMetaCache.size > META_CACHE_MAX) {
    let removed = 0
    for (const k of sessionMetaCache.keys()) {
      if (removed++ >= META_CACHE_MAX / 2) break
      sessionMetaCache.delete(k)
    }
  }
  return meta
}

/** 旧数据迁移：messages.jsonl -> default session */
export function migrateOldData(characterId: string): string | null {
  const oldFile = join(getChatDir(characterId), 'messages.jsonl')
  if (!existsSync(oldFile)) return null

  const defaultSessionId = 'default'
  const newFile = getSessionFile(characterId, defaultSessionId)
  if (existsSync(newFile)) {
    // 已经迁移过
    try { unlinkSync(oldFile) } catch { /* ignore */ }
    return defaultSessionId
  }

  // 移动文件：阶段 2 S2-04 经同一事务把新版消息文件写入并为旧文件写删除操作
  try {
    const content = readFileSync(oldFile, 'utf-8')
    const migrated: Message[] = []
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as Message
        if (parsed && typeof parsed.id === 'string' && parsed.id) migrated.push(parsed)
      } catch {
        /* 损坏行保持原样搬运，不阻断迁移 */
      }
    }
    commitThroughDomain({
      domain: 'message',
      entityType: 'message',
      puts: migrated.map((m) => ({
        entityId: m.id,
        payload: messageEntityPayload({ ...m, sessionId: defaultSessionId }),
        parentId: defaultSessionId,
        references: [defaultSessionId],
        schemaVersion: 1,
      })),
      deletes: [],
      files: [
        { path: newFile, content },
        { path: oldFile, content: null },
      ],
    })

    // 确保 session 元数据存在
    const sessions = loadSessions(characterId)
    if (!sessions.find(s => s.id === defaultSessionId)) {
      const now = Date.now()
      sessions.push({
        id: defaultSessionId,
        characterId,
        title: '默认对话',
        createdAt: now,
        updatedAt: now,
        memoryEnabled: false,
        memoryMode: 'manual',
        autoMemoryInterval: DEFAULT_AUTO_MEMORY_INTERVAL,
        memory: '',
        memoryUpdatedAt: 0,
      })
      saveSessions(characterId, sessions)
    }
    return defaultSessionId
  } catch (err) {
    log.warn('旧数据迁移失败', { characterId, error: (err as Error).message })
    return null
  }
}

/** 创建默认会话 */
export function createDefaultSession(characterId: string): ChatSession {
  const now = Date.now()
  return {
    // 修复：默认会话 id 改为唯一值（原 'default' 固定 id 在多角色场景下
    // 会生成多个同名会话，导致桥接层列表/安卓端 LazyColumn key 冲突崩溃）
    id: nanoid(),
    characterId,
    title: '默认对话',
    createdAt: now,
    updatedAt: now,
    ...getDefaultMemoryConfig(characterId),
    memory: '',
    memoryUpdatedAt: 0,
    personaId: getDefaultPersonaId(),
    narrativeMode: getDefaultNarrativeMode(characterId),
  }
}