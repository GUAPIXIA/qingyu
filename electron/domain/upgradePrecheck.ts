/**
 * S9-01：启用同步域前的升级预检。
 *
 * 总方案 §3.4 / 阶段 9：PC 应用升级本身不触发全量预检、checkpoint 或 head bootstrap。
 * 仅当用户在同步中心**首次明确启用**任一同步域时执行本预检；用户取消后不改业务数据，
 * 也不在下次普通启动时自动重试。
 *
 * 预检项（阶段 9 S9-01）：Backup V2 可用空间、损坏 JSON/JSONL、重复 ID、孤儿媒体、schema。
 * Backup V2 checkpoint 与 journal heads 由 `runBootstrap` 在首次同步写入前建立，不在本模块重复。
 */
import { existsSync, readdirSync, readFileSync, statSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { defaultScanRoots } from './bootstrapScanners'

export type PrecheckSeverity = 'block' | 'warn' | 'info'

export type PrecheckKind =
  | 'disk_space'
  | 'corrupt_json'
  | 'corrupt_jsonl'
  | 'duplicate_id'
  | 'orphan_media'
  | 'schema_mismatch'
  | 'backup_v2_present'

export interface PrecheckItem {
  kind: PrecheckKind
  severity: PrecheckSeverity
  /** 仅路径文件名或计数，不含用户正文 */
  target: string
  detail: string
}

export interface UpgradePrecheckReport {
  ok: boolean
  items: PrecheckItem[]
  /** 可用空间（字节）；无法探测时为 null */
  freeBytes: number | null
  /** 预估需保留的 Backup V2 checkpoint 空间（字节） */
  requiredBytes: number
  scannedAt: number
}

export interface PrecheckOptions {
  /** 探测可用空间；测试可注入 */
  freeDiskBytes?: (dir: string) => number | null
  /** Backup V2 checkpoint 估计占用（默认 512 MiB 下限，避免小盘误放行） */
  requiredBytes?: number
  /** 额外扫描的媒体目录相对 userDataDir */
  mediaDirRelative?: string
  now?: number
}

const DEFAULT_REQUIRED_BYTES = 512 * 1024 * 1024

/** 简易可用空间探测；失败返回 null（报告记 info，不 block）。 */
export function defaultFreeDiskBytes(dir: string): number | null {
  try {
    const st = statfsSync(dir)
    return Number(st.bavail) * Number(st.bsize)
  } catch {
    return null
  }
}

function listDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function isDir(full: string): boolean {
  try {
    return statSync(full).isDirectory()
  } catch {
    return false
  }
}

function readTextSafe(full: string): string | null {
  try {
    return readFileSync(full, 'utf8')
  } catch {
    return null
  }
}

function considerJsonObject(text: string, entityType: string, idSeen: Map<string, number>, items: PrecheckItem[], target: string): void {
  try {
    const parsed = JSON.parse(text) as unknown
    const candidates: unknown[] = Array.isArray(parsed) ? parsed : [parsed]
    for (const raw of candidates) {
      if (!raw || typeof raw !== 'object') continue
      const id = (raw as { id?: unknown }).id
      if (typeof id !== 'string' || id.length === 0) continue
      const key = `${entityType}:${id}`
      idSeen.set(key, (idSeen.get(key) ?? 0) + 1)
    }
  } catch {
    items.push({
      kind: 'corrupt_json',
      severity: 'warn',
      target,
      detail: 'JSON 解析失败',
    })
  }
}

function considerJsonl(text: string, items: PrecheckItem[], target: string): void {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      JSON.parse(line)
    } catch {
      items.push({
        kind: 'corrupt_jsonl',
        severity: 'warn',
        target,
        detail: 'JSONL 解析失败',
      })
      return
    }
  }
}

function collectCorruptAndDuplicates(userDataDir: string, items: PrecheckItem[]): void {
  const roots = defaultScanRoots(userDataDir)
  const idSeen = new Map<string, number>()
  const scanDirs = [
    roots.configDir,
    roots.charactersDir,
    roots.presetsDir,
    roots.lorebooksDir,
    roots.groupsDir,
    roots.chatsDir,
  ]

  for (const dir of scanDirs) {
    if (!existsSync(dir)) continue
    for (const name of listDirSafe(dir)) {
      const full = join(dir, name)
      if (isDir(full)) {
        for (const child of listDirSafe(full)) {
          const childFull = join(full, child)
          if (child.endsWith('.json')) {
            const text = readTextSafe(childFull)
            if (text == null) {
              items.push({
                kind: 'corrupt_json',
                severity: 'warn',
                target: child,
                detail: '无法读取（占用或权限）',
              })
            } else {
              considerJsonObject(text, child === 'sessions.json' ? 'session' : 'character', idSeen, items, child)
            }
          } else if (child.endsWith('.jsonl')) {
            const text = readTextSafe(childFull)
            if (text == null) {
              items.push({ kind: 'corrupt_jsonl', severity: 'warn', target: child, detail: '无法读取' })
            } else {
              considerJsonl(text, items, child)
            }
          }
        }
        continue
      }
      if (name.endsWith('.json')) {
        const entityType = name.includes('settings')
          ? 'settings_public'
          : name.includes('usage')
            ? 'usage_record'
            : name.includes('mcp')
              ? 'mcp_public_config'
              : name.includes('quick')
                ? 'quick_reply_set'
                : name.includes('personas')
                  ? 'persona'
                  : name.includes('regex')
                    ? 'regex_rule'
                    : name.includes('index')
                      ? 'group'
                      : 'character'
        const text = readTextSafe(full)
        if (text == null) {
          items.push({ kind: 'corrupt_json', severity: 'warn', target: name, detail: '无法读取' })
        } else {
          considerJsonObject(text, entityType, idSeen, items, name)
        }
      } else if (name.endsWith('.jsonl')) {
        const text = readTextSafe(full)
        if (text == null) {
          items.push({ kind: 'corrupt_jsonl', severity: 'warn', target: name, detail: '无法读取' })
        } else {
          considerJsonl(text, items, name)
        }
      }
    }
  }

  for (const [key, count] of idSeen) {
    if (count > 1) {
      const sep = key.indexOf(':')
      const entityType = key.slice(0, sep)
      const entityId = key.slice(sep + 1)
      items.push({
        kind: 'duplicate_id',
        severity: 'block',
        target: entityId.slice(0, 40),
        detail: `${entityType} 出现 ${count} 次重复 ID`,
      })
    }
  }
}

