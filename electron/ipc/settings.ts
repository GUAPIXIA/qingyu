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

const log = createLogger('settings')

const SETTINGS_FILE = () => join(DIRS.config(), 'settings.json')

/** 备份文件大小上限：100MB（N23 修复） */
const MAX_BACKUP_SIZE = 100 * 1024 * 1024

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

  // 导出备份
  safeHandle(ipcMain, 'settings:exportBackup', async () => {
    const result = await dialog.showSaveDialog({
      title: '导出备份',
      defaultPath: `qingyu-backup-${Date.now()}.json`,
      filters: [{ name: 'JSON 备份', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return

    const backup: Record<string, unknown> = { version: 1, timestamp: Date.now() }

    // 备份设置（H1 修复：导出剥离 apiKey，备份文件不携带凭据）
    const settings = readJson<Settings>(SETTINGS_FILE(), 'settings')
    if (settings) {
      stripSecrets(settings, false)
    }
    backup.settings = settings

    // 备份角色
    const charDir = DIRS.characters()
    if (existsSync(charDir)) {
      backup.characters = readdirSync(charDir)
        .filter((f: string) => f.endsWith('.json'))
        .map((f: string) => readJson(join(charDir, f)))
    }

    // 备份世界书
    const loreDir = DIRS.lorebooks()
    if (existsSync(loreDir)) {
      backup.lorebooks = readdirSync(loreDir)
        .filter((f: string) => f.endsWith('.json'))
        .map((f: string) => readJson(join(loreDir, f)))
    }

    // 备份预设
    const presetDir = DIRS.presets()
    if (existsSync(presetDir)) {
      backup.presets = readdirSync(presetDir)
        .filter((f: string) => f.endsWith('.json'))
        .map((f: string) => readJson(join(presetDir, f)))
    }

    writeFileSync(result.filePath, JSON.stringify(backup, null, 2), 'utf-8')
    log.info('备份已导出', { path: result.filePath, chars: (backup.characters as unknown[])?.length ?? 0, lorebooks: (backup.lorebooks as unknown[])?.length ?? 0 })
  })

  // 导入备份
  safeHandle(ipcMain, 'settings:importBackup', async () => {
    const result = await dialog.showOpenDialog({
      title: '导入备份',
      filters: [{ name: 'JSON 备份', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return

    // N23 修复：备份文件大小上限 100MB，防超大文件撑爆内存
    const stat = statSync(result.filePaths[0])
    if (stat.size > MAX_BACKUP_SIZE) {
      throw new Error(`备份文件过大（${(stat.size / 1024 / 1024).toFixed(1)}MB），上限 ${MAX_BACKUP_SIZE / 1024 / 1024}MB`)
    }

    const backup = JSON.parse(readFileSync(result.filePaths[0], 'utf-8'))

    // NEW-H1 修复：写入前先校验所有 id，防止恶意备份中的路径遍历字符写入任意位置；
    // 校验全部通过后才开始写入（NEW-M6 的部分原子性：非法数据不会留下半导入状态）
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
      // H1 修复：导入的 settings 若含明文 apiKey（旧备份），迁移进 safeStorage 后剥离落盘
      stripSecrets(backup.settings as Settings, true)
      writeJson(SETTINGS_FILE(), backup.settings)
    }
    if (chars.length > 0) {
      mkdirSync(DIRS.characters(), { recursive: true })
      for (const { id, item } of chars) {
        writeJson(join(DIRS.characters(), `${id}.json`), item)
      }
    }
    if (lorebooks.length > 0) {
      mkdirSync(DIRS.lorebooks(), { recursive: true })
      for (const { id, item } of lorebooks) {
        writeJson(join(DIRS.lorebooks(), `${id}.json`), item)
      }
    }
    if (presets.length > 0) {
      mkdirSync(DIRS.presets(), { recursive: true })
      for (const { id, item } of presets) {
        writeJson(join(DIRS.presets(), `${id}.json`), item)
      }
    }
    log.info('备份已导入', { chars: chars.length, lorebooks: lorebooks.length, presets: presets.length })
  })
}
