/**
 * V12-03 TaskStore：持久任务快照 + requestId 索引（实施方案 §8）
 *
 * 目录：
 *   data/tasks/index.json          // requestId -> { taskId, state, sessionId, updatedAt }
 *   data/tasks/active/<taskId>.json // TaskSnapshot 原子写
 *   data/tasks/events/<taskId>.jsonl // TaskEventEnvelope append-only
 *
 * 约束：Windows 下 rename 原子性 + 损坏文件恢复 + 并发创建幂等
 */
import { join } from 'node:path'
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, renameSync, appendFileSync, statSync } from 'node:fs'
import { getDataDir } from '../services/storage'
import { createLogger } from '../services/logger'
import type { TaskSnapshot, TaskEventEnvelope, EventPage } from '../../shared/chat-core/events'
import type { DomainError } from '../../shared/chat-core/errors'

const log = createLogger('task-store')

function tasksDir(): string {
  return join(getDataDir(), 'tasks')
}
function activeDir(): string {
  return join(tasksDir(), 'active')
}
function eventsDir(): string {
  return join(tasksDir(), 'events')
}
function indexFile(): string {
  return join(tasksDir(), 'index.json')
}

export interface TaskIndexEntry {
  taskId: string
  requestId: string
  sessionId: string
  state: string
  updatedAt: number
}

function ensureDirs(): void {
  mkdirSync(activeDir(), { recursive: true })
  mkdirSync(eventsDir(), { recursive: true })
}

