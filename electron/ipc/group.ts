import type { IpcMain } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, renameSync, rmSync } from 'node:fs'
import { DIRS, readJson, countLines, withFileLock } from '../services/storage'
import { escapeMarkdownContent } from '../utils/markdown'
import { createLogger } from '../services/logger'
import type { GroupChat, GroupMessage, GroupSession, Settings } from '../../shared/types'
import { getDefaultSettings } from '../../shared/defaults'
import { nanoid } from 'nanoid'
import { safeId } from '../utils/pathGuard'
import { isNarrativeMode, resolveNarrativeMode } from '../../shared/narrativeMode'
import { resolveDefaultGroupMemoryConfig } from '../../shared/defaultMemory'
import { withMessageIdentity } from '../../shared/messageIdentity'
import { commitThroughDomain, type DomainWriteFile } from '../domain/syncDomainService'

const log = createLogger('group')

/** 群聊实体的规范 payload */
function groupEntityPayload(group: GroupChat): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: group.name,
    memberIds: group.memberIds ?? [],
  }
  if (typeof group.createdAt === 'number') payload.createdAt = group.createdAt
  if (typeof group.updatedAt === 'number') payload.updatedAt = group.updatedAt
  return payload
}

/** 群会话实体的规范 payload */
function groupSessionEntityPayload(groupId: string, session: GroupSession): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...session } as unknown as Record<string, unknown>
  delete payload.id
  if (!payload.groupId) payload.groupId = groupId
  return payload
}

/** 群消息实体的规范 payload */
function groupMessageEntityPayload(sessionId: string, message: GroupMessage): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...message } as unknown as Record<string, unknown>
  delete payload.id
  if (!payload.sessionId) payload.sessionId = sessionId
  return payload
}

/** 解析已落盘 JSONL 的最终状态（同 id 行以最后一行为准） */
function readMessageMapFromDisk(filePath: string): Map<string, GroupMessage> {
  const map = new Map<string, GroupMessage>()
  if (!existsSync(filePath)) return map
  const content = readFileSync(filePath, 'utf-8')
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as GroupMessage
      if (parsed && typeof parsed.id === 'string' && parsed.id) map.set(parsed.id, parsed)
    } catch {
      /* 损坏行忽略 */
    }
  }
  return map
}

/**
 * 群聊目录级删除（S2-04）：回收站中的 sessions.json 与各 .jsonl
 * 写 tombstone 并在同一事务内删除文件。
 */
function journalTrashedGroupData(groupId: string, trashDir: string): void {
  const sessionsFile = join(trashDir, 'sessions.json')
  const sessions = existsSync(sessionsFile)
    ? (readJson<GroupSession[]>(sessionsFile) ?? [])
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
      domain: 'group',
      entityType: 'message',
      puts: [],
      deletes: messageDeletes,
      files: messageFiles,
    })
  }
  if (existsSync(sessionsFile)) {
    commitThroughDomain({
      domain: 'group',
      entityType: 'session',
      puts: [],
      deletes: sessions.map((s) => ({ entityId: s.id, parentId: groupId })),
      files: [{ path: sessionsFile, content: null }],
    })
  }
}

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
  'personaId',
  'narrativeMode',
  'dialogueDirectionsEnabled',
  'recentTriggeredIds',
  'lorebookCompressionCache',
])

const SETTINGS_FILE = () => join(DIRS.config(), 'settings.json')

function getDefaultPersonaId(): string | null {
  const settings = readJson<Settings>(SETTINGS_FILE()) ?? getDefaultSettings()
  return settings.defaultPersonaId ?? null
}

function getDefaultGroupNarrativeMode(groupId: string) {
  const settings = readJson<Settings>(SETTINGS_FILE()) ?? getDefaultSettings()
  const group = loadGroups().find((item) => item.id === groupId)
  return resolveNarrativeMode(group?.defaultNarrativeMode, settings.defaultNarrativeMode)
}

/** 新建群聊会话的默认长记忆配置：与渲染层 applyDefaultGroupMemory 共用 shared/defaultMemory 唯一决策表 */
function getDefaultGroupMemoryConfig() {
  const settings = readJson<Settings>(SETTINGS_FILE()) ?? getDefaultSettings()
  return resolveDefaultGroupMemoryConfig(settings)
}

function validateGroupNarrativeMode(group: GroupChat): void {
  if (group.defaultNarrativeMode !== undefined && !isNarrativeMode(group.defaultNarrativeMode)) {
    throw new Error('参数无效：defaultNarrativeMode')
  }
}

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

