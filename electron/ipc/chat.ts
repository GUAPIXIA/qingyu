import type { IpcMain } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync } from 'node:fs'
import { DIRS, readJson, writeJson } from '../services/storage'
import type { Message, ChatSession } from '../../shared/types'
import { nanoid } from 'nanoid'

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

/** 读取指定 session 的消息 */
function readMessages(characterId: string, sessionId: string): Message[] {
  const filePath = getSessionFile(characterId, sessionId)
  if (!existsSync(filePath)) return []
  const content = readFileSync(filePath, 'utf-8')
  const lines = content.split('\n').filter((line) => line.trim())
  const msgMap = new Map<string, Message>()
  for (const line of lines) {
    try {
      const msg = JSON.parse(line) as Message
      msgMap.set(msg.id, msg)
    } catch {
      // 忽略解析错误
    }
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
  writeFileSync(filePath, JSON.stringify(message) + '\n', { flag: 'a' }, 'utf-8')
}

/** 更新单条消息 */
function updateMessage(characterId: string, sessionId: string, message: Message): void {
  const messages = readMessages(characterId, sessionId)
  const idx = messages.findIndex((m) => m.id === message.id)
  if (idx >= 0) {
    messages[idx] = message
    writeMessages(characterId, sessionId, messages)
  } else {
    appendMessage(characterId, sessionId, message)
  }
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
    // 迁移旧数据
    migrateOldData(characterId)

    const sessions = loadSessions(characterId)

    // 如果没有会话，自动创建一个默认会话
    if (sessions.length === 0) {
      const defaultSession = createDefaultSession(characterId)
      sessions.push(defaultSession)
      saveSessions(characterId, sessions)
    }

    // 计算每个 session 的消息数
    return sessions.map(s => {
      const msgs = readMessages(characterId, s.id)
      return { ...s, messageCount: msgs.length, lastMessage: msgs[msgs.length - 1]?.content?.slice(0, 50) ?? '' }
    })
  })

  ipcMain.handle('chat:createSession', async (_e, characterId: string, title?: string) => {
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
    return session
  })

  ipcMain.handle('chat:deleteSession', async (_e, characterId: string, sessionId: string) => {
    // 删除 session 文件
    const filePath = getSessionFile(characterId, sessionId)
    if (existsSync(filePath)) {
      unlinkSync(filePath)
    }
    // 从 sessions.json 中移除
    const sessions = loadSessions(characterId).filter(s => s.id !== sessionId)
    saveSessions(characterId, sessions)
  })

  ipcMain.handle('chat:renameSession', async (_e, characterId: string, sessionId: string, title: string) => {
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

  ipcMain.handle('chat:saveMessage', async (_e, message: Message) => {
    const sid = message.sessionId || 'default'
    updateMessage(message.characterId, sid, message)

    // 更新 session 的 updatedAt
    const sessions = loadSessions(message.characterId)
    const session = sessions.find(s => s.id === sid)
    if (session) {
      session.updatedAt = Date.now()
      saveSessions(message.characterId, sessions)
    }
  })

  ipcMain.handle('chat:deleteMessage', async (_e, { id, characterId, sessionId }: { id: string; characterId: string; sessionId?: string }) => {
    const sid = sessionId || 'default'
    const messages = readMessages(characterId, sid)
    const filtered = messages.filter((m) => m.id !== id)
    writeMessages(characterId, sid, filtered)
  })

  ipcMain.handle('chat:clearChat', async (_e, characterId: string, sessionId?: string) => {
    if (sessionId) {
      // 清空指定 session
      const filePath = getSessionFile(characterId, sessionId)
      if (existsSync(filePath)) {
        unlinkSync(filePath)
      }
      // 重置 session updatedAt
      const sessions = loadSessions(characterId)
      const session = sessions.find(s => s.id === sessionId)
      if (session) {
        session.updatedAt = Date.now()
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
    const sessions = loadSessions(characterId)
    const session = sessions.find(s => s.id === sessionId)
    if (session) {
      session.memoryEnabled = enabled
      session.updatedAt = Date.now()
      saveSessions(characterId, sessions)
    }
  })

  ipcMain.handle('chat:setMemoryMode', async (_e, characterId: string, sessionId: string, mode: 'manual' | 'auto', interval?: number) => {
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
