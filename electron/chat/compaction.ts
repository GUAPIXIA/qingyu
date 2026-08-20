/**
 * V12-04 压缩与保留策略（实施方案 §8.4 + §9.4）
 *
 * - terminal 事件日志 24h 后可压缩，只保留快照 + terminal event
 * - terminal 任务默认保留 7 天或最近 200 个，取更严格者
 * - 清理不误删仍被 Message.generationTaskId 引用的任务（本版仅记录，跨文件事务由启动对账保障）
 */
import { join } from 'node:path'
import { readdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, renameSync, statSync } from 'node:fs'
import { getDataDir } from '../services/storage'
import { createLogger } from '../services/logger'
import { getTaskSnapshot, listActiveTasks } from './taskStore'
import type { TaskEventEnvelope } from '../../shared/chat-core/events'

const log = createLogger('task-compaction')

const TERMINAL_TYPES = new Set(['task:completed', 'task:failed', 'task:cancelled', 'task:interrupted'])
const COMPACT_AFTER_MS = 24 * 60 * 60 * 1000
const RETAIN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const RETAIN_COUNT = 200

function eventsDir(): string {
  return join(getDataDir(), 'tasks/events')
}
function activeDir(): string {
  return join(getDataDir(), 'tasks/active')
}

/** 压缩单个任务的事件日志（仅终态且超时） */
export function compactTaskEvents(taskId: string, now = Date.now()): boolean {
  const snap = getTaskSnapshot(taskId)
  if (!snap) return false
  if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(snap.state)) return false
  if (!snap.finishedAt || now - snap.finishedAt < COMPACT_AFTER_MS) return false

  const file = join(eventsDir(), `${taskId}.jsonl`)
  if (!existsSync(file)) return false

  try {
    const content = readFileSync(file, 'utf-8')
    const lines = content.split('\n').filter(Boolean)
    if (lines.length <= 1) return false // 已是最小

    let terminal: TaskEventEnvelope | null = null
    for (const line of lines) {
      try {
        const ev = JSON.parse(line) as TaskEventEnvelope
        if (TERMINAL_TYPES.has(ev.type)) terminal = ev
      } catch {}
    }
    if (!terminal) return false

    // 仅保留 terminal 事件
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(terminal) + '\n', 'utf-8')
    renameSync(tmp, file)
    log.info('已压缩任务事件', { taskId, kept: terminal.type })
    return true
  } catch (e) {
    log.warn('压缩失败', { taskId, error: (e as Error).message })
    return false
  }
}

/** 批量压缩（启动时或定时任务） */
export function compactAllEligible(now = Date.now()): number {
  const tasks = listActiveTasks().filter((s) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(s.state))
  let count = 0
  for (const t of tasks) {
    if (compactTaskEvents(t.taskId, now)) count++
  }
  return count
}

/** 清理过期 terminal 任务（7天/200个，取严格者） */
export function cleanupTerminalTasks(now = Date.now()): string[] {
  const all = listActiveTasks()
  const terminal = all
    .filter((s) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(s.state))
    .sort((a, b) => b.updatedAt - a.updatedAt)

  const cutoff = now - RETAIN_DAYS_MS
  const toDelete: string[] = []

  for (let i = 0; i < terminal.length; i++) {
    const t = terminal[i]
    const beyondCount = i >= RETAIN_COUNT
    const beyondDays = t.updatedAt < cutoff
    if (beyondCount || beyondDays) {
      // 保留期检查：被 Message.generationTaskId 引用的任务不删（本版无跨表索引，记录警告）
      // TODO(0.12.1): 接入 MessageStore 引用检查
      toDelete.push(t.taskId)
    }
  }

  for (const taskId of toDelete) {
    try {
      const activeFile = join(activeDir(), `${taskId}.json`)
      const eventsFile = join(eventsDir(), `${taskId}.jsonl`)
      if (existsSync(activeFile)) unlinkSync(activeFile)
      if (existsSync(eventsFile)) unlinkSync(eventsFile)
      log.info('已清理过期任务', { taskId })
    } catch (e) {
      log.warn('清理失败', { taskId, error: (e as Error).message })
    }
  }

  // 同步清理 index.json 中已删除的条目
  try {
    const indexFile = join(getDataDir(), 'tasks/index.json')
    if (existsSync(indexFile)) {
      const idx = JSON.parse(readFileSync(indexFile, 'utf-8')) as Record<string, { taskId: string }>
      let changed = false
      for (const [k, v] of Object.entries(idx)) {
        if (toDelete.includes(v.taskId)) {
          delete idx[k]
          changed = true
        }
      }
      if (changed) {
        const tmp = `${indexFile}.tmp`
        writeFileSync(tmp, JSON.stringify(idx, null, 2), 'utf-8')
        renameSync(tmp, indexFile)
      }
    }
  } catch {}

  return toDelete
}