function collectOrphanMedia(userDataDir: string, mediaDirRelative: string, items: PrecheckItem[]): void {
  const mediaDir = join(userDataDir, mediaDirRelative)
  if (!existsSync(mediaDir)) return
  const files: string[] = []
  const stack = [mediaDir]
  while (stack.length > 0) {
    const cur = stack.pop() as string
    for (const name of listDirSafe(cur)) {
      const full = join(cur, name)
      if (isDir(full)) stack.push(full)
      else files.push(name)
    }
  }
  if (files.length === 0) return

  const roots = defaultScanRoots(userDataDir)
  const haystackDirs = [
    roots.configDir,
    roots.charactersDir,
    roots.chatsDir,
    roots.groupsDir,
    roots.lorebooksDir,
  ]
  const blob: string[] = []
  let blobBytes = 0
  for (const dir of haystackDirs) {
    if (!existsSync(dir)) continue
    const stack2 = [dir]
    while (stack2.length > 0 && blobBytes < 4_000_000) {
      const cur = stack2.pop() as string
      for (const name of listDirSafe(cur)) {
        const full = join(cur, name)
        if (isDir(full)) stack2.push(full)
        else if (/\.(json|jsonl)$/i.test(name)) {
          const text = readTextSafe(full)
          if (text != null) {
            blob.push(text)
            blobBytes += text.length
          }
        }
      }
    }
  }
  const text = blob.join('\n')
  const orphans = files.filter((f) => !text.includes(f)).slice(0, 20)
  for (const orphan of orphans) {
    items.push({
      kind: 'orphan_media',
      severity: 'warn',
      target: orphan.slice(0, 60),
      detail: '媒体文件未被配置/角色/会话引用（迁移向导可跳过）',
    })
  }
}

function collectSchemaSignatures(userDataDir: string, items: PrecheckItem[]): void {
  const roots = defaultScanRoots(userDataDir)
  const settingsPath = join(roots.configDir, 'settings.json')
  if (!existsSync(settingsPath)) return
  const text = readTextSafe(settingsPath)
  if (text == null) {
    items.push({
      kind: 'schema_mismatch',
      severity: 'block',
      target: 'settings.json',
      detail: 'settings.json 不可读',
    })
    return
  }
  try {
    const raw = JSON.parse(text) as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      items.push({
        kind: 'schema_mismatch',
        severity: 'block',
        target: 'settings.json',
        detail: 'settings.json 顶层不是对象',
      })
      return
    }
    const rec = raw as Record<string, unknown>
    if (rec.connectionProfiles !== undefined && !Array.isArray(rec.connectionProfiles)) {
      items.push({
        kind: 'schema_mismatch',
        severity: 'block',
        target: 'settings.json:connectionProfiles',
        detail: 'connectionProfiles 形状不是数组',
      })
    }
  } catch {
    items.push({
      kind: 'schema_mismatch',
      severity: 'block',
      target: 'settings.json',
      detail: 'settings.json 不可解析（损坏）',
    })
  }
}

/**
 * 只读升级预检。不写业务数据、不创建 checkpoint、不建立 heads。
 * 首次启用同步域前调用；报告项交给同步中心展示跳过/修复。
 */
export function runUpgradePrecheck(
  userDataDir: string,
  options: PrecheckOptions = {},
): UpgradePrecheckReport {
  const now = options.now ?? Date.now()
  const requiredBytes = options.requiredBytes ?? DEFAULT_REQUIRED_BYTES
  const items: PrecheckItem[] = []

  const freeFn = options.freeDiskBytes ?? defaultFreeDiskBytes
  const freeBytes = freeFn(userDataDir)
  if (freeBytes == null) {
    items.push({
      kind: 'disk_space',
      severity: 'info',
      target: userDataDir.split(/[\\/]/).pop() ?? 'userData',
      detail: '无法探测可用空间；请自行确认磁盘剩余',
    })
  } else if (freeBytes < requiredBytes) {
    items.push({
      kind: 'disk_space',
      severity: 'block',
      target: String(freeBytes),
      detail: `可用空间不足（需约 ${Math.round(requiredBytes / (1024 * 1024))} MiB 供 Backup V2 checkpoint）`,
    })
  } else {
    items.push({
      kind: 'disk_space',
      severity: 'info',
      target: String(freeBytes),
      detail: '可用空间充足',
    })
  }

  items.push({
    kind: 'backup_v2_present',
    severity: 'info',
    target: 'checkpoints',
    detail: '首次启用时将创建带 hash 的 Backup V2 checkpoint（若取消则不写业务数据）',
  })

  collectCorruptAndDuplicates(userDataDir, items)
  collectOrphanMedia(userDataDir, options.mediaDirRelative ?? join('data', 'media'), items)
  collectSchemaSignatures(userDataDir, items)

  const ok = !items.some((i) => i.severity === 'block')
  return { ok, items, freeBytes, requiredBytes, scannedAt: now }
}
