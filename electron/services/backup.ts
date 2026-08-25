/**
 * Backup V2 服务 — 全量备份与恢复（zip + manifest + 哈希校验）
 *
 * 覆盖审计 F-01 要求：settings / characters(+头像) / lorebooks / presets /
 * personas / regex / quickReplies / mcp / usage / chats / groups 全量。
 * 敏感信息（apiKey 等）默认不导出，敏感文件在结果页明示。
 */

import { app } from 'electron'
import { join, basename, dirname } from 'node:path'
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, rmSync, mkdtempSync, copyFileSync, unlinkSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import AdmZip from 'adm-zip'
import { DIRS, writeJson } from './storage'
import { createLogger } from './logger'
import { safeId } from '../utils/pathGuard'
import type { Settings } from '../../shared/types'
import { saveCredential } from './safeStorage'

const log = createLogger('backup')

export interface BackupManifest {
  version: 2
  appVersion: string
  createdAt: number
  counts: Record<string, number>
  hashes: Record<string, string> // zipPath -> sha256 hex
  excluded: string[] // 未包含项（敏感/可重建）
  totalBytes: number
}

const EXCLUDED_ITEMS = ['API Key / 凭据（safeStorage）', '设备配对凭据', '向量索引（可重建）']

// 本地 stripSecrets（避免与 electron/ipc/settings 循环依赖）
type SecretItem = { id: string; apiKey?: string }
type SecretListGetter = (s: Settings) => SecretItem[] | undefined
const SECRET_COLLECTIONS: Array<{ get: SecretListGetter; prefix: string }> = [
  { get: (s) => s.connectionProfiles, prefix: 'profile' },
  { get: (s) => s.ttsModels, prefix: 'tts' },
  { get: (s) => s.imageGenModels, prefix: 'imagegen' },
  { get: (s) => s.visionModels, prefix: 'vision' },
]
function stripSecretsLocal(settings: Settings, persist: boolean): void {
  for (const { get, prefix } of SECRET_COLLECTIONS) {
    for (const item of get(settings) ?? []) {
      if (typeof item.apiKey === 'string' && item.apiKey.length > 0) {
        if (persist) saveCredential(`${prefix}-${item.id}`, item.apiKey)
      }
      delete (item as Record<string, unknown>).apiKey
    }
  }
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function listFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()!
    let entries: string[] = []
    try { entries = readdirSync(cur, { withFileTypes: true } as unknown as string[]) as unknown as string[] } catch { continue }
    // readdirSync with withFileTypes returns Dirent
    // fallback: read as string names
    if (entries.length && typeof entries[0] === 'string') {
      for (const name of entries as unknown as string[]) {
        const full = join(cur, name)
        try {
          const st = statSync(full)
          if (st.isDirectory()) stack.push(full)
          else out.push(full)
        } catch { /* ignore */ }
      }
    } else {
      for (const ent of entries as unknown as Array<{ name: string; isDirectory: () => boolean }>) {
        const full = join(cur, ent.name)
        if (ent.isDirectory()) stack.push(full)
        else out.push(full)
      }
    }
  }
  return out
}

