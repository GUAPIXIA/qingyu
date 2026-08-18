import type { IpcMain } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, renameSync, rmSync } from 'node:fs'
import { DIRS, readJson, writeJson, countLines, withFileLock } from '../services/storage'
import { escapeMarkdownContent } from '../utils/markdown'
import { createLogger } from '../services/logger'
import type { GroupChat, GroupMessage, GroupSession } from '../../shared/types'
import { nanoid } from 'nanoid'
import { safeId } from '../utils/pathGuard'

const log = createLogger('group')

/** group:updateSession 允许更新的字段白名单（防止注入 id/groupId 等关键字段） */
const GROUP_UPDATE_SESSION_FIELDS = new Set([
  'title',
  'messageCount',
  'memoryEnabled',
  'memoryMode',
  'autoMemoryInterval',
  'memory',
  'memoryCurrentState',
  'memoryUpdatedAt',
  'memoryFacts',
  'memoryFactHistory',
  'memoryFactParseFailureCount',
  'memoryFactRetryAfterVersion',
  'factsVectors',
  'memoryLastMessageId',
  'memoryVersion',
  'factsVectorVersion',
  'compressedSummary',
  'compressedRange',
])

// ===================== 路径工具 =====================

function getGroupDir(groupId: string): string {
  return join(DIRS.groups(), groupId)
}

function getSessionsFile(groupId: string): string {
  return join(getGroupDir(groupId), 'sessions.json')
}

function getSessionFile(groupId: string, sessionId: string): string {
  return join(getGroupDir(groupId), `${sessionId}.jsonl`)
}

function getIndexFile(): string {
  return join(DIRS.groups(), 'index.json')
}

// ===================== 群聊 CRUD =====================

function loadGroups(): GroupChat[] {
  const file = getIndexFile()
  if (!existsSync(file)) return []
  return readJson<GroupChat[]>(file) ?? []
}

function saveGroups(groups: GroupChat[]): void {
  mkdirSync(DIRS.groups(), { recursive: true })
  writeJson(getIndexFile(), groups)
}

// ===================== 会话管理 =====================

function loadSessions(groupId: string): GroupSession[] {
  const file = getSessionsFile(groupId)
  if (!existsSync(file)) return []
  return readJson<GroupSession[]>(file) ?? []
}

function saveSessions(groupId: string, sessions: GroupSession[]): void {
  const dir = getGroupDir(groupId)
  mkdirSync(dir, { recursive: true })
  writeJson(getSessionsFile(groupId), sessions)
}

// 与 chat.ts 对齐：sessions.json / index.json / 消息文件的读-改-写统一走 per-file 锁，
// 避免并发 IPC handler 互相覆盖（BUG-10/19 同类问题）
function withIndexLock<T>(fn: () => T | Promise<T>): Promise<T> {
  return withFileLock(getIndexFile(), fn)
}

function withSessionsLock<T>(groupId: string, fn: () => T | Promise<T>): Promise<T> {
  return withFileLock(getSessionsFile(groupId), fn)
}

function withSessionFileLock<T>(groupId: string, sessionId: string, fn: () => T | Promise<T>): Promise<T> {
  return withFileLock(getSessionFile(groupId, sessionId), fn)
}

// ===================== 消息管理 =====================

function readMessages(groupId: string, sessionId: string): GroupMessage[] {
  const file = getSessionFile(groupId, sessionId)
  if (!existsSync(file)) return []
  const content = readFileSync(file, 'utf-8')
  const lines = content.split('\n').filter(line => line.trim())
  const messages: GroupMessage[] = []

  for (const line of lines) {
    try {
      const msg = JSON.parse(line) as GroupMessage
      if (msg.id && typeof msg.content === 'string') {
        messages.push(msg)
      }
    } catch {
      // 跳过损坏行
    }
  }

  return messages.sort((a, b) => a.timestamp - b.timestamp)
}

function writeMessages(groupId: string, sessionId: string, messages: GroupMessage[]): void {
  const dir = getGroupDir(groupId)
  mkdirSync(dir, { recursive: true })
  const filePath = getSessionFile(groupId, sessionId)
  const lines = messages.map(m => JSON.stringify(m)).join('\n') + '\n'
  // 原子写入：temp + rename，防止崩溃导致会话文件损坏（与 chat.ts writeMessages 一致）
  const tmpPath = filePath + '.tmp'
  writeFileSync(tmpPath, lines, 'utf-8')
  try {
    renameSync(tmpPath, filePath)
  } catch (err) {
    try { unlinkSync(tmpPath) } catch { /* ignore */ }
    throw err
  }
}

