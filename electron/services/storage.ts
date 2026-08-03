import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync, rmSync, renameSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { readFile, writeFile, readdir, rename } from 'node:fs/promises'
import { getDefaultSettings } from '../../shared/defaults'
import { migrateData, currentSchemaVersion } from './migration'
import { createLogger } from './logger'
import type { DataDomain } from './migration'

/** 获取数据目录 */
export function getDataDir(): string {
  return join(app.getPath('userData'), 'data')
}

/** 子目录定义 */
export const DIRS = {
  config: () => join(getDataDir(), 'config'),
  characters: () => join(getDataDir(), 'characters'),
  chats: () => join(getDataDir(), 'chats'),
  lorebooks: () => join(getDataDir(), 'lorebooks'),
  vectors: () => join(getDataDir(), 'vectors'),
  presets: () => join(getDataDir(), 'presets'),
  groups: () => join(getDataDir(), 'groups'),
  backups: () => join(getDataDir(), 'backups'),
} as const

/** 确保数据目录存在 */
export async function ensureDataDir(): Promise<void> {
  for (const dir of Object.values(DIRS)) {
    mkdirSync(dir(), { recursive: true })
  }
  // 如果没有 settings.json，创建默认配置
  const settingsPath = join(DIRS.config(), 'settings.json')
  if (!existsSync(settingsPath)) {
    writeFileSync(settingsPath, JSON.stringify(getDefaultSettings(), null, 2), 'utf-8')
  }
}

/** 读取 JSON 文件。
 *  传入 domain 时自动执行该数据域的版本迁移（旧数据升级到最新结构）。 */
export function readJson<T>(filePath: string, domain?: DataDomain): T | null {
  try {
    if (!existsSync(filePath)) return null
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as T
    if (domain) {
      const migrated = migrateData<T>(domain, parsed)
      if (migrated) {
        // 迁移成功：回写磁盘（自动带 schemaVersion），下次读取无需再迁移
        try { writeJson(filePath, migrated) } catch { /* 回写失败不影响本次使用 */ }
        return migrated
      }
    }
    return parsed
  } catch {
    // 修复：区分「文件不存在」与「文件损坏」，损坏时记录日志便于排查
    // （行为不变：仍返回 null，保证调用方兼容）
    if (existsSync(filePath)) {
      try {
        const logger = createLogger('storage')
        logger.warn('JSON 文件损坏或无法解析', { file: filePath.substring(0, 120) })
      } catch { /* 日志失败忽略 */ }
    }
    return null
  }
}

/** 写入 JSON 文件（传入 domain 时自动附加当前 schemaVersion）。
 *  L-05 修复：使用 temp 文件 + rename 保证原子写入，防止崩溃时数据损坏 */
export function writeJson(filePath: string, data: unknown, domain?: DataDomain): void {
  mkdirSync(join(filePath, '..'), { recursive: true })
  // 修复：数组数据域（如 sessions）不能被展开成对象，否则下次读取时 findIndex/find 会抛错
  const payload = domain && data && typeof data === 'object' && !Array.isArray(data)
    ? { ...(data as object), schemaVersion: currentSchemaVersion(domain) }
    : data
  const tmpPath = filePath + '.tmp'
  writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8')
  try {
    renameSync(tmpPath, filePath)
  } catch (err) {
    // BUG-34：rename 失败时清理残留的 temp 文件，避免下次写入/读取异常
    try { unlinkSync(tmpPath) } catch { /* ignore */ }
    throw err
  }
}

/** 列出目录下所有 JSON 文件 */
export function listJsonFiles<T>(dir: string): T[] {
  const results: T[] = []
  try {
    if (!existsSync(dir)) return results
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    for (const file of files) {
      const data = readJson<T>(join(dir, file))
      if (data) results.push(data)
    }
  } catch {
    // 忽略错误
  }
  return results
}

