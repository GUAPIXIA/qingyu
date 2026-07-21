import type { IpcMain } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync } from 'node:fs'
import { DIRS, readJson, writeJson } from '../services/storage'
import { createLogger } from '../services/logger'
import type { Message, ChatSession, SessionPreview } from '../../shared/types'
import { nanoid } from 'nanoid'
import { safeId } from '../utils/pathGuard'

const log = createLogger('chat')

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
  return readJson<ChatSession[]>(filePath) ?? []
}

function saveSessions(characterId: string, sessions: ChatSession[]): void {
  const dir = getChatDir(characterId)
  mkdirSync(dir, { recursive: true })
  writeJson(getSessionsFile(characterId), sessions)
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

/** 重写整个 session 文件 */
function writeMessages(characterId: string, sessionId: string, messages: Message[]): void {
  const dir = getChatDir(characterId)
  mkdirSync(dir, { recursive: true })
  const filePath = getSessionFile(characterId, sessionId)
  const content = messages.map((m) => JSON.stringify(m)).join('\n')
  writeFileSync(filePath, content ? content + '\n' : '', 'utf-8')
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
 * 性能优化：只追加新消息；对于已存在消息，做最小化重写
 */
// L-05 修复：返回是否为新消息，避免 saveMessage 中重复读取
function updateMessage(characterId: string, sessionId: string, message: Message): boolean {
  const messages = readMessages(characterId, sessionId)
  const idx = messages.findIndex((m) => m.id === message.id)
  if (idx >= 0) {
    // 更新已有消息：需要重写整个文件
    messages[idx] = message
    writeMessages(characterId, sessionId, messages)
    return false
  } else {
    // 新消息：追加到文件末尾（高效）
    appendMessage(characterId, sessionId, message)
    return true
  }
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
// P-1 修复：仅统计行数 + 解析最后一行获取 lastMessage，避免全量 JSON 解析
function computeMessageMeta(characterId: string, sessionId: string): { count: number; lastMessage: string } {
  const filePath = getSessionFile(characterId, sessionId)
  if (!existsSync(filePath)) return { count: 0, lastMessage: '' }
  const content = readFileSync(filePath, 'utf-8')
  const lines = content.split('\n').filter(l => l.trim())
  const count = lines.length
  let lastMessage = ''
  // 只解析最后一行获取预览文本
  if (count > 0) {
    try {
      const msg = JSON.parse(lines[count - 1]) as Message
      if (msg.content) lastMessage = msg.content.slice(0, 50)
    } catch { /* 忽略 */ }
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
    writeFileSync(newFile, content)
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
  } catch {
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
  }
}

export function registerChatIPC(ipcMain: IpcMain): void {
  // ===== 会话管理 =====

  ipcMain.handle('chat:listSessions', async (_e, characterId: string) => {
    safeId(characterId)
    // 迁移旧数据
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
    })
  })

  ipcMain.handle('chat:createSession', async (_e, characterId: string, title?: string) => {
    safeId(characterId)
    const sessions = loadSessions(characterId)
    const now = Date.now()
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
    }
    sessions.push(session)
    saveSessions(characterId, sessions)
    log.info('会话已创建', { characterId, sessionId: session.id, title: session.title })
    return session
  })

  ipcMain.handle('chat:deleteSession', async (_e, characterId: string, sessionId: string) => {
    safeId(characterId)
    safeId(sessionId)
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

  ipcMain.handle('chat:renameSession', async (_e, characterId: string, sessionId: string, title: string) => {
    safeId(characterId)
    safeId(sessionId)
    const sessions = loadSessions(characterId)
    const session = sessions.find(s => s.id === sessionId)
    if (session) {
      session.title = title
      session.updatedAt = Date.now()
      saveSessions(characterId, sessions)
    }
  })

  // ===== 消息管理 =====

  ipcMain.handle('chat:listMessages', async (_e, characterId: string, sessionId?: string) => {
    safeId(characterId)
    if (sessionId) safeId(sessionId)
    // 迁移旧数据
    migrateOldData(characterId)

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
  ipcMain.handle('chat:saveMessage', async (_e, message: Message) => {
    safeId(message.characterId)
    const sid = message.sessionId || 'default'
    safeId(sid)

    // L-05 修复：updateMessage 返回是否为新消息，消除重复读取
    const isNew = updateMessage(message.characterId, sid, message)

    // 增量更新 session 的 updatedAt（只重写 sessions.json，不重读 messages）
    const sessions = loadSessions(message.characterId)
    const session = sessions.find(s => s.id === sid)
    if (session) {
      session.updatedAt = Date.now()
      // 新消息时更新 lastMessage（用于会话列表预览，避免下次 listSessions 全量读）
      if (isNew && message.content) {
        // 不存到 session 字段中（保持 ChatSession 类型干净）
        // lastMessage 在 listSessions 时按需计算
      }
      saveSessions(message.characterId, sessions)
    }
  })

  ipcMain.handle('chat:deleteMessage', async (_e, { id, characterId, sessionId }: { id: string; characterId: string; sessionId?: string }) => {
    safeId(characterId)
    const sid = sessionId || 'default'
    safeId(sid)
    safeId(id)
    const messages = readMessages(characterId, sid)
    const filtered = messages.filter((m) => m.id !== id)
    writeMessages(characterId, sid, filtered)
    // 同步 session updatedAt
    const sessions = loadSessions(characterId)
    const session = sessions.find(s => s.id === sid)
    if (session) {
      session.updatedAt = Date.now()
      saveSessions(characterId, sessions)
    }
  })

  /**
   * 清空对话：删除消息文件 + 同步重置 session 元数据
   * 修复 #48: 删除消息文件后，session 仍存在但 messageCount 应为 0
   */
  ipcMain.handle('chat:clearChat', async (_e, characterId: string, sessionId?: string) => {
    safeId(characterId)
    if (sessionId) {
      safeId(sessionId)
      // 清空指定 session 的消息文件
      const filePath = getSessionFile(characterId, sessionId)
      if (existsSync(filePath)) {
        unlinkSync(filePath)
      }
      // 重置 session 元数据
      const sessions = loadSessions(characterId)
      const session = sessions.find(s => s.id === sessionId)
      if (session) {
        session.updatedAt = Date.now()
        // 重置长记忆（清空对话时一并清除历史摘要）
        session.memory = ''
        session.memoryUpdatedAt = 0
        saveSessions(characterId, sessions)
      }
    } else {
      // 清空整个角色的所有对话
      const dir = getChatDir(characterId)
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  // 导出对话
  ipcMain.handle('chat:exportChat', async (_e, characterId: string, sessionId: string, format: 'md' | 'json') => {
    safeId(characterId)
    safeId(sessionId)
    const messages = readMessages(characterId, sessionId)
    if (format === 'json') {
      return JSON.stringify(messages, null, 2)
    }
    // Markdown 格式
    let md = `# 对话记录\n\n`
    for (const msg of messages) {
      const role = msg.role === 'user' ? '🧑 用户' : msg.role === 'assistant' ? '🎭 AI' : '系统'
      const time = new Date(msg.timestamp).toLocaleString('zh-CN')
      md += `### ${role} · ${time}\n\n${msg.content}\n\n---\n\n`
    }
    return md
  })

  // ===== 长记忆 =====

  ipcMain.handle('chat:updateMemory', async (_e, characterId: string, sessionId: string, memory: string) => {
    safeId(characterId)
    safeId(sessionId)
    const sessions = loadSessions(characterId)
    const session = sessions.find(s => s.id === sessionId)
    if (session) {
      session.memory = memory
      session.memoryUpdatedAt = Date.now()
      session.updatedAt = Date.now()
      saveSessions(characterId, sessions)
    }
  })

  ipcMain.handle('chat:toggleMemory', async (_e, characterId: string, sessionId: string, enabled: boolean) => {
    safeId(characterId)
    safeId(sessionId)
    const sessions = loadSessions(characterId)
    const session = sessions.find(s => s.id === sessionId)
    if (session) {
      session.memoryEnabled = enabled
      session.updatedAt = Date.now()
      saveSessions(characterId, sessions)
    }
  })

  ipcMain.handle('chat:setMemoryMode', async (_e, characterId: string, sessionId: string, mode: 'manual' | 'auto', interval?: number) => {
    safeId(characterId)
    safeId(sessionId)
    const sessions = loadSessions(characterId)
    const session = sessions.find(s => s.id === sessionId)
    if (session) {
      session.memoryMode = mode
      if (interval !== undefined) session.autoMemoryInterval = interval
      session.updatedAt = Date.now()
      saveSessions(characterId, sessions)
    }
  })

  ipcMain.handle('chat:getStats', async (_e, characterId: string, sessionId: string) => {
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
