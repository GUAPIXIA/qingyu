import type { IpcMain, Dialog } from 'electron'
import { join } from 'node:path'
import { readdirSync, existsSync, writeFileSync, readFileSync, mkdirSync, statSync } from 'node:fs'
import { DIRS, writeJson, readJson, withFileLock } from '../services/storage'
import { getDefaultSettings } from '../../shared/defaults'
import { saveCredential, getCredential } from '../services/safeStorage'
import { createLogger } from '../services/logger'
import { safeHandle } from '../utils/safeHandle'
import { safeId } from '../utils/pathGuard'
import type { Settings } from '../../shared/types'
import { createBackupV2, restoreBackupV2 } from '../services/backup'

const log = createLogger('settings')

const SETTINGS_FILE = () => join(DIRS.config(), 'settings.json')

/** 备份文件大小上限：V1 100MB，V2 2GB（zip 压缩后，含媒体可能数 GB） */
const MAX_BACKUP_SIZE_V1 = 100 * 1024 * 1024
const MAX_BACKUP_SIZE_V2 = 2 * 1024 * 1024 * 1024

// ===================== H1 修复：API Key 加密存储 =====================
// settings.json 曾明文保存 apiKey（profile/TTS/生图/识图模型）。
// 现在保存时提取到 safeStorage 加密凭据库，settings.json 不落明文；
// 读取时回填；备份导出/导入时剥离。
type SecretItem = { id: string; apiKey?: string }
type SecretListGetter = (s: Settings) => SecretItem[] | undefined

const SECRET_COLLECTIONS: Array<{ get: SecretListGetter; prefix: string }> = [
  { get: (s) => s.connectionProfiles, prefix: 'profile' },
  { get: (s) => s.ttsModels, prefix: 'tts' },
  { get: (s) => s.imageGenModels, prefix: 'imagegen' },
  { get: (s) => s.visionModels, prefix: 'vision' },
]

/**
 * 保存前剥离 apiKey：提取到 safeStorage 后从 settings 对象删除。
 * @param persist 是否将明文 key 写入 safeStorage（保存/导入为 true；导出备份为 false，仅删除）
 */
export function stripSecrets(settings: Settings, persist: boolean): void {
  for (const { get, prefix } of SECRET_COLLECTIONS) {
    for (const item of get(settings) ?? []) {
      if (typeof item.apiKey === 'string' && item.apiKey.length > 0) {
        if (persist) {
          saveCredential(`${prefix}-${item.id}`, item.apiKey)
        }
      }
      delete item.apiKey
    }
  }
}

/** 读取后回填 safeStorage 中的凭据（无加密凭据时保留 settings 中旧明文兼容） */
export function restoreSecrets(settings: Settings): void {
  for (const { get, prefix } of SECRET_COLLECTIONS) {
    for (const item of get(settings) ?? []) {
      if (!item.apiKey) {
        const key = getCredential(`${prefix}-${item.id}`)
        if (key) item.apiKey = key
      }
    }
  }
}

