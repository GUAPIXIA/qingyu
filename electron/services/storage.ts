import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync, rmSync, renameSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { readFile, writeFile, readdir, rename } from 'node:fs/promises'
import { getDefaultSettings } from '../../shared/defaults'

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

/** 读取 JSON 文件 */
export function readJson<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null
    const raw = readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** 写入 JSON 文件 */
// L-05 修复：使用 temp 文件 + rename 保证原子写入，防止崩溃时数据损坏
export function writeJson(filePath: string, data: unknown): void {
  mkdirSync(join(filePath, '..'), { recursive: true })
  const tmpPath = filePath + '.tmp'
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
  renameSync(tmpPath, filePath)
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
export async function readJsonAsync<T>(filePath: string): Promise<T | null> {
  try {
    if (!existsSync(filePath)) return null
    const raw = await readFile(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** 异步写入 JSON 文件（原子写入：temp + rename） */
export async function writeJsonAsync(filePath: string, data: unknown): Promise<void> {
  const tmpPath = filePath + '.tmp'
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
  await rename(tmpPath, filePath)
}

/** 异步列出目录下所有 JSON 文件（并行读取，不阻塞事件循环） */
export async function listJsonFilesAsync<T>(dir: string): Promise<T[]> {
  try {
    if (!existsSync(dir)) return []
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
    const results = await Promise.all(
      files.map((file) => readJsonAsync<T>(join(dir, file))),
    )
    return results.filter((r): r is T => r !== null)
  } catch {
    return []
  }
}
