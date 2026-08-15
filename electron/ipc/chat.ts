import type { IpcMain } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, unlinkSync, renameSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { DIRS, readJson, writeJson, withFileLock } from '../services/storage'
import { escapeMarkdownContent } from '../utils/markdown'
import { getDefaultSettings } from '../../shared/defaults'
import { createLogger } from '../services/logger'
import type { Message, ChatSession, SessionPreview } from '../../shared/types'
import type { Settings } from '../../shared/types'
import { nanoid } from 'nanoid'
import { safeId } from '../utils/pathGuard'
import { safeHandle } from '../utils/safeHandle'

const log = createLogger('chat')

/** chat:updateSession 允许更新的字段白名单（防止注入 id/characterId 等关键字段） */
const UPDATE_SESSION_FIELDS = new Set([
  'title',
  'memory',
  'memoryEnabled',
  'memoryMode',
  'autoMemoryInterval',
  'memoryUpdatedAt',
  'memoryFacts',
  'factsVectors',
  'compressedSummary',
  'compressedRange',
  'titleGenerated',
  'lorebookIds',
  'personaId',
])

const SETTINGS_FILE = () => join(DIRS.config(), 'settings.json')

function getDefaultPersonaId(): string | null {
  const settings = readJson<Settings>(SETTINGS_FILE()) ?? getDefaultSettings()
  return settings.defaultPersonaId ?? null
}

function getChatDir(characterId: string): string {
  return join(DIRS.chats(), characterId)
}

function getSessionsFile(characterId: string): string {
  return join(getChatDir(characterId), 'sessions.json')
}

function getSessionFile(characterId: string, sessionId: string): string {
  return join(getChatDir(characterId), `${sessionId}.jsonl`)
}

/** 读取/写入 sessions 元数据 */
function loadSessions(characterId: string): ChatSession[] {
  const filePath = getSessionsFile(characterId)
  if (!existsSync(filePath)) return []
  return readJson<ChatSession[]>(filePath, 'sessions') ?? []
}

function saveSessions(characterId: string, sessions: ChatSession[]): void {
  const dir = getChatDir(characterId)
  mkdirSync(dir, { recursive: true })
  writeJson(getSessionsFile(characterId), sessions, 'sessions')
}

// BUG-19 修复：sessions.json 的读-改-写操作统一走 per-file 锁，
// 串行化并发 IPC handler，避免后写入覆盖先写入的修改
function withSessionsLock<T>(characterId: string, fn: () => T | Promise<T>): Promise<T> {
  return withFileLock(getSessionsFile(characterId), fn)
}