function atomicWriteJson(filePath: string, data: unknown): void {
  mkdirSync(join(filePath, '..'), { recursive: true })
  const tmp = `${filePath}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  renameSync(tmp, filePath)
}

function readJsonSafe<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T
  } catch {
    log.warn('JSON 读取失败（可能损坏）', { file: filePath.slice(-80) })
    return null
  }
}

function readIndex(): Record<string, TaskIndexEntry> {
  return readJsonSafe<Record<string, TaskIndexEntry>>(indexFile()) ?? {}
}

function writeIndex(idx: Record<string, TaskIndexEntry>): void {
  atomicWriteJson(indexFile(), idx)
}

// ===== 公开 API =====

export function getTaskSnapshot(taskId: string): TaskSnapshot | null {
  return readJsonSafe<TaskSnapshot>(join(activeDir(), `${taskId}.json`))
}

export function findByRequestId(requestId: string): TaskSnapshot | null {
  const idx = readIndex()[requestId]
  if (!idx) return null
  return getTaskSnapshot(idx.taskId)
}

export function createTask(snapshot: TaskSnapshot): TaskSnapshot {
  ensureDirs()
  // 幂等：同一 requestId 已存在则返回原任务（不重复创建）
  const existing = findByRequestId(snapshot.requestId)
  if (existing) return existing

  const file = join(activeDir(), `${snapshot.taskId}.json`)
  if (existsSync(file)) {
    // 极少数 taskId 碰撞（nanoid 重复）视为已存在
    return readJsonSafe<TaskSnapshot>(file) as TaskSnapshot
  }
  atomicWriteJson(file, snapshot)
  // 更新索引
  const idx = readIndex()
  idx[snapshot.requestId] = {
    taskId: snapshot.taskId,
    requestId: snapshot.requestId,
    sessionId: snapshot.sessionId,
    state: snapshot.state,
    updatedAt: snapshot.updatedAt,
  }
  writeIndex(idx)
  return snapshot
}

export function updateTask(taskId: string, patch: Partial<TaskSnapshot> | ((s: TaskSnapshot) => TaskSnapshot)): TaskSnapshot | null {
  const file = join(activeDir(), `${taskId}.json`)
  const current = readJsonSafe<TaskSnapshot>(file)
  if (!current) return null
  const next = typeof patch === 'function' ? (patch as (s: TaskSnapshot) => TaskSnapshot)(current) : { ...current, ...patch, updatedAt: Date.now() }
  atomicWriteJson(file, next)
  // 同步索引状态
  const idx = readIndex()
  if (idx[next.requestId]) {
    idx[next.requestId].state = next.state
    idx[next.requestId].updatedAt = next.updatedAt
    writeIndex(idx)
  }
  return next
}

export function listActiveTasks(): TaskSnapshot[] {
  ensureDirs()
  const files = readdirSync(activeDir()).filter((f) => f.endsWith('.json'))
  const out: TaskSnapshot[] = []
  for (const f of files) {
    const snap = readJsonSafe<TaskSnapshot>(join(activeDir(), f))
    if (snap) out.push(snap)
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

// ===== 事件日志 =====

export function appendEvent(event: TaskEventEnvelope): void {
  ensureDirs()
  const line = JSON.stringify(event) + '\n'
  const file = join(eventsDir(), `${event.taskId}.jsonl`)
  mkdirSync(eventsDir(), { recursive: true })
  appendFileSync(file, line, 'utf-8')
  // 同步快照的 lastSequence / accumulatedText 需由调用方 updateTask 完成，此处不重复写
  // 但为防丢失，同步更新索引的 updatedAt
  const idx = readIndex()
  if (idx[event.requestId]) {
    idx[event.requestId].updatedAt = event.timestamp
    writeIndex(idx)
  }
}

export function readEvents(taskId: string, afterSequence: number, limit = 200): EventPage {
  const file = join(eventsDir(), `${taskId}.jsonl`)
  if (!existsSync(file)) {
    return { events: [], nextAfterSequence: null }
  }
  const content = readFileSync(file, 'utf-8')
  const lines = content.split('\n').filter(Boolean)
  const all: TaskEventEnvelope[] = []
  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as TaskEventEnvelope
      if (ev.sequence > afterSequence) all.push(ev)
    } catch {
      // 单行损坏跳过，不影响后续
    }
  }
  all.sort((a, b) => a.sequence - b.sequence)
  const page = all.slice(0, limit)
  const next = all.length > limit ? page[page.length - 1].sequence : null
  // 压缩/缺口检测：afterSequence 已不在日志中但快照已推进，需 resync
  let resyncRequired = false
  let snapshot: TaskSnapshot | undefined
  const snap = getTaskSnapshot(taskId)
  if (snap) {
    // 压缩后：日志仅剩 terminal，但 lastSequence 已远大于 afterSequence，且首条 sequence > afterSequence+1
    const minSeq = all.length > 0 ? all[0].sequence : Infinity
    const isGap = afterSequence < snap.lastSequence && (all.length === 0 || minSeq > afterSequence + 1)
    if (isGap) {
      resyncRequired = true
      snapshot = snap
    }
  }
  return { events: page, nextAfterSequence: next, resyncRequired: resyncRequired || undefined, snapshot }
}

/** 启动对账：扫描 active，返回需标记 interrupted 的任务 */
export function scanActiveForReconcile(): TaskSnapshot[] {
  return listActiveTasks().filter((s) => !['completed', 'failed', 'cancelled', 'interrupted'].includes(s.state))
}

export function wipeTasksForTest(root?: string): void {
  const dir = root ?? tasksDir()
  try {
    const { rmSync } = require('node:fs')
    rmSync(dir, { recursive: true, force: true })
  } catch {}
}

// 供 reconciler 调用：补 terminal 事件（appendEvent）+ 更新状态
export function markInterrupted(taskId: string, error?: DomainError): TaskSnapshot | null {
  const snap = getTaskSnapshot(taskId)
  if (!snap || ['completed', 'failed', 'cancelled', 'interrupted'].includes(snap.state)) return snap
  const next: TaskSnapshot = {
    ...snap,
    state: 'interrupted',
    error: error ?? { code: 'TASK_INTERRUPTED', message: 'PC 进程退出导致中断', retryable: true },
    finishedAt: Date.now(),
    updatedAt: Date.now(),
  }
  return updateTask(taskId, next)
}
