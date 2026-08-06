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

export function registerSettingsIPC(ipcMain: IpcMain, dialog: Dialog): void {
  // 读取设置
  safeHandle(ipcMain, 'settings:get', async () => {
    return readJson<Settings>(SETTINGS_FILE(), 'settings') ?? getDefaultSettings()
  })

  // 保存设置
  safeHandle(ipcMain, 'settings:save', async (_e, settings: Settings) => {
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

    // 备份设置
    backup.settings = readJson(SETTINGS_FILE(), 'settings')

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

    if (backup.settings) {
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