export function registerSettingsIPC(ipcMain: IpcMain, dialog: Dialog): void {
  // 读取设置
  safeHandle(ipcMain, 'settings:get', async () => {
    const settings = readJson<Settings>(SETTINGS_FILE(), 'settings') ?? getDefaultSettings()
    // H1 修复：回填 safeStorage 中的加密凭据（settings.json 不再落明文 apiKey）
    restoreSecrets(settings)
    return settings
  })

  // 保存设置
  safeHandle(ipcMain, 'settings:save', async (_e, settings: Settings) => {
    // H1 修复：保存前剥离 apiKey 到 safeStorage（settings.json 不落明文）
    stripSecrets(settings, true)
    // BUG-20 修复：写操作经 per-file 锁串行化，避免多个保存请求并发时相互覆盖
    await withFileLock(SETTINGS_FILE(), () => {
      writeJson(SETTINGS_FILE(), settings, 'settings')
    })
    log.info('设置已保存', { activeProfileId: settings.activeProfileId || '(none)', theme: settings.theme })
  })

  // 保存凭据（加密）
  safeHandle(ipcMain, 'settings:saveCredential', async (_e, provider: string, key: string) => {
    saveCredential(provider, key)
    log.info('凭据已保存', { provider })
  })

  // 读取凭据
  safeHandle(ipcMain, 'settings:getCredential', async (_e, provider: string) => {
    return getCredential(provider)
  })

  // 导出备份 - S1 Backup V2：zip + manifest + 哈希校验；兼容 V1 json 兜底
  safeHandle(ipcMain, 'settings:exportBackup', async () => {
    const result = await dialog.showSaveDialog({
      title: '导出备份（Backup V2）',
      defaultPath: `qingyu-backup-v2-${Date.now()}.zip`,
      filters: [
        { name: 'ZIP 备份 (推荐)', extensions: ['zip'] },
        { name: 'JSON 备份 (旧版兼容)', extensions: ['json'] },
      ],
    })
    if (result.canceled || !result.filePath) return { status: 'canceled' as const }

    // 若用户选择 .json，仍走 V1 旧逻辑（兼容）
    if (result.filePath.toLowerCase().endsWith('.json')) {
      const backup: Record<string, unknown> = { version: 1, timestamp: Date.now() }
      const settings = readJson<Settings>(SETTINGS_FILE(), 'settings')
      if (settings) stripSecrets(settings, false)
      backup.settings = settings
      const charDir = DIRS.characters()
      if (existsSync(charDir)) {
        backup.characters = readdirSync(charDir).filter((f: string) => f.endsWith('.json')).map((f: string) => readJson(join(charDir, f)))
      }
      const loreDir = DIRS.lorebooks()
      if (existsSync(loreDir)) {
        backup.lorebooks = readdirSync(loreDir).filter((f: string) => f.endsWith('.json')).map((f: string) => readJson(join(loreDir, f)))
      }
      const presetDir = DIRS.presets()
      if (existsSync(presetDir)) {
        backup.presets = readdirSync(presetDir).filter((f: string) => f.endsWith('.json')).map((f: string) => readJson(join(presetDir, f)))
      }
      writeFileSync(result.filePath, JSON.stringify(backup, null, 2), 'utf-8')
      log.info('备份已导出 (V1 JSON)', { path: result.filePath })
      return { status: 'success' as const, path: result.filePath, version: 1 as const }
    }

    // V2 zip
    const zipPath = result.filePath.toLowerCase().endsWith('.zip') ? result.filePath : `${result.filePath}.zip`
    const { counts, totalBytes, excluded } = createBackupV2(zipPath)
    return { status: 'success' as const, path: zipPath, version: 2 as const, counts, totalBytes, excluded, manifest: { counts, totalBytes, excluded } }
  })

  // 导入备份 - S1 Backup V2：支持 .zip(V2) + .json(V1 兼容)；V2 含哈希校验与 safeId 校验
  safeHandle(ipcMain, 'settings:importBackup', async () => {
    const result = await dialog.showOpenDialog({
      title: '导入备份',
      filters: [
        { name: '备份文件', extensions: ['zip', 'json'] },
        { name: 'ZIP 备份', extensions: ['zip'] },
        { name: 'JSON 备份', extensions: ['json'] },
      ],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return { status: 'canceled' as const }

    const filePath = result.filePaths[0]
    const stat = statSync(filePath)
    const isZip = filePath.toLowerCase().endsWith('.zip')
    const limit = isZip ? MAX_BACKUP_SIZE_V2 : MAX_BACKUP_SIZE_V1
    if (stat.size > limit) {
      throw new Error(`备份文件过大（${(stat.size / 1024 / 1024).toFixed(1)}MB），上限 ${limit / 1024 / 1024}MB`)
    }

    if (isZip) {
      const { counts } = restoreBackupV2(filePath)
      return { status: 'success' as const, version: 2 as const, counts }
    }

    // V1 JSON 兼容路径
    const backup = JSON.parse(readFileSync(filePath, 'utf-8'))
    const safeIdList = (items: unknown[], label: string): { id: string; item: Record<string, unknown> }[] => {
      if (!Array.isArray(items)) return []
      return items.map((item) => {
        if (typeof item !== 'object' || item === null) {
          throw new Error(`备份文件格式错误：${label} 条目必须是对象`)
        }
        const obj = item as Record<string, unknown>
        return { id: safeId(obj.id), item: obj }
      })
    }
    const chars = safeIdList(backup.characters, '角色')
    const lorebooks = safeIdList(backup.lorebooks, '世界书')
    const presets = safeIdList(backup.presets, '预设')
    if (backup.settings && typeof backup.settings === 'object') {
      stripSecrets(backup.settings as Settings, true)
      writeJson(SETTINGS_FILE(), backup.settings)
    }
    if (chars.length > 0) {
      mkdirSync(DIRS.characters(), { recursive: true })
      for (const { id, item } of chars) writeJson(join(DIRS.characters(), `${id}.json`), item)
    }
    if (lorebooks.length > 0) {
      mkdirSync(DIRS.lorebooks(), { recursive: true })
      for (const { id, item } of lorebooks) writeJson(join(DIRS.lorebooks(), `${id}.json`), item)
    }
    if (presets.length > 0) {
      mkdirSync(DIRS.presets(), { recursive: true })
      for (const { id, item } of presets) writeJson(join(DIRS.presets(), `${id}.json`), item)
    }
    log.info('备份已导入 (V1 JSON)', { chars: chars.length, lorebooks: lorebooks.length, presets: presets.length })
    return { status: 'success' as const, version: 1 as const, counts: { characters: chars.length, lorebooks: lorebooks.length, presets: presets.length } }
  })
}