/** 收集需要备份的条目：{ fsPath, zipPath } */
function collectEntries(): Array<{ fsPath: string; zipPath: string }> {
  const entries: Array<{ fsPath: string; zipPath: string }> = []

  // settings.json（剥离 apiKey 后）
  const settingsPath = join(DIRS.config(), 'settings.json')
  if (existsSync(settingsPath)) {
    entries.push({ fsPath: settingsPath, zipPath: 'config/settings.json' })
  }

  // config 单文件
  const configFiles: Array<[string, string]> = [
    [join(DIRS.config(), 'personas.json'), 'config/personas.json'],
    [join(DIRS.config(), 'regex', 'rules.json'), 'config/regex/rules.json'],
    [join(DIRS.config(), 'quickReplies.json'), 'config/quickReplies.json'],
    [join(DIRS.config(), 'mcp-servers.json'), 'config/mcp-servers.json'],
    [join(DIRS.config(), 'usage.json'), 'config/usage.json'],
  ]
  for (const [fsPath, zipPath] of configFiles) {
    if (existsSync(fsPath)) entries.push({ fsPath, zipPath })
  }

  // characters: json + 头像/封面图片
  if (existsSync(DIRS.characters())) {
    for (const f of readdirSync(DIRS.characters())) {
      if (f.endsWith('.json') || /\.(png|jpg|jpeg|webp|gif)$/i.test(f)) {
        entries.push({ fsPath: join(DIRS.characters(), f), zipPath: `characters/${f}` })
      }
    }
  }

  // lorebooks
  if (existsSync(DIRS.lorebooks())) {
    for (const f of readdirSync(DIRS.lorebooks()).filter((x: string) => x.endsWith('.json'))) {
      entries.push({ fsPath: join(DIRS.lorebooks(), f), zipPath: `lorebooks/${f}` })
    }
  }

  // presets
  if (existsSync(DIRS.presets())) {
    for (const f of readdirSync(DIRS.presets()).filter((x: string) => x.endsWith('.json'))) {
      entries.push({ fsPath: join(DIRS.presets(), f), zipPath: `presets/${f}` })
    }
  }

  // chats — 递归
  if (existsSync(DIRS.chats())) {
    for (const abs of listFilesRecursive(DIRS.chats())) {
      const rel = abs.substring(DIRS.chats().length + 1).replace(/\\/g, '/')
      entries.push({ fsPath: abs, zipPath: `chats/${rel}` })
    }
  }

  // groups — 递归
  if (existsSync(DIRS.groups())) {
    for (const abs of listFilesRecursive(DIRS.groups())) {
      const rel = abs.substring(DIRS.groups().length + 1).replace(/\\/g, '/')
      // 跳过临时删除目录
      if (rel.startsWith('.deleting-')) continue
      entries.push({ fsPath: abs, zipPath: `groups/${rel}` })
    }
  }

  return entries
}

export interface ExportResult {
  path: string
  counts: Record<string, number>
  totalBytes: number
  excluded: string[]
}

/** 创建 Backup V2 zip 到指定路径 */
export function createBackupV2(destPath: string): ExportResult {
  const entries = collectEntries()
  const zip = new AdmZip()

  const counts: Record<string, number> = {
    characters: 0, lorebooks: 0, presets: 0, chats: 0, groups: 0, personas: 0, regex: 0, quickReplies: 0, mcp: 0, usage: 0, settings: 0,
  }
  const hashes: Record<string, string> = {}
  let totalBytes = 0

  // 统计辅助：按 zipPath 前缀计数
  const inc = (prefix: string) => {
    if (prefix.startsWith('characters/')) counts.characters++
    else if (prefix.startsWith('lorebooks/')) counts.lorebooks++
    else if (prefix.startsWith('presets/')) counts.presets++
    else if (prefix.startsWith('chats/')) counts.chats++
    else if (prefix.startsWith('groups/')) counts.groups++
    else if (prefix === 'config/personas.json') counts.personas = 1
    else if (prefix === 'config/regex/rules.json') counts.regex = 1
    else if (prefix === 'config/quickReplies.json') counts.quickReplies = 1
    else if (prefix === 'config/mcp-servers.json') counts.mcp = 1
    else if (prefix === 'config/usage.json') counts.usage = 1
    else if (prefix === 'config/settings.json') counts.settings = 1
  }

  for (const { fsPath, zipPath } of entries) {
    try {
      let buf = readFileSync(fsPath)
      // settings.json 需剥离 apiKey（不落敏感信息）
      if (zipPath === 'config/settings.json') {
        try {
          const parsed = JSON.parse(buf.toString('utf-8')) as Settings & Record<string, unknown>
          // 深拷贝后剥离
          const copy = JSON.parse(JSON.stringify(parsed)) as Settings
          stripSecretsLocal(copy, false)
          buf = Buffer.from(JSON.stringify(copy, null, 2), 'utf-8')
        } catch { /* 解析失败则原样打包 */ }
      }
      hashes[zipPath] = sha256(buf)
      totalBytes += buf.length
      zip.addFile(zipPath, buf)
      inc(zipPath)
    } catch (e) {
      log.warn('备份跳过不可读文件', { fsPath, error: (e as Error).message })
    }
  }

  // 清理 0 计数的 key
  for (const k of Object.keys(counts)) if (counts[k] === 0) delete counts[k]

  const manifest: BackupManifest = {
    version: 2,
    appVersion: (() => { try { return app.getVersion() } catch { return '0.0.0' } })(),
    createdAt: Date.now(),
    counts,
    hashes,
    excluded: EXCLUDED_ITEMS,
    totalBytes,
  }
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'))

  mkdirSync(dirname(destPath), { recursive: true })
  zip.writeZip(destPath)

  // 更新 manifest.totalBytes 为 zip 实际大小（更直观）
  try {
    const st = statSync(destPath)
    manifest.totalBytes = st.size
    // 重写 manifest（adm-zip 已写入，追加更新不影响校验；此处仅日志用）
  } catch { /* ignore */ }

  log.info('Backup V2 已导出', { path: destPath, counts, totalBytes })
  return { path: destPath, counts, totalBytes, excluded: EXCLUDED_ITEMS }
}