/** S2-04：index.json 与其 group journal 同一事务提交（按磁盘旧状态 diff） */
function saveGroups(groups: GroupChat[]): void {
  mkdirSync(DIRS.groups(), { recursive: true })
  const file = getIndexFile()
  const previous = existsSync(file) ? (readJson<GroupChat[]>(file) ?? []) : []
  const previousById = new Map(previous.map((g) => [g.id, JSON.stringify(g)]))
  const nextIds = new Set(groups.map((g) => g.id))

  commitThroughDomain({
    domain: 'group',
    entityType: 'group',
    puts: groups
      .filter((g) => previousById.get(g.id) !== JSON.stringify(g))
      .map((g) => ({ entityId: g.id, payload: groupEntityPayload(g), schemaVersion: 1 })),
    deletes: previous
      .filter((g) => !nextIds.has(g.id))
      .map((g) => ({ entityId: g.id })),
    files: [{ path: file, content: JSON.stringify(groups, null, 2) }],
  })
}

// ===================== 会话管理 =====================

function loadSessions(groupId: string): GroupSession[] {
  const file = getSessionsFile(groupId)
  if (!existsSync(file)) return []
  return readJson<GroupSession[]>(file) ?? []
}

/** S2-04：群会话文件与其 journal 同一事务提交 */
function saveSessions(groupId: string, sessions: GroupSession[]): void {
  const dir = getGroupDir(groupId)
  mkdirSync(dir, { recursive: true })
  const file = getSessionsFile(groupId)
  const previous = existsSync(file) ? (readJson<GroupSession[]>(file) ?? []) : []
  const previousById = new Map(previous.map((s) => [s.id, JSON.stringify(s)]))
  const nextIds = new Set(sessions.map((s) => s.id))

  commitThroughDomain({
    domain: 'group',
    entityType: 'session',
    puts: sessions
      .filter((s) => previousById.get(s.id) !== JSON.stringify(s))
      .map((s) => ({
        entityId: s.id,
        payload: groupSessionEntityPayload(groupId, s),
        parentId: groupId,
        references: [groupId],
        schemaVersion: 1,
      })),
    deletes: previous
      .filter((s) => !nextIds.has(s.id))
      .map((s) => ({ entityId: s.id, parentId: groupId })),
    files: [{ path: file, content: JSON.stringify(sessions, null, 2) }],
  })
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

function cleanGroupSessionUpdates(updates: Record<string, unknown>): Record<string, unknown> {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    throw new Error('参数无效：updates 必须为对象')
  }
  const clean: Record<string, unknown> = {}
  for (const key of Object.keys(updates)) {
    if (!GROUP_UPDATE_SESSION_FIELDS.has(key)) continue
    const value = updates[key]
    if (key === 'title' && typeof value === 'string' && value.length > 200) {
      throw new Error('标题长度不能超过 200 字符')
    }
    if (key === 'narrativeMode' && !isNarrativeMode(value)) {
      throw new Error('参数无效：narrativeMode')
    }
    if (key === 'dialogueDirectionsEnabled' && typeof value !== 'boolean') {
      throw new Error('参数无效：dialogueDirectionsEnabled')
    }
    clean[key] = value
  }
  return clean
}