function appendMessage(groupId: string, sessionId: string, message: GroupMessage): void {
  const dir = getGroupDir(groupId)
  mkdirSync(dir, { recursive: true })
  const line = JSON.stringify(message) + '\n'
  writeFileSync(getSessionFile(groupId, sessionId), line, { flag: 'a' })
}

function updateMessage(groupId: string, sessionId: string, message: GroupMessage): void {
  const messages = readMessages(groupId, sessionId)
  const idx = messages.findIndex(m => m.id === message.id)
  if (idx >= 0) {
    messages[idx] = message
  } else {
    messages.push(message)
  }
  writeMessages(groupId, sessionId, messages)
}

// ===================== IPC 注册 =====================

export function registerGroupIPC(ipcMain: IpcMain): void {

  // ---- 群聊 CRUD ----

  ipcMain.handle('group:list', async () => {
    return loadGroups()
  })

  ipcMain.handle('group:save', async (_e, group: GroupChat) => {
    safeId(group.id)
    group.updatedAt = Date.now()
    await withIndexLock(() => {
      const groups = loadGroups()
      const idx = groups.findIndex(g => g.id === group.id)
      if (idx >= 0) {
        groups[idx] = group
      } else {
        groups.push(group)
      }
      saveGroups(groups)
    })
    log.info('群聊已保存', { groupId: group.id, name: group.name })
  })

  ipcMain.handle('group:delete', async (_e, id: string) => {
    safeId(id)
    await withIndexLock(() => {
      const groups = loadGroups().filter(g => g.id !== id)
      saveGroups(groups)
    })
    // 删除群聊目录（rename 后删除，避免与进行中的写入冲突）
    const dir = getGroupDir(id)
    if (existsSync(dir)) {
      const trashDir = join(DIRS.groups(), `.deleting-${id}-${Date.now()}`)
      renameSync(dir, trashDir)
      rmSync(trashDir, { recursive: true, force: true })
    }
    log.info('群聊已删除', { groupId: id })
  })

  // ---- 会话管理 ----

  ipcMain.handle('group:listSessions', async (_e, groupId: string) => {
    safeId(groupId)
    return withSessionsLock(groupId, () => {
      const sessions = loadSessions(groupId)
      if (sessions.length === 0) {
        const now = Date.now()
        const defaultSession: GroupSession = {
          id: nanoid(),
          groupId,
          title: '默认会话',
          messageCount: 0,
          createdAt: now,
          updatedAt: now,
          memoryEnabled: false,
          memoryMode: 'manual',
          autoMemoryInterval: 10,
          memory: '',
          memoryUpdatedAt: 0,
        }
        sessions.push(defaultSession)
        saveSessions(groupId, sessions)
      }
      // P-1 修复：仅统计行数获取 messageCount，避免全量 JSON 解析
      return sessions.map(s => {
        const filePath = getSessionFile(groupId, s.id)
        return { ...s, messageCount: countLines(filePath) }
      })
    })
  })

  ipcMain.handle('group:createSession', async (_e, groupId: string) => {
    safeId(groupId)
    return withSessionsLock(groupId, () => {
      const sessions = loadSessions(groupId)
      const now = Date.now()
      const session: GroupSession = {
        id: nanoid(),
        groupId,
        title: `新对话 ${sessions.length + 1}`,
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
        memoryEnabled: false,
        memoryMode: 'manual',
        autoMemoryInterval: 10,
        memory: '',
        memoryUpdatedAt: 0,
      }
      sessions.push(session)
      saveSessions(groupId, sessions)
      return session
    })
  })

  ipcMain.handle('group:deleteSession', async (_e, groupId: string, sessionId: string) => {
    safeId(groupId)
    safeId(sessionId)
    // R1 修复：先取消息文件锁删除文件（锁序与 saveMessage 一致：消息锁 → sessions 锁）
    await withSessionFileLock(groupId, sessionId, () => {
      const file = getSessionFile(groupId, sessionId)
      if (existsSync(file)) {
        unlinkSync(file)
      }
    })
    return withSessionsLock(groupId, () => {
      const sessions = loadSessions(groupId).filter(s => s.id !== sessionId)
      saveSessions(groupId, sessions)
    })
  })

  ipcMain.handle('group:renameSession', async (_e, groupId: string, sessionId: string, title: string) => {
    safeId(groupId)
    safeId(sessionId)
    return withSessionsLock(groupId, () => {
      const sessions = loadSessions(groupId)
      const session = sessions.find(s => s.id === sessionId)
      if (session) {
        session.title = title
        session.updatedAt = Date.now()
        saveSessions(groupId, sessions)
      }
    })
  })

  // ---- 消息管理 ----

  ipcMain.handle('group:listMessages', async (_e, groupId: string, sessionId?: string) => {
    safeId(groupId)
    let sid = sessionId
    if (sid) safeId(sid)
    if (!sid) {
      const sessions = loadSessions(groupId)
      sid = sessions[0]?.id
    }
    if (!sid) return []
    return readMessages(groupId, sid)
  })

  ipcMain.handle('group:saveMessage', async (_e, groupId: string, sessionId: string, msg: GroupMessage) => {
    safeId(groupId)
    safeId(sessionId)
    // 读-改-写整体持锁，避免全量重写覆盖并发追加/删除的消息
    await withSessionFileLock(groupId, sessionId, () => {
      const messages = readMessages(groupId, sessionId)
      const existing = messages.find(m => m.id === msg.id)
      if (existing) {
        updateMessage(groupId, sessionId, msg)
      } else {
        appendMessage(groupId, sessionId, msg)
      }
    })

    // 更新 session updatedAt
    await withSessionsLock(groupId, () => {
      const sessions = loadSessions(groupId)
      const session = sessions.find(s => s.id === sessionId)
      if (session) {
        session.updatedAt = Date.now()
        saveSessions(groupId, sessions)
      }
    })
  })

  // 批量保存消息：一次 IPC 读-改-写全部消息（群聊流式/自由发言拆分多次单条保存的优化，
  // 减少 3-5 次 IPC 往返与文件全量重写为 1 次）
  ipcMain.handle('group:saveMessagesBatch', async (_e, groupId: string, sessionId: string, msgs: GroupMessage[]) => {
    safeId(groupId)
    safeId(sessionId)
    if (!Array.isArray(msgs) || msgs.length === 0) return
    if (msgs.length > 200) {
      throw new Error('批量保存消息数超过上限（200）')
    }
    await withSessionFileLock(groupId, sessionId, () => {
      const messages = readMessages(groupId, sessionId)
      const existingIds = new Set(messages.map(m => m.id))
      for (const msg of msgs) {
        if (!msg || typeof msg.id !== 'string' || msg.id.length > 64) continue
        if (existingIds.has(msg.id)) {
          // 已存在则原位更新
          const idx = messages.findIndex(m => m.id === msg.id)
          messages[idx] = msg
        } else {
          messages.push(msg)
          existingIds.add(msg.id)
        }
      }
      writeMessages(groupId, sessionId, messages)
    })

    // 更新 session updatedAt（与单条保存一致，仅一次）
    await withSessionsLock(groupId, () => {
      const sessions = loadSessions(groupId)
      const session = sessions.find(s => s.id === sessionId)
      if (session) {
        session.updatedAt = Date.now()
        saveSessions(groupId, sessions)
      }
    })
  })

  ipcMain.handle('group:deleteMessage', async (_e, groupId: string, sessionId: string, messageId: string) => {
    safeId(groupId)
    safeId(sessionId)
    safeId(messageId)
    await withSessionFileLock(groupId, sessionId, () => {
      const messages = readMessages(groupId, sessionId)
      const filtered = messages.filter(m => m.id !== messageId)
      writeMessages(groupId, sessionId, filtered)
    })

    await withSessionsLock(groupId, () => {
      const sessions = loadSessions(groupId)
      const session = sessions.find(s => s.id === sessionId)
      if (session) {
        session.updatedAt = Date.now()
        saveSessions(groupId, sessions)
      }
    })
  })

  ipcMain.handle('group:editMessage', async (_e, groupId: string, sessionId: string, messageId: string, content: string) => {
    safeId(groupId)
    safeId(sessionId)
    safeId(messageId)
    await withSessionFileLock(groupId, sessionId, () => {
      const messages = readMessages(groupId, sessionId)
      const message = messages.find(m => m.id === messageId)
      if (message) {
        message.content = content
        writeMessages(groupId, sessionId, messages)
      }
    })
  })

  ipcMain.handle('group:clearChat', async (_e, groupId: string, sessionId?: string) => {
    safeId(groupId)
    if (sessionId) {
      safeId(sessionId)
      // R1 修复：先取消息文件锁删除文件（锁序与 saveMessage 一致：消息锁 → sessions 锁）
      await withSessionFileLock(groupId, sessionId, () => {
        const file = getSessionFile(groupId, sessionId)
        if (existsSync(file)) {
          unlinkSync(file)
        }
      })
      return withSessionsLock(groupId, () => {
        const sessions = loadSessions(groupId)
        const session = sessions.find(s => s.id === sessionId)
        if (session) {
          session.updatedAt = Date.now()
          session.messageCount = 0
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
          saveSessions(groupId, sessions)
        }
      })
    } else {
      // 清空整个群聊（含所有会话）：先对现有文件排队加锁，再 rename 后删除
      const dir = getGroupDir(groupId)
      if (existsSync(dir)) {
        const files = readdirSync(dir).map((f) => join(dir, f))
        await Promise.all(files.map((f) => withFileLock(f, () => {})))
        const trashDir = join(DIRS.groups(), `.deleting-${groupId}-${Date.now()}`)
        renameSync(dir, trashDir)
        rmSync(trashDir, { recursive: true, force: true })
      }
    }
  })

  // ---- 记忆管理 ----

  ipcMain.handle('group:updateMemory', async (_e, groupId: string, sessionId: string, memory: string) => {
    safeId(groupId)
    safeId(sessionId)
    return withSessionsLock(groupId, () => {
      const sessions = loadSessions(groupId)
      const session = sessions.find(s => s.id === sessionId)
      if (session) {
        session.memory = memory
        session.memoryUpdatedAt = Date.now()
        session.updatedAt = Date.now()
        saveSessions(groupId, sessions)
      }
    })
  })

  ipcMain.handle('group:toggleMemory', async (_e, groupId: string, sessionId: string, enabled: boolean) => {
    safeId(groupId)
    safeId(sessionId)
    return withSessionsLock(groupId, () => {
      const sessions = loadSessions(groupId)
      const session = sessions.find(s => s.id === sessionId)
      if (session) {
        session.memoryEnabled = enabled
        session.updatedAt = Date.now()
        saveSessions(groupId, sessions)
      }
    })
  })

  ipcMain.handle('group:setMemoryMode', async (_e, groupId: string, sessionId: string, mode: 'manual' | 'auto', interval?: number) => {
    safeId(groupId)
    safeId(sessionId)
    return withSessionsLock(groupId, () => {
      const sessions = loadSessions(groupId)
      const session = sessions.find(s => s.id === sessionId)
      if (session) {
        session.memoryMode = mode
        if (interval !== undefined) session.autoMemoryInterval = interval
        session.updatedAt = Date.now()
        saveSessions(groupId, sessions)
      }
    })
  })

  /** 通用会话字段更新（长记忆事实等） */
  ipcMain.handle('group:updateSession', async (_e, groupId: string, sessionId: string, updates: Record<string, unknown>) => {
    safeId(groupId)
    safeId(sessionId)
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      throw new Error('参数无效：updates 必须为对象')
    }
    // 字段白名单：仅允许更新常规会话字段，防止注入 id/groupId 等关键字段
    const clean: Record<string, unknown> = {}
    for (const key of Object.keys(updates)) {
      if (!GROUP_UPDATE_SESSION_FIELDS.has(key)) continue
      const value = updates[key]
      if (key === 'title' && typeof value === 'string' && value.length > 200) {
        throw new Error('标题长度不能超过 200 字符')
      }
      clean[key] = value
    }
    return withSessionsLock(groupId, () => {
      const sessions = loadSessions(groupId)
      const session = sessions.find(s => s.id === sessionId)
      if (session) {
        Object.assign(session, clean)
        session.updatedAt = Date.now()
        saveSessions(groupId, sessions)
      }
    })
  })

  // ---- 导出 ----

  ipcMain.handle('group:exportChat', async (_e, groupId: string, sessionId: string, format: 'json' | 'md') => {
    safeId(groupId)
    safeId(sessionId)
    const messages = readMessages(groupId, sessionId)
    if (format === 'json') {
      return JSON.stringify(messages, null, 2)
    }
    // Markdown 导出（R5/N15 修复：内容统一转义，防 # 标题 / *斜体* / ![图片] 破坏格式）
    let md = ''
    for (const m of messages) {
      const speaker = m.characterId === '__user__' ? '用户' : m.characterId
      md += `**${speaker}** (${new Date(m.timestamp).toLocaleString()}):\n${escapeMarkdownContent(m.content)}\n\n`
    }
    return md
  })
}

