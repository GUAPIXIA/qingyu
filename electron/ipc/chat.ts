import type { IpcMain } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, unlinkSync, renameSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { DIRS, readJson, writeJson, withFileLock } from '../services/storage'
import { getDefaultSettings } from '../../shared/defaults'
import { createLogger } from '../services/logger'
import type { Message, ChatSession, SessionPreview } from '../../shared/types'
import type { Settings } from '../../shared/types'
import { nanoid } from 'nanoid'
import { safeId } from '../utils/pathGuard'
import { safeHandle } from '../utils/safeHandle'

const log = createLogger('chat')

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
function readMessages(characterId: string, sessionId: string): Message[] {
  const filePath = getSessionFile(characterId, sessionId)
  if (!existsSync(filePath)) return []
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

  return Array.from(msgMap.values()).sort((a, b) => a.timestamp - b.timestamp)
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

/** 追加单条消息 */
function appendMessage(characterId: string, sessionId: string, message: Message): void {
  const dir = getChatDir(characterId)
  mkdirSync(dir, { recursive: true })
  const filePath = getSessionFile(characterId, sessionId)
  writeFileSync(filePath, JSON.stringify(message) + '\n', { flag: 'a' })
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

/**
 * 增量更新 session 元数据
 * 避免每次 saveMessage 都重写整个 sessions.json
 * 注：当前仅 updatedAt 通过 saveMessage 内联更新，此函数保留供未来扩展使用
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function updateSessionMeta(
  characterId: string,
  sessionId: string,
  patch: Partial<Pick<ChatSession, 'updatedAt' | 'memoryEnabled' | 'memoryMode' | 'autoMemoryInterval' | 'memory' | 'memoryUpdatedAt' | 'title'>>,
): void {
  const sessions = loadSessions(characterId)
  const session = sessions.find(s => s.id === sessionId)
  if (!session) return
  Object.assign(session, patch)
  session.updatedAt = patch.updatedAt ?? Date.now()
  saveSessions(characterId, sessions)
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
      const BUF_SIZE = 64 * 1024
      const buf = Buffer.alloc(BUF_SIZE)
      let totalRead = 0
      while (totalRead < fileSize) {
        const toRead = Math.min(BUF_SIZE, fileSize - totalRead)
        const bytesRead = readSync(fd, buf, 0, toRead, totalRead)
        if (bytesRead === 0) break
        for (let i = 0; i < bytesRead; i++) {
          if (buf[i] === 0x0A) count++ // \n
        }
        totalRead += bytesRead
      }

      // 读取尾部 4KB 解析最后一行
      if (count > 0) {
        const tailSize = Math.min(4096, fileSize)
        const tailBuf = Buffer.alloc(tailSize)
        readSync(fd, tailBuf, 0, tailSize, fileSize - tailSize)
        const tail = tailBuf.toString('utf-8')
        const lastNewline = tail.lastIndexOf('\n')
        const lastLine = (lastNewline >= 0 ? tail.slice(lastNewline + 1) : tail).trim()
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
    id: 'default',
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
      // 这里仍然全量读，但通过 computeMessageMeta 复用逻辑
      return sessions.map(s => {
        const meta = computeMessageMeta(characterId, s.id)
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
    return withSessionsLock(characterId, () => {
      // 删除 session 文件
      const filePath = getSessionFile(characterId, sessionId)
      if (existsSync(filePath)) {
        unlinkSync(filePath)
      }
      // 从 sessions.json 中移除
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
    return withSessionsLock(characterId, () => {
      const sessions = loadSessions(characterId)
      const idx = sessions.findIndex(s => s.id === sessionId)
      if (idx === -1) throw new Error('会话不存在')
      sessions[idx] = { ...sessions[idx], ...updates, updatedAt: Date.now() }
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
      // 清空指定 session 的消息文件
      const filePath = getSessionFile(characterId, sessionId)
      if (existsSync(filePath)) {
        unlinkSync(filePath)
      }
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
    // 修复：对话内容转义 Markdown 特殊字符，防止内容中的 # 标题 / *斜体* / `代码` 破坏导出格式
    const escapeMd = (s: string) => s.replace(/([\\`*_[\]{}#])/g, '\\$1')
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
      md += `${escapeMd(msg.content)}\n\n---\n\n`
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