// BUG-10 修复：消息文件的读-改-写（deleteMessage）与追加写（saveMessage）
// 统一走 per-file 锁，避免全量重写覆盖并发追加的新消息
function withSessionFileLock<T>(characterId: string, sessionId: string, fn: () => T | Promise<T>): Promise<T> {
  return withFileLock(getSessionFile(characterId, sessionId), fn)
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
function messagesCacheSet(characterId: string, sessionId: string, messages: Message[]): void {
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
function resetAppendCount(characterId: string, sessionId: string): void {
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
function consumePendingCompaction(characterId: string, sessionId: string): boolean {
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
  const seenIds = new Set<string>()
  const corruptLines: number[] = []
  const duplicateIds: string[] = []

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
      if (seenIds.has(msg.id)) {
        duplicateIds.push(msg.id)
        log.warn('检测到重复消息 ID（后写入覆盖先写入）', { characterId, sessionId, msgId: msg.id })
      }
      seenIds.add(msg.id)
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

/** 重写整个 session 文件（原子写入：temp + rename，防止崩溃损坏会话文件） */
function writeMessages(characterId: string, sessionId: string, messages: Message[]): void {
  const dir = getChatDir(characterId)
  mkdirSync(dir, { recursive: true })
  const filePath = getSessionFile(characterId, sessionId)
  const content = messages.map((m) => JSON.stringify(m)).join('\n')
  const tmpPath = filePath + '.tmp'
  writeFileSync(tmpPath, content ? content + '\n' : '', 'utf-8')
  try {
    renameSync(tmpPath, filePath)
  } catch (err) {
    try { unlinkSync(tmpPath) } catch { /* ignore */ }
    throw err
  }
}

/** 追加单条消息（写入后同步更新读取缓存，避免下次 listMessages 重新全量解析）。P-6 导出仅供测试。 */
export function appendMessage(characterId: string, sessionId: string, message: Message): void {
  const dir = getChatDir(characterId)
  mkdirSync(dir, { recursive: true })
  const filePath = getSessionFile(characterId, sessionId)
  writeFileSync(filePath, JSON.stringify(message) + '\n', { flag: 'a' })

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
}

/**
 * 更新单条消息（不存在则追加）
 * 性能优化：始终追加，读取时通过 msgMap 按 id 去重取最新值
 * isNew 始终返回 false（lastMessage 在 listSessions 时按需计算）
 */
function updateMessage(characterId: string, sessionId: string, message: Message): boolean {
  appendMessage(characterId, sessionId, message)
  return false
}

/** 计算单个 session 的消息数和最后消息摘要 */
// 优化：只读尾部获取 lastMessage，行数通过扫描换行符统计（避免全量 JSON 解析）
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
const META_CACHE_MAX = 1000

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
  const meta = computeMessageMeta(characterId, sessionId)
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
function migrateOldData(characterId: string): string | null {
  const oldFile = join(getChatDir(characterId), 'messages.jsonl')
  if (!existsSync(oldFile)) return null

  const defaultSessionId = 'default'
  const newFile = getSessionFile(characterId, defaultSessionId)
  if (existsSync(newFile)) {
    // 已经迁移过
    try { unlinkSync(oldFile) } catch { /* ignore */ }
    return defaultSessionId
  }

  // 移动文件
  try {
    const content = readFileSync(oldFile, 'utf-8')
    // BUG-22 修复：先写 temp 再原子 rename，任何一步失败都不会删掉旧文件；
    // 失败时清理残留 temp，避免“旧文件已删但新文件未写入”的数据丢失
    const tmpFile = newFile + '.tmp'
    writeFileSync(tmpFile, content)
    try {
      renameSync(tmpFile, newFile)
    } catch (err) {
      try { unlinkSync(tmpFile) } catch { /* ignore */ }
      throw err
    }
    unlinkSync(oldFile)

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
        autoMemoryInterval: 10,
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
function createDefaultSession(characterId: string): ChatSession {
  const now = Date.now()
  return {
    // 修复：默认会话 id 改为唯一值（原 'default' 固定 id 在多角色场景下
    // 会生成多个同名会话，导致桥接层列表/安卓端 LazyColumn key 冲突崩溃）
    id: nanoid(),
    characterId,
    title: '默认对话',
    createdAt: now,
    updatedAt: now,
    memoryEnabled: false,
    memoryMode: 'manual',
    autoMemoryInterval: 10,
    memory: '',
    memoryUpdatedAt: 0,
    personaId: getDefaultPersonaId(),
  }
}

export function registerChatIPC(ipcMain: IpcMain): void {
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
        memoryEnabled: false,
        memoryMode: 'manual',
        autoMemoryInterval: 10,
        memory: '',
        memoryUpdatedAt: 0,
        personaId: effectivePersonaId,
        lorebookIds,
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
    // R1 修复：删除消息文件前先获取消息文件锁（与 saveMessage/deleteMessage 锁序一致：
    // 消息锁 → sessions 锁），避免与并发写入竞态导致"删除后文件被重建/读到半删状态"
    await withSessionFileLock(characterId, sessionId, () => {
      const filePath = getSessionFile(characterId, sessionId)
      if (existsSync(filePath)) {
        unlinkSync(filePath)
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
    // 字段白名单：仅允许更新常规会话字段，防止注入 id/characterId 等关键字段破坏数据
    const clean: Partial<ChatSession> = {}
    for (const key of Object.keys(updates)) {
      if (!UPDATE_SESSION_FIELDS.has(key)) continue
      const value = (updates as Record<string, unknown>)[key]
      if (key === 'title' && typeof value === 'string' && value.length > 200) {
        throw new Error('标题长度不能超过 200 字符')
      }
      ;(clean as Record<string, unknown>)[key] = value
    }
    return withSessionsLock(characterId, () => {
      const sessions = loadSessions(characterId)
      const idx = sessions.findIndex(s => s.id === sessionId)
      if (idx === -1) throw new Error('会话不存在')
      sessions[idx] = { ...sessions[idx], ...clean, updatedAt: Date.now() }
      saveSessions(characterId, sessions)
      return sessions[idx]
    })
  })

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
    await withSessionFileLock(message.characterId, sid, () => {
      updateMessage(message.characterId, sid, message)
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
          unlinkSync(filePath)
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
          session.memoryUpdatedAt = 0
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
        renameSync(dir, trashDir)
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
    if (format === 'json') {
      return JSON.stringify(messages, null, 2)
    }
    // Markdown 格式（含图片）
    // 修复：对话内容转义 Markdown 特殊字符，防止内容中的 # 标题 / *斜体* / `代码` / ![图片] 破坏导出格式
    let md = `# 对话记录\n\n`
    for (const msg of messages) {
      const role = msg.role === 'user' ? '🧑 用户' : msg.role === 'assistant' ? '🎭 AI' : '系统'
      const time = new Date(msg.timestamp).toLocaleString('zh-CN')
      md += `### ${role} · ${time}\n\n`
      // 插入图片（base64 data URI，不转义以保留图片语法）
      if (msg.images && msg.images.length > 0) {
        for (const img of msg.images) {
          md += `![图片](${img})\n\n`
        }
      }
      md += `${escapeMarkdownContent(msg.content)}\n\n---\n\n`
    }
    return md
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
    appendMessage(characterId, message.sessionId, message)
  },

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
        memoryEnabled: false,
        memoryMode: 'manual',
        autoMemoryInterval: 10,
        memory: '',
        memoryUpdatedAt: 0,
        personaId: effectivePersonaId,
        lorebookIds,
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
    const clean: Partial<ChatSession> = {}
    for (const key of Object.keys(updates)) {
      if (!UPDATE_SESSION_FIELDS.has(key)) continue
      ;(clean as Record<string, unknown>)[key] = (updates as Record<string, unknown>)[key]
    }
    return withSessionsLock(characterId, () => {
      const sessions = loadSessions(characterId)
      const idx = sessions.findIndex((s) => s.id === sessionId)
      if (idx === -1) throw new Error('会话不存在')
      sessions[idx] = { ...sessions[idx], ...clean, updatedAt: Date.now() }
      saveSessions(characterId, sessions)
      return sessions[idx]
    })
  },

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
        session.memoryUpdatedAt = 0
        saveSessions(characterId, sessions)
      }
    })
  },

  /** 删除会话（与 IPC handler chat:deleteSession 同一路径：删消息文件 + 从 sessions.json 移除） */
  deleteSession: async (characterId: string, sessionId: string): Promise<void> => {
    safeId(characterId)
    safeId(sessionId)
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