// ============================================================================
// 数据层门面（阶段二：桥接层群聊复用，与 IPC handler 共用底层存储函数与锁）
// ============================================================================
export const groupData = {
  /** 群聊列表 */
  listGroups: (): GroupChat[] => loadGroups(),

  /** 群聊会话列表（无会话时自动创建默认会话，与 group:listSessions 一致） */
  listSessions: async (groupId: string): Promise<GroupSession[]> => {
    safeId(groupId)
    return withSessionsLock(groupId, () => {
      const sessions = loadSessions(groupId)
      if (sessions.length === 0) {
        const now = Date.now()
        const defaultSession: GroupSession = {
          id: nanoid(),
          groupId,
          title: '默认会话',
          messageCount: 0,
          createdAt: now,
          updatedAt: now,
          memoryEnabled: false,
          memoryMode: 'manual',
          autoMemoryInterval: 10,
          memory: '',
          memoryUpdatedAt: 0,
        }
        sessions.push(defaultSession)
        saveSessions(groupId, sessions)
      }
      return sessions.map((s) => {
        const filePath = getSessionFile(groupId, s.id)
        return { ...s, messageCount: countLines(filePath) }
      })
    })
  },

  /** 读群聊消息（按时间升序） */
  readMessages: (groupId: string, sessionId: string): GroupMessage[] =>
    readMessages(groupId, sessionId),

  /** 追加一条群聊消息（用户发言落盘，与渲染层同一 JSONL 路径） */
  appendMessage: (groupId: string, sessionId: string, message: GroupMessage): void =>
    appendMessage(groupId, sessionId, message),

  /** 覆盖式写回（编辑/删除） */
  updateMessage: (groupId: string, sessionId: string, message: GroupMessage): void =>
    updateMessage(groupId, sessionId, message),

  /** 删除单条消息 */
  deleteMessage: async (groupId: string, sessionId: string, messageId: string): Promise<void> => {
    safeId(groupId)
    safeId(sessionId)
    safeId(messageId)
    await withSessionFileLock(groupId, sessionId, () => {
      const messages = readMessages(groupId, sessionId).filter((m) => m.id !== messageId)
      writeMessages(groupId, sessionId, messages)
    })
  },

  /** 新建群聊会话（与 IPC handler group:createSession 同一路径） */
  createSession: async (groupId: string): Promise<GroupSession> => {
    safeId(groupId)
    return withSessionsLock(groupId, () => {
      const sessions = loadSessions(groupId)
      const now = Date.now()
      const session: GroupSession = {
        id: nanoid(),
        groupId,
        title: `新对话 ${sessions.length + 1}`,
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
        memoryEnabled: false,
        memoryMode: 'manual',
        autoMemoryInterval: 10,
        memory: '',
        memoryUpdatedAt: 0,
      }
      sessions.push(session)
      saveSessions(groupId, sessions)
      return session
    })
  },

  /** 重命名群聊会话（与 IPC handler group:renameSession 同一路径） */
  renameSession: async (groupId: string, sessionId: string, title: string): Promise<void> => {
    safeId(groupId)
    safeId(sessionId)
    await withSessionsLock(groupId, () => {
      const sessions = loadSessions(groupId)
      const session = sessions.find((s) => s.id === sessionId)
      if (session) {
        session.title = title
        session.updatedAt = Date.now()
        saveSessions(groupId, sessions)
      }
    })
  },

  /** 保存/新增群聊（与 IPC handler group:save 同一路径） */
  saveGroup: async (group: GroupChat): Promise<void> => {
    safeId(group.id)
    group.updatedAt = Date.now()
    await withIndexLock(() => {
      const groups = loadGroups()
      const idx = groups.findIndex((g) => g.id === group.id)
      if (idx >= 0) groups[idx] = group
      else groups.push(group)
      saveGroups(groups)
    })
  },
}

export type GroupData = typeof groupData