async function updateSessionIfMemoryVersion(
  groupId: string,
  sessionId: string,
  expectedVersion: number,
  updates: Record<string, unknown>,
): Promise<{ applied: boolean; currentVersion: number }> {
  safeId(groupId)
  safeId(sessionId)
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new Error('参数无效：expectedVersion')
  const clean = cleanGroupSessionUpdates(updates)
  return withSessionsLock(groupId, () => {
    const sessions = loadSessions(groupId)
    const session = sessions.find((item) => item.id === sessionId)
    if (!session) throw new Error('会话不存在')
    const currentVersion = session.memoryVersion ?? 0
    if (currentVersion !== expectedVersion) return { applied: false, currentVersion }
    Object.assign(session, clean)
    session.updatedAt = Date.now()
    saveSessions(groupId, sessions)
    return { applied: true, currentVersion: session.memoryVersion ?? currentVersion }
  })
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

/** S2-04：群消息文件与其 journal 同一事务提交（按磁盘旧状态 diff） */
function writeMessages(groupId: string, sessionId: string, messages: GroupMessage[]): void {
  const dir = getGroupDir(groupId)
  mkdirSync(dir, { recursive: true })
  const filePath = getSessionFile(groupId, sessionId)
  const content = messages.map(m => JSON.stringify(m)).join('\n') + '\n'

  const previous = readMessageMapFromDisk(filePath)
  const nextIds = new Set(messages.map(m => m.id))
  commitThroughDomain({
    domain: 'group',
    entityType: 'message',
    puts: messages
      .filter((m) => {
        const before = previous.get(m.id)
        return !before || JSON.stringify(before) !== JSON.stringify(m)
      })
      .map((m) => ({
        entityId: m.id,
        payload: groupMessageEntityPayload(sessionId, m),
        parentId: sessionId,
        references: [sessionId],
        schemaVersion: 1,
      })),
    deletes: [...previous.values()]
      .filter((m) => !nextIds.has(m.id))
      .map((m) => ({ entityId: m.id, parentId: sessionId })),
    files: [{ path: filePath, content }],
  })
}

/** S2-04：追加单条群消息（append 事务，保持 O(1) 追加） */
function appendMessage(groupId: string, sessionId: string, message: GroupMessage): void {
  const dir = getGroupDir(groupId)
  mkdirSync(dir, { recursive: true })
  commitThroughDomain({
    domain: 'group',
    entityType: 'message',
    puts: [
      {
        entityId: message.id,
        payload: groupMessageEntityPayload(sessionId, message),
        parentId: sessionId,
        references: [sessionId],
        schemaVersion: 1,
      },
    ],
    deletes: [],
    files: [{ path: getSessionFile(groupId, sessionId), content: JSON.stringify(message) + '\n', append: true }],
  })
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
    validateGroupNarrativeMode(group)
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
      // sync-bypass-ok: 目录级回收站改名（不改变业务数据语义；实体 tombstone 由 journalTrashedGroupData 记账）
      renameSync(dir, trashDir)
      journalTrashedGroupData(id, trashDir)
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
          ...getDefaultGroupMemoryConfig(),
          memory: '',
          memoryUpdatedAt: 0,
          personaId: getDefaultPersonaId(),
          narrativeMode: getDefaultGroupNarrativeMode(groupId),
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
        ...getDefaultGroupMemoryConfig(),
        memory: '',
        memoryUpdatedAt: 0,
        personaId: getDefaultPersonaId(),
        narrativeMode: getDefaultGroupNarrativeMode(groupId),
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
    const normalizedMessage = withMessageIdentity(msg)
    await withSessionFileLock(groupId, sessionId, () => {
      const messages = readMessages(groupId, sessionId)
      const existing = messages.find(m => m.id === msg.id)
      if (existing) {
        updateMessage(groupId, sessionId, normalizedMessage)
      } else {
        appendMessage(groupId, sessionId, normalizedMessage)
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
          messages[idx] = withMessageIdentity(msg)
        } else {
          messages.push(withMessageIdentity(msg))
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
        // sync-bypass-ok: 目录级回收站改名（不改变业务数据语义；实体 tombstone 由 journalTrashedGroupData 记账）
        renameSync(dir, trashDir)
        journalTrashedGroupData(groupId, trashDir)
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
    const clean = cleanGroupSessionUpdates(updates)
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

  ipcMain.handle('group:updateSessionIfMemoryVersion', async (_e, groupId: string, sessionId: string, expectedVersion: number, updates: Record<string, unknown>) =>
    updateSessionIfMemoryVersion(groupId, sessionId, expectedVersion, updates))

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
          ...getDefaultGroupMemoryConfig(),
          memory: '',
          memoryUpdatedAt: 0,
          personaId: getDefaultPersonaId(),
          narrativeMode: getDefaultGroupNarrativeMode(groupId),
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
    appendMessage(groupId, sessionId, withMessageIdentity(message)),

  /** 覆盖式写回（编辑/删除） */
  updateMessage: (groupId: string, sessionId: string, message: GroupMessage): void =>
    updateMessage(groupId, sessionId, withMessageIdentity(message)),

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
        ...getDefaultGroupMemoryConfig(),
        memory: '',
        memoryUpdatedAt: 0,
        personaId: getDefaultPersonaId(),
        narrativeMode: getDefaultGroupNarrativeMode(groupId),
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

  /** 仅当磁盘中的 memoryVersion 仍等于 expectedVersion 时应用更新。 */
  updateSessionIfMemoryVersion,

  /** 通用群聊会话字段更新（桥接层与 IPC 共用白名单及叙事模式校验）。 */
  updateSession: async (groupId: string, sessionId: string, updates: Record<string, unknown>): Promise<void> => {
    safeId(groupId)
    safeId(sessionId)
    const clean = cleanGroupSessionUpdates(updates)
    await withSessionsLock(groupId, () => {
      const sessions = loadSessions(groupId)
      const session = sessions.find((item) => item.id === sessionId)
      if (!session) throw new Error('会话不存在')
      Object.assign(session, clean)
      session.updatedAt = Date.now()
      saveSessions(groupId, sessions)
    })
  },

  /** 保存/新增群聊（与 IPC handler group:save 同一路径） */
  saveGroup: async (group: GroupChat): Promise<void> => {
    safeId(group.id)
    validateGroupNarrativeMode(group)
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