/** 删除文件 */
export function removeFile(filePath: string): void {
  try {
    if (existsSync(filePath)) unlinkSync(filePath)
  } catch {
    // 忽略错误
  }
}

/** 删除目录 */
export function removeDir(dirPath: string): void {
  try {
    if (existsSync(dirPath)) rmSync(dirPath, { recursive: true, force: true })
  } catch {
    // 忽略错误
  }
}

/**
 * 高效统计文件行数（仅扫描字节，不做字符串解析/JSON 解析）
 * 用于 JSONL 消息文件的行数统计，避免全量读取大文件
 */
export function countLines(filePath: string): number {
  if (!existsSync(filePath)) return 0
  try {
    const fd = openSync(filePath, 'r')
    try {
      const fileSize = statSync(filePath).size
      if (fileSize === 0) return 0
      let count = 0
      const BUF_SIZE = 64 * 1024
      const buf = Buffer.alloc(BUF_SIZE)
      let totalRead = 0
      while (totalRead < fileSize) {
        const toRead = Math.min(BUF_SIZE, fileSize - totalRead)
        const bytesRead = readSync(fd, buf, 0, toRead, totalRead)
        if (bytesRead === 0) break
        for (let i = 0; i < bytesRead; i++) {
          if (buf[i] === 0x0A) count++
        }
        totalRead += bytesRead
      }
      return count
    } finally {
      closeSync(fd)
    }
  } catch {
    return 0
  }
}

// ===================== 异步版本（热路径使用，避免阻塞主进程事件循环） =====================

/** 异步读取 JSON 文件 */
export async function readJsonAsync<T>(filePath: string, domain?: DataDomain): Promise<T | null> {
  try {
    if (!existsSync(filePath)) return null
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as T
    if (domain) {
      const migrated = migrateData<T>(domain, parsed)
      if (migrated) {
        try { writeJsonAsync(filePath, migrated) } catch { /* 回写失败不影响本次使用 */ }
        return migrated
      }
    }
    return parsed
  } catch {
    return null
  }
}

/** 异步写入 JSON 文件（原子写入：temp + rename） */
export async function writeJsonAsync(filePath: string, data: unknown): Promise<void> {
  const tmpPath = filePath + '.tmp'
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
  try {
    await rename(tmpPath, filePath)
  } catch (err) {
    // BUG-34：rename 失败时清理残留的 temp 文件
    try { unlinkSync(tmpPath) } catch { /* ignore */ }
    throw err
  }
}

// ===================== per-path 写锁（防御并发读-改-写竞态） =====================

/**
 * 同一文件路径的写操作队列锁。
 * 用于 sessions.json 等「读-改-写」场景：多个 IPC handler 并发操作同一文件时，
 * 串行执行避免后写入覆盖先写入的修改（BUG-10/19）。
 */
const fileWriteQueues = new Map<string, Promise<void>>()

export function withFileLock<T>(filePath: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = fileWriteQueues.get(filePath) ?? Promise.resolve()
  const run = prev.then(fn)
  // 链尾保存吞错后的 promise，保证队列继续推进（错误由调用方 await 捕获）
  const tail = run.then(() => {}, () => {})
  fileWriteQueues.set(filePath, tail)
  // NEW-5 修复：队列排空后清理 Map 条目，避免长期运行（多角色/多会话）内存无限增长
  tail.then(() => {
    if (fileWriteQueues.get(filePath) === tail) {
      fileWriteQueues.delete(filePath)
    }
  })
  return run
}

/** 异步列出目录下所有 JSON 文件（并行读取，不阻塞事件循环） */
export async function listJsonFilesAsync<T>(dir: string): Promise<T[]> {
  try {
    if (!existsSync(dir)) return []
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
    const results = await Promise.all(
      files.map((file) => readJsonAsync<T>(join(dir, file))),
    )
    return results.filter((r) => r !== null) as T[]
  } catch {
    return []
  }
}