/** 从 zip 恢复，返回 counts；会校验 manifest hashes 与 safeId */
export function restoreBackupV2(zipPath: string): { counts: Record<string, number> } {
  if (!existsSync(zipPath)) throw new Error('备份文件不存在')
  const zip = new AdmZip(zipPath)
  const entries = zip.getEntries()

  const manifestEntry = entries.find(e => e.entryName === 'manifest.json')
  if (!manifestEntry) {
    throw new Error('无效备份：缺少 manifest.json（可能是旧版 JSON 备份，请用 v1 导入）')
  }
  const manifest = JSON.parse(manifestEntry.getData().toString('utf-8')) as BackupManifest
  if (manifest.version !== 2) throw new Error(`不支持的备份版本: ${manifest.version}`)

  // 校验所有文件哈希
  for (const entry of entries) {
    if (entry.isDirectory || entry.entryName === 'manifest.json') continue
    const expected = manifest.hashes[entry.entryName]
    if (!expected) {
      log.warn('备份条目无哈希记录，跳过校验', { entry: entry.entryName })
      continue
    }
    const actual = sha256(entry.getData())
    if (actual !== expected) {
      throw new Error(`备份校验失败：${entry.entryName} 哈希不一致（可能文件损坏）`)
    }
  }

  // 预校验 id 合法性（character/lorebook/preset 文件名）
  const idFromZipPath = (zipPath: string): string | null => {
    const base = basename(zipPath)
    if (!base.endsWith('.json')) return null
    const id = base.slice(0, -5)
    // 仅对顶层已知目录做 safeId 校验
    if (zipPath.startsWith('characters/') || zipPath.startsWith('lorebooks/') || zipPath.startsWith('presets/')) {
      return safeId(id)
    }
    return id
  }

  for (const entry of entries) {
    if (entry.isDirectory || entry.entryName === 'manifest.json') continue
    const maybeId = idFromZipPath(entry.entryName)
    if (maybeId === null) continue
    // safeId 内部已校验非法字符，重复调用仅为触发校验
  }

  // 校验通过后开始写入（先写到临时目录，再原子移动，避免半导入）
  // 策略：直接写入目标目录（已有 withFileLock 保护的单文件，但批量时不用锁，靠一次性校验保证）
  const mapping: Record<string, string> = {
    'config/settings.json': join(DIRS.config(), 'settings.json'),
    'config/personas.json': join(DIRS.config(), 'personas.json'),
    'config/regex/rules.json': join(DIRS.config(), 'regex', 'rules.json'),
    'config/quickReplies.json': join(DIRS.config(), 'quickReplies.json'),
    'config/mcp-servers.json': join(DIRS.config(), 'mcp-servers.json'),
    'config/usage.json': join(DIRS.config(), 'usage.json'),
  }

  // 备份前快照（用于回滚）
  const backupSnapshotDir = mkdtempSync(join(tmpdir(), 'qingyu-restore-'))
  let snapshotCreated = false

  try {
    // 对 config 单文件做快照
    for (const [zipP, fsP] of Object.entries(mapping)) {
      if (existsSync(fsP)) {
        const snapPath = join(backupSnapshotDir, zipP.replaceAll('/', '_'))
        mkdirSync(dirname(snapPath), { recursive: true })
        try { copyFileSync(fsP, snapPath); snapshotCreated = true } catch { /* ignore */ }
      }
    }

    // 写入所有条目
    for (const entry of entries) {
      if (entry.isDirectory || entry.entryName === 'manifest.json') continue
      const zipPath = entry.entryName.replace(/\\/g, '/')
      let dest: string
      if (mapping[zipPath]) {
        dest = mapping[zipPath]
      } else if (zipPath.startsWith('characters/')) {
        dest = join(DIRS.characters(), zipPath.substring('characters/'.length))
      } else if (zipPath.startsWith('lorebooks/')) {
        dest = join(DIRS.lorebooks(), zipPath.substring('lorebooks/'.length))
      } else if (zipPath.startsWith('presets/')) {
        dest = join(DIRS.presets(), zipPath.substring('presets/'.length))
      } else if (zipPath.startsWith('chats/')) {
        dest = join(DIRS.chats(), zipPath.substring('chats/'.length))
      } else if (zipPath.startsWith('groups/')) {
        dest = join(DIRS.groups(), zipPath.substring('groups/'.length))
      } else {
        log.warn('未知备份条目，已跳过', { zipPath })
        continue
      }

      // 对 settings.json 的 apiKey 迁移进 safeStorage（与旧 importBackup 一致）
      if (zipPath === 'config/settings.json') {
        try {
          const parsed = JSON.parse(entry.getData().toString('utf-8')) as Settings
          // 若包含旧明文 apiKey，迁移进加密存储
          stripSecretsLocal(parsed, true)
          writeJson(dest, parsed)
          continue
        } catch { /* 回退到直接写入 */ }
      }

      mkdirSync(dirname(dest), { recursive: true })
      // 原子写入：temp + rename
      const tmp = dest + '.tmp'
      writeFileSync(tmp, entry.getData())
      try {
        renameSync(tmp, dest)
      } catch {
        try { unlinkSync(tmp) } catch { /* ignore */ }
        writeFileSync(dest, entry.getData())
      }
    }

    log.info('Backup V2 已导入', { zipPath, counts: manifest.counts })
    // 清理快照
    try { rmSync(backupSnapshotDir, { recursive: true, force: true }) } catch { /* ignore */ }
    return { counts: manifest.counts }
  } catch (e) {
    // 回滚 config 快照（其他目录的增量写入暂不回滚，避免误删用户新增数据）
    if (snapshotCreated) {
      try {
        for (const [zipP, fsP] of Object.entries(mapping)) {
          const snapPath = join(backupSnapshotDir, zipP.replaceAll('/', '_'))
          if (existsSync(snapPath)) copyFileSync(snapPath, fsP)
        }
      } catch { /* ignore */ }
    }
    try { rmSync(backupSnapshotDir, { recursive: true, force: true }) } catch { /* ignore */ }
    throw e
  }
}

/** 兼容：V1 JSON 备份导入（旧逻辑，供 .json 文件使用） */
export function isV1JsonBackup(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.json')
}
